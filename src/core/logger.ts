import { EventBus, EventPayload, LoggerLike } from "./types";

/**
 * 默认日志实现（可插拔）
 * - 支持最小 info/warn/error
 * - 可选 debug
 * - 支持事件镜像（通过 withEventMirror）
 */
export function createDefaultLogger(debug = false): LoggerLike {
  const base = {
    info: (...args: any[]) => console.log("[gemflow]", ...args),
    warn: (...args: any[]) => console.warn("[gemflow]", ...args),
    error: (...args: any[]) => console.error("[gemflow]", ...args),
  } as LoggerLike;

  if (debug) {
    base.debug = (...args: any[]) => console.debug("[gemflow:debug]", ...args);
  }
  return base;
}

/**
 * 将事件总线的事件镜像到 logger.debug（可选）
 */
export function withEventMirror(logger: LoggerLike | undefined, bus: EventBus) {
  if (!logger?.debug) return;
  bus.on((e: EventPayload) => {
    logger.debug?.(`[event] ${e.kind}`, {
      at: new Date(e.timestamp).toISOString(),
      data: e.data ?? {},
    });
  });
}