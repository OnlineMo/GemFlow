import "dotenv/config";
import { createLibraryA, z } from "../src";

function safeAdd(expr: string): number {
  // 简单演示：只支持形如 "1+2+3" 的加法
  const parts = expr.split("+").map((s) => s.trim());
  if (!parts.every((p) => /^\d+(\.\d+)?$/.test(p))) {
    throw new Error("仅支持形如 1+2+3 的简单加法表达式");
  }
  return parts.reduce((sum, p) => sum + Number(p), 0);
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.error("请设置 GEMINI_API_KEY 或 GOOGLE_API_KEY 环境变量后再运行示例。");
    process.exit(1);
  }

  const lib = createLibraryA({
    apiKey,
    model: process.env.GEMINI_MODEL ?? "gemini-1.5-pro",
    temperature: 0.3,
    maxSteps: 6,
    enableStreaming: false,
    memory: { kind: "inmemory" },
    logger: console,
    rateLimit: { rpm: 60, enabled: true },
    cache: { ttlMs: 60_000, max: 200 },
    timeouts: { perStepMs: 30_000, totalMs: 120_000 },
    retries: { max: 3, initialDelayMs: 500, factor: 2 },
    tools: [
      {
        name: "search",
        description: "通用检索（示例：不实际联网，仅返回模板结果）",
        schema: z.object({ q: z.string() }),
        execute: async ({ q }) => {
          // 这里演示接口协议，真实环境可接入你的搜索 API
          return {
            results: [
              `示例搜索结果 A: ${q}`,
              `示例搜索结果 B: ${q}`,
              `示例搜索结果 C: ${q}`,
            ],
          };
        },
      },
      {
        name: "math_add",
        description: "对加法表达式求和（仅支持形如 1+2+3）",
        schema: z.object({ expr: z.string() }),
        execute: async ({ expr }) => {
          const value = safeAdd(expr);
          return { expr, value };
        },
      },
    ],
  });

  const task =
    "请先使用 search 工具检索 “LangGraph Gemini”，再使用 math_add 计算 1+2+3，并输出综合结论。";
  const result = await lib.run(task);

  console.log("=== 文本结果 ===");
  console.log(result.text);
  console.log("\n=== 元数据（不含中间思考原文） ===");
  console.log(result.meta);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});