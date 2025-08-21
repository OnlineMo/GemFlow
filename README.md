# GemFlow — 基于 LangGraph 与 Gemini 的服务端深度思考与工具编排

一个用于服务端运行的多步推理引擎（规划 → 行动/工具 → 反思 → 验证 → 收敛），仅对接 Gemini（Google AI Studio）API。采用 LangGraph 的有向图状态机组织推理，支持同步收敛式与流式两种调用，工具函数调用（function calling）、结构化输出（Zod/JSON Schema）、短期/可选持久化记忆、可观测性事件、缓存与速率限制、超时与重试、并发与取消等工程能力。

- 运行时环境：Node.js ≥ 18
- 产物：ESM + CJS（由 tsup 构建）
- SDK：`@google/generative-ai` 或 `@langchain/google-genai` 适配器（本库默认使用后者）
- 仅可使用 Gemini（Google AI Studio）API，严禁调用 OpenAI/Vertex/其他接口

## 安装

```bash
# 建议在独立目录中使用
npm i gemflow
# 或（如本仓库内开发）
npm i
```

确保已设置环境变量（任一即可）：
- `GEMINI_API_KEY` 或 `GOOGLE_API_KEY`
- 可选：`GEMINI_MODEL`（默认 `gemini-1.5-pro`）

## 快速开始

```ts
import { createLibraryA, z } from "gemflow";

const lib = createLibraryA({
  apiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY,
  model: process.env.GEMINI_MODEL ?? "gemini-1.5-pro",
  temperature: 0.3,
  maxSteps: 8,
  enableStreaming: true,
  tools: [
    {
      name: "search",
      description: "通用检索",
      schema: z.object({ q: z.string() }),
      execute: async ({ q }) => {
        // 示例工具，可自行替换为真实实现
        return { results: [`你搜索了: ${q}`] };
      },
    },
  ],
  memory: { kind: "inmemory" }, // 可注入自定义持久化适配器
  logger: console,
  rateLimit: { rpm: 300, tpm: 80000 },
  cache: { ttlMs: 60_000, max: 500 },
  timeouts: { perStepMs: 30_000, totalMs: 120_000 },
  retries: { max: 3, initialDelayMs: 500, factor: 2 },
});

// 收敛式调用（返回最终结果）
const result = await lib.run("为我规划一个三天的东京美食行程，包含预算与地铁路径");
console.log(result.text);
console.log(result.meta); // 不含中间思考原文

// 结构化输出
const planSchema = z.object({
  days: z.array(z.object({
    date: z.string(),
    places: z.array(z.object({
      name: z.string(),
      costEstimate: z.number(),
      route: z.array(z.string())
    }))
  }))
});
const structured = await lib.run(
  { task: "输出 JSON 结构的东京三日美食行程", schema: planSchema }
);
console.log(structured.object);

// 流式调用（仅对最终答案阶段进行流式输出）
for await (const chunk of lib.stream("逐步推理解答：比较 Rust 与 Go 在高并发下的内存占用差异")) {
  process.stdout.write(chunk.delta ?? "");
}
```

## 能力概览

- 多步推理：采用 LangGraph 的 `StateGraph` 有向图状态机实现：
  - 任务理解与规划 → 执行与工具调用 → 反思自检 → 验证与收敛
  - 条件边 + 环路控制，支持步数上限与提前停止
- 工具编排：统一工具协议（名称/说明/输入输出/schema/执行逻辑），通过 Gemini 的函数调用能力触发
- 输出控制：支持纯文本与结构化输出（Zod/JSON Schema）
- 记忆：短期内存默认实现，可选持久化（注入适配器，如 Redis/SQLite）
- 可观测性：事件总线上报节点/工具/重试/缓存等关键事件，可插拔日志，DEBUG 级别可开启节点进入/退出等
- 工程能力：幂等、指数退避重试、超时/取消、速率限制与并发、LRU 缓存（提示与响应）、可配置的日志与钩子

## API

### createLibraryA(options)
创建库实例。主要参数（均可通过入参和/或环境变量配置）：

- `apiKey`: 来自 `GEMINI_API_KEY` 或 `GOOGLE_API_KEY`
- `model`: 默认为 `gemini-1.5-pro`，可通过入参或 `GEMINI_MODEL` 覆盖
- `temperature`, `topK`, `topP`, `maxTokens`, `enableStreaming`
- `tools`: 工具数组，详见“工具扩展指南”
- `memory`: `{ kind: "inmemory" | "custom", adapter?: MemoryAdapter, persist?: boolean }`
- `logger`: 可插拔日志器，默认内置（info/warn/error，DEBUG 含 debug）
- `rateLimit`: `{ rpm?: number, tpm?: number, concurrent?: number, enabled?: boolean }`
- `cache`: `{ enabled?: boolean, ttlMs?: number, max?: number }`
- `timeouts`: `{ perStepMs?: number, totalMs?: number }`
- `retries`: `{ max: number, initialDelayMs: number, factor: number, maxDelayMs?: number }`
- `systemPrompt`: 注入系统提示，贯穿推理

返回实例包含：
- `run(input, options?)`: Promise<{ text?: string; object?: any; meta: RunMeta }>
- `stream(input, options?)`: AsyncGenerator<{ delta?: string; event?: string; meta?: Partial<RunMeta> }>
- `onEvent(handler)`: 订阅可观测性事件（返回取消订阅函数）

