import type { ZodTypeAny } from "zod";

/**
 * 轻量可插拔日志接口
 */
export interface LoggerLike {
  debug?: (...args: any[]) => void;
  info?: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
  error?: (...args: any[]) => void;
}

/**
 * 重试与退避策略
 */
export interface RetryConfig {
  max: number;
  initialDelayMs: number;
  factor: number;
  maxDelayMs?: number;
}

/**
 * 超时控制
 */
export interface TimeoutConfig {
  perStepMs?: number;
  totalMs?: number;
}

/**
 * 速率与并发限制
 */
export interface RateLimitConfig {
  rpm?: number; // requests per minute
  tpm?: number; // tokens per minute (尽力而为，统计估算)
  concurrent?: number; // 最大并发
  enabled?: boolean;
}

/**
 * 缓存配置（prompt 级 / 响应级）
 */
export interface CacheConfig {
  enabled?: boolean;
  ttlMs?: number;
  max?: number;
}

/**
 * 统一工具协议
 * schema: 使用 Zod 定义输入参数；返回值需为可 JSON 序列化对象
 */
export interface ToolDefinition<TInput = any, TOutput = any> {
  name: string;
  description: string;
  schema: ZodTypeAny;
  enabled?: boolean;
  hidden?: boolean;
  execute: (input: TInput, ctx: ToolExecutionContext) => Promise<TOutput>;
}

/**
 * 工具执行上下文（可观测性、取消、配置）
 */
export interface ToolExecutionContext {
  signal?: AbortSignal;
  logger?: LoggerLike;
  metadata?: Record<string, any>;
}

/**
 * 记忆接口与配置
 */
export interface MemoryAdapter {
  getHistory(runId: string): Promise<Array<MemoryMessage>>;
  append(runId: string, messages: Array<MemoryMessage>): Promise<void>;
  summarize?(
    runId: string,
    options?: { maxTokens?: number; systemPrompt?: string }
  ): Promise<string>;
  clear?(runId: string): Promise<void>;
}

export interface MemoryConfig {
  kind: "inmemory" | "custom";
  adapter?: MemoryAdapter;
  namespace?: string;
  persist?: boolean;
}

/**
 * 记忆消息结构（轻量对齐 Chat 历史）
 */
export type MemoryRole = "system" | "user" | "assistant" | "tool";
export interface MemoryMessage {
  id?: string;
  role: MemoryRole;
  content: string;
  name?: string; // tool 名称（当 role=tool）
  createdAt?: number;
}

/**
 * LangGraph 状态机上下文（核心）
 */
export interface GraphState {
  runId: string;
  input: RunInput;
  params: ModelParams;
  step: number;
  maxSteps: number;
  plan?: string;
  thoughts?: string; // 内部思考（不外泄）
  actions?: Array<{ tool: string; args: any }>;
  toolResults?: Array<{ tool: string; result: any }>;
  candidateAnswer?: string;
  structuredSchemaJson?: any;
  isValid?: boolean;
  finalAnswer?: string;
  finalObject?: any;
  startedAt: number;
  endedAt?: number;
  cacheHit?: boolean;
  usedTools?: string[];
  errors?: Array<{ step: number; node: string; error: string }>;
}

/**
 * 模型调用配置（Gemini）
 */
export interface ModelParams {
  apiKey: string;
  model: string;
  temperature?: number;
  topK?: number;
  topP?: number;
  maxTokens?: number;
  enableStreaming?: boolean;
  systemPrompt?: string;
  timeouts?: TimeoutConfig;
  retries?: RetryConfig;
  rateLimit?: RateLimitConfig;
}

/**
 * 事件与可观测性
 */
export type EventKind =
  | "run:start"
  | "run:end"
  | "node:enter"
  | "node:exit"
  | "model:call:start"
  | "model:call:end"
  | "tool:call:start"
  | "tool:call:end"
  | "retry"
  | "ratelimit:delay"
  | "cache:hit"
  | "cache:set"
  | "error";

export interface EventPayload {
  runId: string;
  kind: EventKind;
  timestamp: number;
  data?: Record<string, any>;
}

export interface EventBus {
  on(handler: (e: EventPayload) => void): () => void; // 返回取消订阅函数
  emit(e: EventPayload): void;
}

/**
 * 对外公共 API
 */
export type RunInput =
  | string
  | {
      task: string;
      schema?: ZodTypeAny | any; // Zod 或 JSON Schema
      context?: Record<string, any>;
    };

export interface RunOptions {
  maxSteps?: number;
  enableStreaming?: boolean;
  signal?: AbortSignal;
  overrides?: Partial<ModelParams>;
}

export interface RunMeta {
  steps: number;
  durationMs: number;
  model: string;
  usedTools: string[];
  cacheHit: boolean;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUSD?: number;
  };
  events?: EventPayload[]; // 可选返回（默认不包含内部思考文本）
}

export interface RunResult {
  text?: string;
  object?: any;
  meta: RunMeta;
}

export interface StreamChunk {
  delta?: string; // 文本增量
  event?: string; // 事件标签（可选）
  meta?: Partial<RunMeta>;
}

export interface CreateLibraryAOptions {
  apiKey?: string;
  model?: string;
  temperature?: number;
  topK?: number;
  topP?: number;
  maxTokens?: number;
  maxSteps?: number;
  enableStreaming?: boolean;
  tools?: ToolDefinition[];
  memory?: MemoryConfig;
  logger?: LoggerLike;
  rateLimit?: RateLimitConfig;
  cache?: CacheConfig;
  timeouts?: TimeoutConfig;
  retries?: RetryConfig;
  systemPrompt?: string;
}

export interface LibraryA {
  run(input: RunInput, options?: RunOptions): Promise<RunResult>;
  stream(
    input: RunInput,
    options?: RunOptions
  ): AsyncGenerator<StreamChunk, void, unknown>;
  /**
   * 订阅内部可观测性事件（节点进入/退出、工具调用、重试、缓存等）
   * 返回取消订阅函数
   */
  onEvent(handler: (e: EventPayload) => void): () => void;
}