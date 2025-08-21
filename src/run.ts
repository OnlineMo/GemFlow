import {
  CreateLibraryAOptions,
  LibraryA,
  RunInput,
  RunOptions,
  RunResult,
  StreamChunk,
  ToolDefinition,
  MemoryAdapter,
  MemoryConfig,
  GraphState,
  EventPayload,
} from "./core/types";
import { resolveModelParams } from "./core/env";
import { createDefaultLogger } from "./core/logger";
import { createEventBus } from "./core/eventBus";
import { InMemoryMemory } from "./core/memory/inmemory";
import { SimpleCache } from "./core/cache";
import { buildReasoningGraph } from "./graph/graph";
import {
  createChatModel,
  toLCMessages,
  bindToolsToModel,
  invokeWithStructuredOutput,
  invokeText,
  streamText,
} from "./model/gemini";
import { buildLCTools, executeToolCalls } from "./core/tools";
import { genRunId, nowMs, withTimeout, sleep } from "./core/utils";
import type { BaseMessage } from "@langchain/core/messages";

/**
 * 合并模型参数（深合并三层：根 + retries + timeouts + rateLimit）
 */
function mergeParams<T extends object>(base: any, overrides?: Partial<T>): any {
  if (!overrides) return base;
  return {
    ...base,
    ...overrides,
    retries: { ...(base.retries ?? {}), ...(overrides as any)?.retries },
    timeouts: { ...(base.timeouts ?? {}), ...(overrides as any)?.timeouts },
    rateLimit: { ...(base.rateLimit ?? {}), ...(overrides as any)?.rateLimit },
  };
}

function pickMemory(config?: MemoryConfig): MemoryAdapter {
  if (config?.kind === "custom" && config.adapter) return config.adapter;
  return new InMemoryMemory();
}