### run(input, options?)
- `input`: 字符串任务或 `{ task: string; schema?: Zod/JSON Schema; context?: any }`
- `options`: `{ maxSteps?, enableStreaming?, signal?, overrides?: Partial<ModelParams> }`
- 返回 `RunResult`：`{ text?: string; object?: any; meta: RunMeta }`
- `meta` 包含步数、耗时、模型名、使用工具列表、是否命中缓存、可选事件（默认不返回）

### stream(input, options?)
- 返回异步迭代器，按增量文本输出最终答案阶段内容
- 结构化输出请求（提供 schema）时不进行文本流，而在结束时通过 `event: "end"` 推送 meta

### onEvent(handler)
可观测性事件订阅，用于调试与监控。事件类型包括：
- run:start/run:end、node:enter/node:exit、model:call:start/model:call:end
- tool:call:start/tool:call:end、retry、ratelimit:delay、cache:hit/cache:set、error

建议在生产环境使用脱敏策略，避免敏感信息泄露到日志与事件。

## 工具扩展指南

工具协议：
```ts
type ToolDefinition = {
  name: string;                 // 唯一名称（用于函数调用）
  description: string;          // 给模型的可读说明
  schema: ZodTypeAny | JSONSchema; // 入参定义（推荐 Zod）
  enabled?: boolean;            // 是否启用
  hidden?: boolean;             // 是否对模型暴露（true 表示仅内部可见）
  execute: (input, ctx) => Promise<any>; // 执行逻辑，返回可 JSON 序列化对象
};
```

注册工具：
```ts
import { createLibraryA, z } from "gemflow";

const lib = createLibraryA({
  apiKey: process.env.GEMINI_API_KEY,
  tools: [
    {
      name: "search",
      description: "通用检索",
      schema: z.object({ q: z.string() }),
      execute: async ({ q }, ctx) => {
        // 实际检索逻辑
        return { results: [`你搜索了: ${q}`] };
      },
    },
  ],
});
```

注意：
- 工具调用通过 Gemini 的函数调用能力触发，本库会将工具 schema/描述注册到模型侧
- 执行时会进行安全解析与错误捕获；返回值将以 `tool` 消息追加到对话历史，然后再由模型汇总生成候选答案

## 记忆与持久化

默认提供进程内记忆（不持久化）。可注入自定义适配器：
```ts
const lib = createLibraryA({
  memory: {
    kind: "custom",
    adapter: {
      async getHistory(runId) { /* ... */ },
      async append(runId, messages) { /* ... */ },
      async summarize(runId, opts) { /* optional */ },
      async clear(runId) { /* optional */ },
    }
  }
});
```

## 环境变量

- 认证与模型
  - `GEMINI_API_KEY` / `GOOGLE_API_KEY`
  - `GEMINI_MODEL`（默认 `gemini-1.5-pro`）
  - `GEMINI_TEMPERATURE`、`GEMINI_TOP_K`、`GEMINI_TOP_P`、`GEMINI_MAX_TOKENS`
  - `GEMINI_STREAMING`（默认 true）

- 超时与重试
  - `TIMEOUT_PER_STEP_MS`、`TIMEOUT_TOTAL_MS`
  - `RETRY_MAX`、`RETRY_INITIAL_MS`、`RETRY_FACTOR`、`RETRY_MAX_DELAY_MS`

- 速率限制与并发
  - `RATE_LIMIT_RPM`、`RATE_LIMIT_TPM`、`RATE_LIMIT_CONCURRENT`、`RATE_LIMIT_ENABLED`

- 事件与日志
  - `LIBRARYA_EVENTS` / `LIBRARY_A_EVENTS`（开启事件收集）
  - `DEBUG`（开启 debug 日志镜像）

## 可观测性与日志

- 默认日志器输出关键阶段与错误堆栈
- 开启 DEBUG 后可见每个图节点的进入与退出、缓存命中等
- 通过 `onEvent` 订阅内部事件，建议在生产环境做脱敏与采样

## 安全与合规

- 本库不会主动将中间思考/推理链原文暴露给最终用户
- 建议对工具输出进行来源可信校验与内容过滤（URL 白名单、敏感词过滤等）
- 建议启用最小权限策略、限制调用速率与并发，保护下游资源
- 请遵守 Google AI Studio 的服务条款与使用政策

## 示例与测试

examples 目录包含：
- `basic.ts`：最小可运行示例
- `structured.ts`：结构化输出（Zod）
- `streaming.ts`：流式输出
- `tools.ts`：多工具与多步推理示例

测试（Vitest）建议使用 mock/stub 对 Gemini 调用进行隔离；你也可以通过设置 `GEMINI_API_KEY` 运行集成测试。构建由 `tsup` 生成 ESM 与 CJS 双产物及类型声明。

## 开发脚本

- 构建：`npm run build`
- 测试：`npm test` / `npm run test:coverage`
- 代码风格：`npm run lint` / `npm run format`
- 示例：
  - `npm run example:basic`
  - `npm run example:structured`
  - `npm run example:streaming`
  - `npm run example:tools`

## 许可证

MIT