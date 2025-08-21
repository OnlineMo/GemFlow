import { StateGraph, START, END } from "@langchain/langgraph";
import type { BaseMessage, AIMessage } from "@langchain/core/messages";
import {
  HumanMessage,
  SystemMessage,
  AIMessage as LCAIMessage,
} from "@langchain/core/messages";
import {
  CreateLibraryAOptions,
  EventBus,
  GraphState,
  LoggerLike,
  MemoryAdapter,
  ModelParams,
  RunInput,
  ToolDefinition,
} from "../core/types";
import { createChatModel, toLCMessages, bindToolsToModel, invokeText, invokeWithStructuredOutput } from "../model/gemini";
import { buildLCTools, executeToolCalls } from "../core/tools";
import { InMemoryMemory } from "../core/memory/inmemory";
import { SimpleCache, makeCacheKey } from "../core/cache";
import { createEventBus } from "../core/eventBus";
import { createDefaultLogger } from "../core/logger";
import { resolveModelParams } from "../core/env";
import { genRunId, nowMs, sleep, withTimeout } from "../core/utils";
import type { ZodTypeAny } from "zod";

/**
 * Orchestrator 上下文
 */
export interface OrchestratorContext {
  params: ModelParams;
  tools: ToolDefinition[];
  memory: MemoryAdapter;
  eventBus: EventBus;
  logger: LoggerLike;
  promptCache: SimpleCache<any>;
  responseCache: SimpleCache<any>;
  limiter: {
    rpm?: number;
    minIntervalMs?: number;
    lastAt?: number;
  };
  signal?: AbortSignal;
}

/**
 * 构造 LangGraph 有向图
 * - 节点：plan -> act -> reflect -> validate -> converge
 * - 循环：act/reflect 直到达到步数或校验通过
 */
