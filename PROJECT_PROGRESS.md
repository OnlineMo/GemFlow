# 项目进度报告 - GemFlow（LangGraph × Gemini）

## 项目名称与简介
GemFlow：面向服务端的深度思考推理与工具编排库。采用 LangGraph 有向图状态机完成“规划 → 行动/工具 → 反思 → 验证 → 收敛”的多步推理，仅对接 Gemini（Google AI Studio）API，支持同步收敛与流式输出、Zod/JSON Schema 结构化输出、统一工具协议、短期/可插拔持久化记忆、速率限制/重试/超时/取消、LRU 缓存与可观测性事件。

核心入口与类型参考：
- API 出口：[`index.ts`](src/index.ts)
- 创建实例：[`createLibraryA()`](src/run.ts:62)
- 推理图构建：[`buildReasoningGraph()`](src/graph/graph.ts:51)
- Gemini 适配：[`createChatModel()`](src/model/gemini.ts:20)

---

## 当前阶段的进展情况

### 已完成
- 项目结构与工程化基线
  - 包配置与构建：[`package.json`](package.json)、[`tsup.config.ts`](tsup.config.ts)、类型声明产物
  - 质量工具：[`tsconfig.json`](tsconfig.json)、[`.eslintrc.json`](.eslintrc.json)、[`.prettierrc.json`](.prettierrc.json)、[`vitest.config.ts`](vitest.config.ts)
- LangGraph 状态机与推理流程
  - 节点：规划（plan）→ 行动/工具（act）→ 反思（reflect）→ 验证（validate）→ 收敛（converge）
  - 条件边与环路控制步数上限与提前收敛
  - 实现：[`graph.ts`](src/graph/graph.ts)
- Gemini 接入（仅 Google AI Studio）
  - 文本、结构化输出（Zod/JSON Schema）、流式调用
  - 实现：[`gemini.ts`](src/model/gemini.ts)
- 工具系统与统一协议
  - 工具声明/注册/执行，支持 Gemini 函数调用（function calling）
  - 实现：[`tools.ts`](src/core/tools.ts)
- 记忆与缓存
  - 短期会话记忆（内存实现）：[`inmemory.ts`](src/core/memory/inmemory.ts)
  - Prompt/响应级 LRU：[`cache.ts`](src/core/cache.ts)
- 可观测性与日志
  - 事件总线、可插拔日志：[`eventBus.ts`](src/core/eventBus.ts)、[`logger.ts`](src/core/logger.ts)
- 公共 API 与示例、说明文档
  - API：[`createLibraryA()`](src/run.ts:62)
  - README：[`README.md`](README.md)
  - 示例：[`examples/basic.ts`](examples/basic.ts)、[`examples/structured.ts`](examples/structured.ts)、[`examples/streaming.ts`](examples/streaming.ts)、[`examples/tools.ts`](examples/tools.ts)

### 正在进行
- 单元测试覆盖度提升（异常/重试/限流/缓存/流式与结构化边界）
  - 当前已提供核心路径的 mock 测试：[`core.test.ts`](src/__tests__/core.test.ts)
- 示例与文档细化（工具扩展、日志脱敏/事件订阅、部署最佳实践）

---

## 时间线与里程碑

| 日期(UTC+8) | 里程碑 | 说明 | 状态 |
|---|---|---|---|
| 2025-08-21 10:21 | 初始化工程 | package/tsconfig/tsup/ESLint/Prettier/Vitest | 已完成 |
| 2025-08-21 10:37 | Gemini 接入 | 文本/结构化/流式能力接入 | 已完成 |
| 2025-08-21 10:46 | 推理图构建 | LangGraph 节点/条件与循环 | 已完成 |
| 2025-08-21 10:49 | 公共 API | createLibraryA.run/stream/onEvent | 已完成 |
| 2025-08-21 11:00 | README | 安装/配置/使用/事件与日志 | 已完成 |
| 2025-08-21 11:12 | 测试基线 | Vitest 配置与核心用例 | 已完成 |
| 2025-08-21 11:24 | 示例完善 | basic/structured/streaming/tools | 已完成 |
| 2025-08-21 14:00 | 覆盖扩展 | 异常/重试/限流/缓存等测试补齐 | 进行中 |
| 2025-08-22 11:00 | 打包与发布 | tsup 构建产物验证、npm 发布准备 | 计划 |
| 2025-08-23 11:00 | 扩展记忆 | Redis/SQLite 适配器与样例 | 计划 |

> 注：具体时间点根据开发推进调整。

---

## 遇到的问题与解决方案

1) TypeScript Node 类型缺失
- 问题：tsconfig 指定了 "types": ["node"] 但本地类型缺失导致报错
- 方案：临时移除对 Node 专有类型的强依赖，增加 DOM lib；提供轻量全局声明以避免编译中断
  - 修改：[`tsconfig.json`](tsconfig.json)
  - 声明：[`global.d.ts`](src/types/global.d.ts)

2) 速率限制与重试/超时
- 问题：外部 API 存在速率限制与偶发失败风险
- 方案：实现 RPM 限流、指数退避重试、per-step/total 超时、AbortSignal 取消
  - 限流：[`ensureRateLimit()`](src/graph/graph.ts:324)
  - 重试：[`retryAsync()`](src/graph/graph.ts:345)
  - 超时包装：[`withTimeout()`](src/core/utils.ts:44)

3) 工具调用鲁棒性
- 问题：模型返回的 tool_calls 需安全解析与错误隔离
- 方案：Zod 校验、错误捕获与 tool 消息回写
  - 实现：[`executeToolCalls()`](src/core/tools.ts:44)

4) 结构化输出稳定性
- 问题：不同 schema（Zod/JSON Schema）需要统一适配
- 方案：统一结构化调用封装
  - 实现：[`invokeWithStructuredOutput()`](src/model/gemini.ts:65)

---

## 下一步计划与目标

- 测试
  - 增强异常/降级路径与边界用例（缓存一致性、并发与取消、工具超时与失败恢复）
  - 覆盖率目标：≥ 80%
- 记忆与持久化
  - Redis/SQLite 适配器与示例，支持可选的持久化会话与摘要
- 可观测性与合规
  - 费用估算与 token 统计（若 Gemini 可提供）
  - 日志脱敏与事件采样策略
- 交付与发布
  - GitHub Actions CI/CD
  - tsup 产物验证（ESM/CJS/types）与 npm 首次发布 v0.1.0

---

## 更新时间
2025-08-21 11:44 (UTC+8) / 2025-08-21T03:44:24Z