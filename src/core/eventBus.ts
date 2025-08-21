import { EventBus, EventPayload, LoggerLike } from "./types";

/**
 * 简单可插拔事件总线实现
 * - 支持多订阅者
 * - 订阅返回取消函数
 * - 可选将事件镜像到 logger.debug
 */
export function createEventBus(logger?: LoggerLike): EventBus {
  const handlers = new Set<(e: EventPayload) => void>();

  return {
    on(handler: (e: EventPayload) => void) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    emit(e: EventPayload) {
      try {
        for (const h of handlers) {
          try {
            h(e);
          } catch (err) {
            logger?.warn?.("[eventBus] handler error", err);
          }
        }
        // Debug 级别镜像
        logger?.debug?.(
          "[eventBus]",
          e.kind,
          new Date(e.timestamp).toISOString(),
          e.data ?? {}
        );
      } catch (err) {
        logger?.warn?.("[eventBus] emit error", err);
      }
    },
  };
}