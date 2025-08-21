import { MemoryAdapter, MemoryMessage } from "../types";

/**
 * 简单的内存记忆实现（默认）
 * - 进程内 Map 存储，不持久化
 * - 支持按 runId 读取与追加
 * - 可选 summarize（占位，返回最近 N 条摘要）
 */
export class InMemoryMemory implements MemoryAdapter {
  private store = new Map<string, MemoryMessage[]>();
  private maxKeep: number;

  constructor(options?: { maxKeep?: number }) {
    this.maxKeep = options?.maxKeep ?? 200;
  }

  async getHistory(runId: string): Promise<Array<MemoryMessage>> {
    return this.store.get(runId)?.slice(-this.maxKeep) ?? [];
  }

  async append(runId: string, messages: Array<MemoryMessage>): Promise<void> {
    const arr = this.store.get(runId) ?? [];
    arr.push(
      ...messages.map((m) => ({
        ...m,
        createdAt: m.createdAt ?? Date.now(),
      }))
    );
    // 截断
    if (arr.length > this.maxKeep) {
      this.store.set(runId, arr.slice(-this.maxKeep));
    } else {
      this.store.set(runId, arr);
    }
  }

  async summarize(
    runId: string,
    options?: { maxTokens?: number; systemPrompt?: string }
  ): Promise<string> {
    // 轻量实现：仅返回最近几条 user/assistant 的简要拼接
    const history = await this.getHistory(runId);
    const lines: string[] = [];
    for (const m of history.slice(-10)) {
      if (m.role === "user" || m.role === "assistant") {
        lines.push(`${m.role.toUpperCase()}: ${truncate(m.content, 300)}`);
      }
    }
    const prefix = options?.systemPrompt
      ? `SYSTEM: ${truncate(options.systemPrompt, 400)}\n`
      : "";
    return prefix + lines.join("\n");
  }

  async clear(runId: string): Promise<void> {
    this.store.delete(runId);
  }
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "..." : s;
}