function shouldCollectEvents() {
  const v =
    process.env.LIBRARYA_EVENTS ??
    process.env.LIBRARY_A_EVENTS ??
    process.env.DEBUG;
  return !!v && ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

/**
 * 创建库 A（对外 API）
 */
export function createLibraryA(opts: CreateLibraryAOptions): LibraryA {
  const baseParams = resolveModelParams(opts);
  const logger = opts.logger ?? createDefaultLogger(!!process.env.DEBUG);
  const eventBus = createEventBus(logger);
  const memory = pickMemory(opts.memory);
  const cacheCfg = opts.cache ?? { ttlMs: 60_000, max: 500, enabled: true };
  const promptCache = new SimpleCache<any>(cacheCfg, logger);
  const responseCache = new SimpleCache<any>(cacheCfg, logger);
  const tools: ToolDefinition[] = opts.tools ?? [];
  const defaultMaxSteps = opts.maxSteps ?? 6;

  return {
    /**
     * 收敛式调用（同步返回最终结果）
     */
    async run(input: RunInput, options?: RunOptions): Promise<RunResult> {
      const startedAt = nowMs();
      const runId = genRunId();

      const params = mergeParams(baseParams, options?.overrides);
      const maxSteps = options?.maxSteps ?? defaultMaxSteps;

      const collectEvents = shouldCollectEvents();
      const events: EventPayload[] = [];
      const off = eventBus.on((e) => {
        if (collectEvents) events.push(e);
      });

      // 为本次 run 构建上下文与图
      const ctx = {
        params,
        tools,
        memory,
        eventBus,
        logger,
        promptCache,
        responseCache,
        limiter: {
          rpm: params.rateLimit?.rpm,
          minIntervalMs: params.rateLimit?.rpm
            ? Math.ceil(60_000 / (params.rateLimit?.rpm ?? 1))
            : undefined,
          lastAt: undefined as number | undefined,
        },
        signal: options?.signal,
      } as any;

      eventBus.emit({
        runId,
        kind: "run:start",
        timestamp: nowMs(),
        data: { model: params.model, maxSteps },
      });
      const graph = buildReasoningGraph(ctx);
      const initialState: GraphState = {
        runId,
        input,
        params,
        step: 0,
        maxSteps,
        startedAt,
        usedTools: [],
        errors: [],
      } as GraphState;

      let final: GraphState;
      try {
        final = await withTimeout(
          graph.invoke(initialState),
          params.timeouts?.totalMs,
          options?.signal
        );
      } finally {
        off();
      }

      const durationMs = nowMs() - startedAt;
      const meta = {
        steps: final.step ?? maxSteps,
        durationMs,
        model: params.model,
        usedTools: Array.from(new Set(final.usedTools ?? [])),
        cacheHit: !!final.cacheHit,
        events: collectEvents ? events : undefined,
      };

      // 若验证阶段产出了结构化对象则优先返回 object，否则返回文本
      const res: RunResult = {
        text: final.finalObject ? undefined : final.candidateAnswer ?? "",
        object: final.finalObject,
        meta,
      };
      eventBus.emit({
        runId,
        kind: "run:end",
        timestamp: nowMs(),
        data: meta as any,
      });
      return res;
    },

    /**
     * 流式调用（渐进输出最终文本增量；结束时输出 end 事件携带 meta）
     * 说明：
     * - 为保证体验，流式仅对“候选答案汇总”阶段进行流式输出；
     * - 规划与工具调用仍为非流式（但速度较快），随后开始输出文本增量；
     * - 当请求结构化输出（schema/Zod）时，将不进行文本流式，而在结束时直接给出 end 元数据。
     */
    async *stream(
      input: RunInput,
      options?: RunOptions
    ): AsyncGenerator<StreamChunk, void, unknown> {
      const startedAt = nowMs();
      const runId = genRunId();

      const params = mergeParams(baseParams, options?.overrides);
      const maxSteps = options?.maxSteps ?? defaultMaxSteps;

      const collectEvents = shouldCollectEvents();
      const events: EventPayload[] = [];
      const off = eventBus.on((e) => {
        if (collectEvents) events.push(e);
      });

      // 上下文（与 run 基本一致）
      const ctx = {
        params,
        tools,
        memory,
        eventBus,
        logger,
        promptCache,
        responseCache,
        limiter: {
          rpm: params.rateLimit?.rpm,
          minIntervalMs: params.rateLimit?.rpm
            ? Math.ceil(60_000 / (params.rateLimit?.rpm ?? 1))
            : undefined,
          lastAt: undefined as number | undefined,
        },
        signal: options?.signal,
      } as any;

      eventBus.emit({
        runId,
        kind: "run:start",
        timestamp: nowMs(),
        data: { model: params.model, maxSteps },
      });
      // 1) 规划（非流式）
      const systemPlan = [
        "你是一个面向服务端的深度思考与工具编排代理。",
        "工作模式：规划 → 行动/工具 → 反思 → 验证 → 收敛。",
        "禁止泄露内部推理链或反思原文。只输出对用户有用的内容。",
      ].join("\n");
      const planMsgs: BaseMessage[] = [
        ...toLCMessages(systemPlan, await memory.getHistory(runId)),
      ];
      const task =
        typeof input === "string" ? input : (input.task ?? "");
      planMsgs.push(
        {
          _getType: () => "human",
          content:
            [
              "任务理解与规划：",
              "- 将任务拆解为步骤，并列出可能需要的工具与参数字段。",
              "- 使用简短项目符号，不泄露内部思考。",
              `用户任务: ${task}`,
            ].join("\n"),
        } as any
      );

      const planModel = createChatModel(params);
      const planAI = await invokeText({ model: planModel, messages: planMsgs });
      const planText =
        (planAI?.content as any)?.toString?.() ??
        String(planAI?.content ?? "");
      await memory.append(runId, [
        { role: "user", content: task },
        { role: "assistant", content: planText },
      ]);

      // 2) 行动/工具（非流式决策 + 执行）
      const lcTools = buildLCTools(tools, logger);
      const toolModel = bindToolsToModel(createChatModel(params), lcTools);
      const systemAct = [
        "你可以使用提供的工具完成检索/执行。",
        "仅在需要时调用工具，然后基于工具结果生成候选答案。",
        "不要泄露内部思考或链路，仅输出任务相关内容。",
      ].join("\n");

      const actMsgs: BaseMessage[] = [
        ...toLCMessages(systemAct, await memory.getHistory(runId)),
      ];
      const aiDecide = await toolModel.invoke(actMsgs);
      const toolMessages = await executeToolCalls({
        aiMessage: aiDecide as any,
        tools,
        ctx: { logger, signal: options?.signal },
        logger,
      });
      if (toolMessages.length > 0) {
        await memory.append(runId, toolMessages);
      }

      // 若请求结构化输出，则直接以结构化方式生成，不进行文本流
      const schema = typeof input === "string" ? undefined : input.schema;
      if (schema) {
        const systemValidate = [
          "依据给定的 JSON Schema/Zod 结构，输出严格符合该结构的对象。",
          "不要解释，仅输出对象。",
        ].join("\n");
        const validateMsgs: BaseMessage[] = [
          ...toLCMessages(systemValidate, await memory.getHistory(runId)),
          { _getType: () => "human", content: "请输出结构化对象（符合 schema）。" } as any,
        ];
        const model = createChatModel(params);
        const { object } = await invokeWithStructuredOutput({
          model,
          messages: validateMsgs,
          schema,
          logger,
        });
        // 结束事件（仅 meta）
        const durationMs = nowMs() - startedAt;
        const meta = {
          steps: Math.min(maxSteps, 3),
          durationMs,
          model: params.model,
          usedTools: toolMessages.map((m) => m.name!).filter(Boolean) as string[],
          cacheHit: false,
          events: collectEvents ? events : undefined,
        };
        eventBus.emit({
          runId,
          kind: "run:end",
          timestamp: nowMs(),
          data: meta as any,
        });
        yield { event: "end", meta };
        off();
        return;
      }

      // 3) 候选答案汇总（流式文本）
      const systemSummarize = [
        "基于已有对话与工具结果，给出高质量的最终答案。",
        "不泄露内部思考与反思，仅输出对用户有用的内容。",
      ].join("\n");
      const sumMsgs: BaseMessage[] = [
        ...toLCMessages(systemSummarize, await memory.getHistory(runId)),
      ];
      const sumModel = createChatModel(params);

      let fullText = "";
      for await (const delta of streamText({
        model: sumModel,
        messages: sumMsgs,
        logger,
      })) {
        if (options?.signal?.aborted) {
          break;
        }
        fullText += delta;
        yield { delta };
      }
      await memory.append(runId, [{ role: "assistant", content: fullText }]);

      // 4) 结束事件（携带 meta）
      const durationMs = nowMs() - startedAt;
      const meta = {
        steps: Math.min(maxSteps, 4),
        durationMs,
        model: params.model,
        usedTools: toolMessages.map((m) => m.name!).filter(Boolean) as string[],
        cacheHit: false,
        events: collectEvents ? events : undefined,
      };
      eventBus.emit({
        runId,
        kind: "run:end",
        timestamp: nowMs(),
        data: meta as any,
      });
      yield { event: "end", meta };
      off();
    },
    /**
     * 订阅内部可观测性事件（节点进入/退出、工具调用、重试、缓存等）
     * 返回取消订阅函数
     */
    onEvent(handler: (e: EventPayload) => void) {
      return eventBus.on(handler);
    }
  };
}