/**
 * 生成 runId（优先使用 Web Crypto，退化到随机串）
 * - 避免依赖 Node 专有类型，兼容 ESM/CJS + DOM lib
 */
export function genRunId(prefix = "run"): string {
  try {
    const g: any = globalThis as any;
    if (g.crypto?.randomUUID) {
      return `${prefix}_${g.crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    }
    if (g.crypto?.getRandomValues) {
      const bytes = new Uint8Array(8);
      g.crypto.getRandomValues(bytes);
      const hex = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      return `${prefix}_${hex}`;
    }
  } catch {}
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 稳定 JSON 序列化（按键排序）
 */
export function stableStringify(obj: any): string {
  return JSON.stringify(sortKeys(obj));
}

function sortKeys(input: any): any {
  if (Array.isArray(input)) return input.map(sortKeys);
  if (input && typeof input === "object") {
    const out: any = {};
    for (const k of Object.keys(input).sort()) {
      out[k] = sortKeys(input[k]);
    }
    return out;
  }
  return input;
}

/**
 * 简易 slug 化（用于可观测性与路径安全）
 */
export function slugify(s: string, maxLen = 64): string {
  return s
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .toLowerCase();
}

/**
 * 超时包装（支持 AbortSignal）
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms?: number,
  signal?: AbortSignal
): Promise<T> {
  if (!ms && !signal) return promise;

  return new Promise<T>((resolve, reject) => {
    let done = false;
    const onAbort = () => {
      if (done) return;
      done = true;
      clearTimeout(timer as any);
      reject(new Error("Aborted"));
    };

    const timer = ms
      ? setTimeout(() => {
          if (done) return;
          done = true;
          cleanup();
          reject(new Error(`Timeout after ${ms}ms`));
        }, ms)
      : undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    promise
      .then((v) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(v);
      })
      .catch((e) => {
        if (done) return;
        done = true;
        cleanup();
        reject(e);
      });
  });
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function nowMs() {
  return Date.now();
}