export function buildReasoningGraph(ctx: OrchestratorContext) {
  const last = <T>(a: T, b: T) => (b === undefined ? a : b);
  const concat = <T>(a: T[] = [], b: T[] = []) => [...a, ...b];

  const graph = new StateGraph<GraphState>({
    channels: {
      runId: { value: last, default: () => "" },
      input: { value: last, default: () => "" as unknown as RunInput },
      params: { value: last, default: () => ctx.params },
      step: { value: last, default: () => 0 },
      maxSteps: { value: last, default: () => 6 },
      plan: { value: last, default: () => undefined },
      thoughts: { value: last, default: () => undefined },
      actions: { value: concat, default: () => [] },
      toolResults: { value: concat, default: () => [] },
      candidateAnswer: { value: last, default: () => undefined },
      structuredSchemaJson: { value: last, default: () => undefined },
      isValid: { value: last, default: () => undefined },
      finalAnswer: { value: last, default: () => undefined },
      finalObject: { value: last, default: () => undefined },
      startedAt: { value: last, default: () => nowMs() },
      endedAt: { value: last, default: () => undefined },
      cacheHit: { value: last, default: () => false },
      usedTools: { value: concat, default: () => [] as string[] },
      errors: { value: concat, default: () => [] as any[] },
    },
  });

  graph.addNode("plan", async (state) => {
    await beforeNode("plan", ctx, state);
    const system = buildSystemPrompt(ctx.params.systemPrompt);
    const task = normalizeTask(state.input);
    const messages: BaseMessage[] = [
      ...toLCMessages(system, await ctx.memory.getHistory(state.runId)),
      new HumanMessage(
        [
          "任务理解与规划：",
          "- 你需要将用户任务拆解为有序的可执行步骤，并指出可能用到的工具名称与调用参数字段。",
          "- 输出不泄露内部思考，用简短项目符号列出步骤。",
          `用户任务: ${task}`,
        ].join("\n")
      ),
    ];

    const { ai, fromCache } = await callModelText(ctx, messages, state, {
      cacheTag: "plan",
    });
    const plan = (ai?.content as any)?.toString?.() ?? String(ai?.content ?? "");
    await ctx.memory.append(state.runId, [
      { role: "user", content: task },
      { role: "assistant", content: plan },
    ]);

    await afterNode("plan", ctx, state, { plan, fromCache });
    return {
      plan,
      cacheHit: state.cacheHit || fromCache,
    };
  });

  graph.addNode("act", async (state) => {
    await beforeNode("act", ctx, state);

    const lcTools = buildLCTools(ctx.tools, ctx.logger);
    const model = bindToolsToModel(createChatModel(ctx.params), lcTools);

    // 让模型决定是否调用工具
    const system = buildSystemPrompt(
      [
        ctx.params.systemPrompt ?? "",
        "你可以使用提供的工具完成检索/执行。",
        "仅在需要时调用工具，然后基于工具结果生成候选答案。",
        "不要泄露内部思考或链路，仅输出任务相关内容。",
      ].join("\n")
    );

    const historyMsgs = toLCMessages(system, await ctx.memory.getHistory(state.runId));
    const invoke1 = await callModelTextRaw(ctx, model, historyMsgs, state, { cacheTag: "act.decide" });
    const ai1 = invoke1.ai;
    const toolMessages = await executeToolCalls({
      aiMessage: ai1 as any,
      tools: ctx.tools,
      ctx: { logger: ctx.logger, signal: ctx.signal },
      logger: ctx.logger,
    });

    let usedTools: string[] = [];
    if (toolMessages.length > 0) {
      usedTools = toolMessages.map((m) => m.name!).filter(Boolean) as string[];
      await ctx.memory.append(state.runId, toolMessages);
    }

    // 二次调用：基于工具结果汇总候选答案
    const historyMsgs2 = toLCMessages(system, await ctx.memory.getHistory(state.runId));
    const { ai, fromCache } = await callModelText(ctx, historyMsgs2, state, { cacheTag: "act.summarize" });
    const candidate = (ai?.content as any)?.toString?.() ?? String(ai?.content ?? "");

    await ctx.memory.append(state.runId, [{ role: "assistant", content: candidate }]);

    await afterNode("act", ctx, state, {
      toolCalls: (ai1 as any)?.tool_calls ?? [],
      usedTools,
      candidate,
    });
    return {
      candidateAnswer: candidate,
      usedTools,
      step: state.step + 1,
      cacheHit: state.cacheHit || fromCache,
    };
  });

  graph.addNode("reflect", async (state) => {
    await beforeNode("reflect", ctx, state);
    const system = buildSystemPrompt(
      [
        ctx.params.systemPrompt ?? "",
        "你是批判性思维助手。你将对候选答案进行自检与改进建议。",
        "只输出改进建议要点，不要重复答案，不要泄露思考链。",
      ].join("\n")
    );
    const messages: BaseMessage[] = [
      ...toLCMessages(system, await ctx.memory.getHistory(state.runId)),
      new HumanMessage(
        [
          "请对上一步候选答案做自检与改进建议：",
          "- 覆盖准确性、完整性、可执行性、风险与来源可靠性。",
          "- 如果已足够好，请输出“OK”。",
        ].join("\n")
      ),
    ];
    const { ai, fromCache } = await callModelText(ctx, messages, state, { cacheTag: "reflect" });
    const thoughts = (ai?.content as any)?.toString?.() ?? String(ai?.content ?? "");

    await afterNode("reflect", ctx, state, { thoughts });
    return { thoughts, cacheHit: state.cacheHit || fromCache };
  });

  graph.addNode("validate", async (state) => {
    await beforeNode("validate", ctx, state);
    let isValid = true;
    let finalObject: any | undefined = undefined;

    const schema = extractSchemaFromInput(state.input);
    if (schema) {
      // 结构化输出校验
      const system = buildSystemPrompt(
        [
          ctx.params.systemPrompt ?? "",
          "依据给定的 JSON Schema/Zod 结构，输出严格符合该结构的对象。",
          "不要解释，仅输出对象。",
        ].join("\n")
      );
      const messages: BaseMessage[] = [
        ...toLCMessages(system, await ctx.memory.getHistory(state.runId)),
        new HumanMessage("请输出结构化对象（符合 schema）。"),
      ];
      const model = createChatModel(ctx.params);
      const { object } = await invokeWithStructuredOutput({
        model,
        messages,
        schema,
        logger: ctx.logger,
      });
      finalObject = object;
      isValid = true;
    } else {
      // 文本基本检查（最小可行）
      isValid = Boolean(state.candidateAnswer && state.candidateAnswer.trim().length > 0);
    }

    await afterNode("validate", ctx, state, { isValid, hasObject: Boolean(finalObject) });
    return { isValid, finalObject };
  });

  graph.addNode("converge", async (state) => {
    await beforeNode("converge", ctx, state);
    const endedAt = nowMs();
    await afterNode("converge", ctx, state, { endedAt });
    return { endedAt };
  });

  // 边与条件
  graph.addEdge(START, "plan");
  graph.addEdge("plan", "act");
  graph.addConditionalEdges("act", (state) => {
    if (state.step >= state.maxSteps) return "validate";
    return "reflect";
  }, {
    reflect: "reflect",
    validate: "validate",
  });
  graph.addConditionalEdges("reflect", (state) => {
    if (state.step >= state.maxSteps - 1) return "validate";
    return "act";
  }, {
    act: "act",
    validate: "validate",
  });
  graph.addConditionalEdges("validate", (state) => {
    if (state.isValid) return "converge";
    if (state.step >= state.maxSteps) return "converge";
    return "act";
  }, {
    converge: "converge",
    act: "act",
  });
  graph.addEdge("converge", END);

  return graph.compile();
}

