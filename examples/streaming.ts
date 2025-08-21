import "dotenv/config";
import { createLibraryA } from "../src";

async function main() {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.error("请设置 GEMINI_API_KEY 或 GOOGLE_API_KEY 环境变量后再运行示例。");
    process.exit(1);
  }

  const controller = new AbortController();

  const lib = createLibraryA({
    apiKey,
    model: process.env.GEMINI_MODEL ?? "gemini-1.5-pro",
    temperature: 0.3,
    maxSteps: 6,
    enableStreaming: true,
    memory: { kind: "inmemory" },
    logger: console,
    rateLimit: { rpm: 60, enabled: true },
    cache: { ttlMs: 60_000, max: 200 },
    timeouts: { perStepMs: 30_000, totalMs: 120_000 },
    retries: { max: 3, initialDelayMs: 500, factor: 2 },
  });

  // 可选：订阅事件（仅演示）
  const off = lib.onEvent((e) => {
    if (e.kind === "node:enter" || e.kind === "node:exit") {
      console.debug("[event]", e.kind, e.data);
    }
  });

  const iterable = lib.stream(
    "逐步推理解答：比较 Rust 与 Go 在高并发场景下的内存占用差异，并给出测量建议",
    { signal: controller.signal }
  );

  console.log("=== 流式输出开始 ===");
  try {
    for await (const chunk of iterable) {
      if (chunk.delta) process.stdout.write(chunk.delta);
      if (chunk.event === "end") {
        console.log("\n=== 元数据 ===");
        console.log(chunk.meta);
      }
      // 如需中途取消：controller.abort();
    }
  } finally {
    off();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});