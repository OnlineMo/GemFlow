import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

// Mock @langchain/google-genai to avoid real network calls
vi.mock("@langchain/google-genai", () => {
  class ChatGoogleGenerativeAI {
    private _tools: any[] = [];
    constructor(private opts: any) {}
    bindTools(tools: any[]) {
      this._tools = tools ?? [];
      return this;
    }
    // Non-streaming inference
    async invoke(_messages: any[]) {
      // If tools are bound, simulate a single tool call decision
      if (this._tools.length > 0) {
        // Simulate the first step to decide tool calls
        return {
          content: "Decide tools",
          tool_calls: [
            {
              name: this._tools[0]?.name ?? "unknown_tool",
              args: { q: "hello" },
            },
          ],
        };
      }
      // Plan / Summarize
      return { content: "OK answer from mock model." };
    }
    // Structured output
    withStructuredOutput(_schema: any) {
      return {
        async invoke(_messages: any[]) {
          // Return a dummy object compliant enough for tests
          return { ok: true, days: [{ date: "2025-01-01", places: [] }] };
        },
      };
    }
    // Streaming
    async stream(_messages: any[]) {
      async function* gen() {
        yield { content: "This is " };
        yield { content: "a streaming " };
        yield { content: "response." };
      }
      return gen();
    }
  }
  return { ChatGoogleGenerativeAI };
});

// Import after mocks
import { createLibraryA } from "../../index";

describe("gemflow core", () => {
  it("run() - basic text result", async () => {
    const lib = createLibraryA({
      apiKey: "test-api-key",
      model: "gemini-1.5-pro",
      temperature: 0.2,
      maxSteps: 4,
      enableStreaming: false,
      memory: { kind: "inmemory" },
      tools: [],
    });

    const res = await lib.run("简单任务：给出一句话回答。");
    expect(typeof res.text).toBe("string");
    expect((res.text ?? "").length).toBeGreaterThan(0);
    expect(res.meta.model).toBe("gemini-1.5-pro");
    expect(typeof res.meta.durationMs).toBe("number");
    expect(Array.isArray(res.meta.usedTools)).toBe(true);
  });

  it("run() - structured output with Zod", async () => {
    const lib = createLibraryA({
      apiKey: "test-api-key",
      model: "gemini-1.5-pro",
      memory: { kind: "inmemory" },
    });

    const planSchema = z.object({
      days: z.array(
        z.object({
          date: z.string(),
          places: z.array(
            z.object({
              name: z.string().optional(),
              costEstimate: z.number().optional(),
              route: z.array(z.string()).optional(),
            })
          ),
        })
      ),
    });

    const res = await lib.run({ task: "输出结构化 JSON", schema: planSchema });
    expect(res.object).toBeTruthy();
    expect(res.text).toBeUndefined();
    expect(res.meta.model).toBe("gemini-1.5-pro");
  });

  it("stream() - streaming text chunks", async () => {
    const lib = createLibraryA({
      apiKey: "test-api-key",
      model: "gemini-1.5-pro",
      enableStreaming: true,
      memory: { kind: "inmemory" },
    });

    let full = "";
    let endMeta: any = null;
    for await (const chunk of lib.stream("请以流式输出回答这段内容")) {
      if (chunk.delta) {
        full += chunk.delta;
      }
      if (chunk.event === "end") {
        endMeta = chunk.meta;
      }
    }
    expect(full.length).toBeGreaterThan(0);
    expect(endMeta).toBeTruthy();
    expect(endMeta?.model).toBe("gemini-1.5-pro");
  });

  it("run() - tool calling path (usedTools populated)", async () => {
    const lib = createLibraryA({
      apiKey: "test-api-key",
      model: "gemini-1.5-pro",
      memory: { kind: "inmemory" },
      tools: [
        {
          name: "search",
          description: "通用检索",
          schema: z.object({ q: z.string() }),
          execute: async ({ q }) => {
            return { results: [`mocked result for: ${q}`] };
          },
        },
      ],
    });

    const res = await lib.run("需要检索信息并总结回答。");
    expect(Array.isArray(res.meta.usedTools)).toBe(true);
    // Because our mock returns a tool call for the first bound tool
    expect(res.meta.usedTools.includes("search")).toBe(true);
  });
});