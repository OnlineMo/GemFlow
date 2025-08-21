import LRU from "lru-cache";
import { CacheConfig, LoggerLike } from "./types";
import { stableStringify } from "./utils";

/**
 * 轻量 LRU 缓存（支持 TTL）
 * - prompt 级与响应级可用同一实现
 * - key 需自行构造（建议使用 stableStringify）
 */
export class SimpleCache<V = any> {
  private cache: LRU<string, { value: V; createdAt: number }>;
  private logger?: LoggerLike;

  constructor(
    config?: CacheConfig,
    logger?: LoggerLike
  ) {
    this.cache = new LRU<string, { value: V; createdAt: number }>({
      max: config?.max ?? 500,
      ttl: config?.ttlMs ?? 60_000,
      allowStale: false,
      updateAgeOnGet: false,
      updateAgeOnHas: false,
    });
    this.logger = logger;
  }

  get(key: string): V | undefined {
    const hit = this.cache.get(key);
    if (hit) {
      this.logger?.debug?.("[cache] hit", { key });
      return hit.value;
    }
    return undefined;
  }

  set(key: string, value: V) {
    this.cache.set(key, { value, createdAt: Date.now() });
    this.logger?.debug?.("[cache] set", { key });
  }

  has(key: string) {
    return this.cache.has(key);
  }

  delete(key: string) {
    this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }
}

/**
 * 构造缓存 key 的辅助函数
 */
export function makeCacheKey(parts: Record<string, unknown>): string {
  return stableStringify(parts);
}