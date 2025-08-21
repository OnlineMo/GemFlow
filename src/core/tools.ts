import { z, ZodTypeAny } from "zod";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import { DynamicStructuredTool as LCDynamicStructuredTool } from "@langchain/core/tools";
import type { AIMessage } from "@langchain/core/messages";
import { ToolMessage } from "@langchain/core/messages";
import type {
  LoggerLike,
  ToolDefinition,
  ToolExecutionContext,
  MemoryMessage,
} from "./types";

/**
 * 将自定义 ToolDefinition 适配为 LangChain DynamicStructuredTool
 * - 仅用于将工具 schema/描述/名称暴露给模型（Gemini 函数调用）
 * - 实际执行仍由我们在工具节点中显式调用（以便可观测与重试）
 */
export function toLCDynamicTool(def: ToolDefinition, logger?: LoggerLike): DynamicStructuredTool {
  const schema = ensureZod(def.schema);
  return new LCDynamicStructuredTool({
    name: def.name,
    description: def.description,
    schema,
    // 这里的实际执行函数不用于主路径（我们在图中手动执行）
    // 但为了兼容模型自行“内联调用”的情形，仍提供一个安全兜底实现
    func: async (input: unknown) => {
      try {
        const parsed = schema.parse(input);
        const res = await def.execute(parsed, { logger });
        return JSON.stringify(res);
      } catch (e: any) {
        logger?.warn?.(`[tool:${def.name}] 内联执行失败，返回错误文本`, e?.message ?? e);
        return JSON.stringify({ error: String(e?.message ?? e) });
      }
    },
  });
}

/**
 * 执行模型返回的 tool_calls
 * - 读取 AIMessage 中的 tool_calls（LangChain 统一字段）
 * - 对每个 call 逐一执行并返回 ToolMessage 列表（供追加到对话历史）
 */
export async function executeToolCalls(params: {
  aiMessage: AIMessage;
  tools: ToolDefinition[];
  ctx: ToolExecutionContext;
  logger?: LoggerLike;
}): Promise<MemoryMessage[]> {
  const { aiMessage, tools, ctx, logger } = params;
  const calls = (aiMessage as any).tool_calls as Array<any> | undefined;
  if (!calls?.length) return [];

  const toolMap = new Map<string, ToolDefinition>();
  for (const t of tools) {
    if (t.enabled === false || t.hidden) continue;
    toolMap.set(t.name, t);
  }

  const outputs: MemoryMessage[] = [];

  for (const call of calls) {
    const toolName: string = call?.name ?? call?.tool ?? "";
    const args = call?.args ?? {};
    const def = toolMap.get(toolName);
    if (!def) {
      const err = `未注册的工具: ${toolName}`;
      logger?.warn?.("[tools] 未注册的工具被调用", { toolName, args });
      outputs.push({
        role: "tool",
        name: toolName,
        content: JSON.stringify({ error: err }),
      });
      continue;
    }

    try {
      const parsed = ensureZod(def.schema).parse(args);
      const result = await def.execute(parsed, ctx);
      const text = safeJSONStringify(result);
      outputs.push({
        role: "tool",
        name: toolName,
        content: text,
      });
    } catch (e: any) {
      logger?.warn?.(`[tools] 执行失败: ${toolName}`, e?.message ?? e);
      outputs.push({
        role: "tool",
        name: toolName,
        content: JSON.stringify({ error: String(e?.message ?? e) }),
      });
    }
  }

  return outputs;
}

/**
 * 从 ToolDefinition 列表生成 LangChain 工具数组
 */
export function buildLCTools(tools: ToolDefinition[], logger?: LoggerLike): DynamicStructuredTool[] {
  return tools
    .filter((t) => t.enabled !== false && !t.hidden)
    .map((t) => toLCDynamicTool(t, logger));
}

function ensureZod(schema: ZodTypeAny | any): ZodTypeAny {
  if (typeof (schema as any)?._def === "object") return schema as ZodTypeAny;
  // 若传入 JSON Schema，则退化为“任意对象”以接受参数；更严格的校验交由工具内部处理
  return z.any();
}

function safeJSONStringify(v: unknown) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}