/**
 * —— 辅助：模型调用（统一缓存/速率/超时/重试/事件） ——
 */
async function callModelText(
  ctx: OrchestratorContext,
  messages: BaseMessage[],
  state: GraphState,
  meta?: { cacheTag?: string }
): Promise<{ ai: AIMessage; fromCache: boolean }> {
  const model = createChatModel(ctx.params);
  return callModelTextRaw(ctx, model, messages, state, meta);
}

async function callModelTextRaw(
  ctx: OrchestratorContext,
  model: ReturnType<typeof createChatModel>,
  messages: BaseMessage[],
  state: GraphState,
  meta?: { cacheTag?: string }
): Promise<{ ai: AIMessage; fromCache: boolean }> {
  const cacheKey = makeCacheKey({
    tag: meta?.cacheTag ?? "text",
    model: ctx.params.model,
    temperature: ctx.params.temperature,
    messages: messages.map((m) => ({
      _type: m._getType?.(),
      content: (m as any).content,
      name: (m as any).name,
    })),
  });

  const cached = ctx.responseCache.get(cacheKey) as AIMessage | undefined;
  if (cached) {
    ctx.eventBus.emit({
      runId: state.runId,
      kind: "cache:hit",
      timestamp: nowMs(),
      data: { key: cacheKey },
    });
    return { ai: cached, fromCache: true };
  }

  await ensureRateLimit(ctx, state);
  const perStepMs = ctx.params.timeouts?.perStepMs;
  const ai = await retryAsync(
    () => withTimeout(invokeText({ model, messages }), perStepMs, ctx.signal),
    ctx,
    state
  );

  ctx.responseCache.set(cacheKey, ai);
  ctx.eventBus.emit({
    runId: state.runId,
    kind: "model:call:end",
    timestamp: nowMs(),
    data: { node: "model.invoke", cached: false },
  });

  return { ai, fromCache: false };
}

async function ensureRateLimit(ctx: OrchestratorContext, state: GraphState) {
  if (!ctx.params.rateLimit?.enabled) return;
  const rpm = ctx.params.rateLimit?.rpm;
  if (!rpm || rpm <= 0) return;

  const minIntervalMs = Math.ceil(60_000 / rpm);
  const now = nowMs();
  const last = ctx.limiter.lastAt ?? 0;
  const wait = Math.max(0, minIntervalMs - (now - last));
  if (wait > 0) {
    ctx.eventBus.emit({
      runId: state.runId,
      kind: "ratelimit:delay",
      timestamp: nowMs(),
      data: { waitMs: wait },
    });
    await sleep(wait);
  }
  ctx.limiter.lastAt = nowMs();
}

async function retryAsync<T>(
  fn: () => Promise<T>,
  ctx: OrchestratorContext,
  state: GraphState
): Promise<T> {
  const { retries } = ctx.params;
  const max = retries?.max ?? 3;
  const initial = retries?.initialDelayMs ?? 500;
  const factor = retries?.factor ?? 2;
  const maxDelay = retries?.maxDelayMs ?? 10_000;

  let attempt = 0;
  let delay = initial;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (e: any) {
      attempt++;
      if (attempt >= max) throw e;
      ctx.eventBus.emit({
        runId: state.runId,
        kind: "retry",
        timestamp: nowMs(),
        data: { attempt, error: e?.message ?? String(e) },
      });
      await sleep(Math.min(delay, maxDelay));
      delay *= factor;
    }
  }
}

/**
 * —— 辅助：节点进入/退出事件 ——
 */
async function beforeNode(name: string, ctx: OrchestratorContext, state: GraphState) {
  ctx.eventBus.emit({
    runId: state.runId,
    kind: "node:enter",
    timestamp: nowMs(),
    data: { node: name, step: state.step },
  });
}
async function afterNode(name: string, ctx: OrchestratorContext, state: GraphState, data?: any) {
  ctx.eventBus.emit({
    runId: state.runId,
    kind: "node:exit",
    timestamp: nowMs(),
    data: { node: name, step: state.step, ...(data ?? {}) },
  });
}

/**
 * —— 辅助：系统提示/任务提取/Schema 提取 ——
 */
function buildSystemPrompt(base?: string) {
  return [
    "你是一个面向服务端的深度思考与工具编排代理。",
    "工作模式：规划 → 行动/工具 → 反思 → 验证 → 收敛。",
    "禁止泄露内部推理链或反思原文。只输出对用户有用的内容。",
    base ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

function normalizeTask(input: RunInput): string {
  if (typeof input === "string") return input;
  return input.task ?? "";
}

function extractSchemaFromInput(input: RunInput): ZodTypeAny | any | undefined {
  if (typeof input === "string") return undefined;
  return input.schema;
}