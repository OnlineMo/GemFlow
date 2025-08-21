import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import type {
  BaseMessage,
  AIMessage,
} from "@langchain/core/messages";
import {
  HumanMessage,
  SystemMessage,
  AIMessage as LCAIMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { Runnable } from "@langchain/core/runnables";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import type {
  LoggerLike,
  ModelParams,
  ToolDefinition,
} from "../core/types";
import type { DynamicStructuredTool } from "@langchain/core/tools";

/**
 * 构建 Gemini 聊天模型（Google AI Studio）
 * 仅使用 Google 官方通道，不使用 Vertex / OpenAI
 */
export function createChatModel(params: ModelParams) {
  const model = new ChatGoogleGenerativeAI({
    apiKey: params.apiKey,
    model: params.model,
    temperature: params.temperature,
    topK: params.topK,
    topP: params.topP,
    maxOutputTokens: params.maxTokens,
    // 注意：safetySettings 等高级配置可在此扩展
  });

  return model;
}

/**
 * 将内存消息适配为 LangChain 消息
 */
export function toLCMessages(
  systemPrompt: string | undefined,
  history: Array<{ role: string; content: string; name?: string }>
): BaseMessage[] {
  const msgs: BaseMessage[] = [];
  if (systemPrompt && systemPrompt.trim().length > 0) {
    msgs.push(new SystemMessage(systemPrompt));
  }
  for (const m of history) {
    switch (m.role) {
      case "user":
        msgs.push(new HumanMessage(m.content));
        break;
      case "assistant":
        msgs.push(new LCAIMessage(m.content));
        break;
      case "tool":
        msgs.push(
          new ToolMessage({
            content: m.content,
            tool_call_id: m.name ?? "tool",
            name: m.name,
          })
        );
        break;
      case "system":
        msgs.push(new SystemMessage(m.content));
        break;
      default:
        msgs.push(new HumanMessage(m.content));
    }
  }
  return msgs;
}

/**
 * 将 ToolDefinition 转为 Gemini 的 function 声明（经由 LangChain 绑定）
 * - 这里不直接构造原生 Google SDK 的 function_declarations
 * - 通过 langchain 的 bindTools 机制交由模型执行函数调用
 */
export function bindToolsToModel(
  model: ChatGoogleGenerativeAI,
  lcTools: DynamicStructuredTool[]
) {
  // ChatModel 基类支持 bindTools，将工具注册到模型上下文
  // LangChain 会根据模型返回的 tool_calls 自动解析
  return model.bindTools(lcTools as any);
}

/**
 * 使用结构化输出（Zod/JSON Schema）进行模型调用（非流式）
 * - 返回对象（模型已按 schema 约束解析）
 */
export async function invokeWithStructuredOutput<T = any>(args: {
  model: ChatGoogleGenerativeAI;
  messages: BaseMessage[];
  schema: ZodTypeAny | any; // Zod 或 JSON Schema
  logger?: LoggerLike;
}): Promise<{ object: T; aiMessage?: AIMessage }> {
  const { model, messages, schema, logger } = args;
  let runnable: Runnable;

  // 如果传入 Zod，则用 withStructuredOutput(Zod)
  // 如果传入 JSON Schema，则用 withStructuredOutput({ schema })
  if (typeof (schema as any)?._def === "object") {
    runnable = model.withStructuredOutput(schema as ZodTypeAny);
  } else {
    runnable = model.withStructuredOutput({ schema });
  }

  const result = (await runnable.invoke(messages)) as any;
  // LangChain 返回的对象通常就是解析后的结果，但为了兼容将其包装
  if (typeof result === "object" && result !== null) {
    return { object: result };
  }
  logger?.warn?.("[structuredOutput] 非预期返回类型，返回 as-is");
  return { object: result as T };
}

/**
 * 非流式文本调用（可含工具上下文）
 */
export async function invokeText(args: {
  model: ChatGoogleGenerativeAI;
  messages: BaseMessage[];
}): Promise<AIMessage> {
  const { model, messages } = args;
  const res = (await model.invoke(messages)) as AIMessage;
  return res;
}

/**
 * 文本流式调用：返回增量文本
 * - 依赖 LangChain 的 stream 方法
 */
export async function* streamText(args: {
  model: ChatGoogleGenerativeAI;
  messages: BaseMessage[];
  logger?: LoggerLike;
}): AsyncGenerator<string, void, unknown> {
  const { model, messages, logger } = args;
  const stream = await model.stream(messages);
  for await (const chunk of stream) {
    try {
      // chunk 为 AIMessageChunk，content 可能是 string 或部分
      const delta = (chunk?.content as any)?.toString?.() ?? String(chunk?.content ?? "");
      if (delta) {
        yield delta;
      }
    } catch (e) {
      logger?.warn?.("[streamText] 解析流式分块失败", e);
    }
  }
}

/**
 * 将 Zod 类型转换为 JSON Schema（用于工具/结构化输出）辅助函数
 */
export function zodToSchema(schema: ZodTypeAny | any) {
  if (typeof (schema as any)?._def === "object") {
    return zodToJsonSchema(schema as ZodTypeAny, "ToolInput");
  }
  return schema;
}