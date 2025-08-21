import "dotenv/config";
import { createLibraryA } from "../src";

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
  });

  const res = await lib.run("用两个要点解释什么是 LangGraph，并列举一个使用场景。");
  console.log("=== 文本结果 ===");
  console.log(res.text);
  console.log("\n=== 元数据（不含中间思考原文） ===");
  console.log(res.meta);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});