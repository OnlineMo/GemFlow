import "dotenv/config";
import { createLibraryA, z } from "../src";

async function main() {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.error("请设置 GEMINI_API_KEY 或 GOOGLE_API_KEY 环境变量后再运行示例。");
    process.exit(1);
  }

  const planSchema = z.object({
    days: z.array(
      z.object({
        date: z.string(),
        places: z.array(
          z.object({
            name: z.string(),
            costEstimate: z.number().optional(),
            route: z.array(z.string()).optional(),
          })
        ),
      })
    ),
  });

  const lib = createLibraryA({
    apiKey,
    model: process.env.GEMINI_MODEL ?? "gemini-1.5-pro",
    temperature: 0.2,
    maxSteps: 6,
    enableStreaming: false,
    memory: { kind: "inmemory" },
    rateLimit: { rpm: 60, enabled: true },
    cache: { ttlMs: 60_000, max: 200 },
    timeouts: { perStepMs: 30_000, totalMs: 120_000 },
    retries: { max: 3, initialDelayMs: 500, factor: 2 },
  });

  const result = await lib.run({
    task: "输出 JSON 结构的东京三日美食行程（含简要路径与预算估计）",
    schema: planSchema,
  });

  console.log("=== 结构化对象 ===");
  console.dir(result.object, { depth: 10 });
  console.log("\n=== 元数据 ===");
  console.log(result.meta);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});