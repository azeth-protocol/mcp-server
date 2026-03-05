import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { error } from './response.js';

/** Maximum tool invocations per tool per window */
const MAX_CALLS_PER_MINUTE = 30;

/** Sliding window duration in milliseconds */
const WINDOW_MS = 60_000;

export interface RateLimiter {
  /** Returns true if the call is allowed, false if rate-limited */
  check(toolName: string): boolean;
  /** Reset all state (for testing) */
  reset(): void;
  /** Stop the periodic cleanup timer (for graceful shutdown / tests) */
  destroy(): void;
}

/** Periodic cleanup interval for expired timestamps (60s) */
const CLEANUP_INTERVAL_MS = 60_000;

/** Create an in-memory per-tool rate limiter with periodic cleanup */
export function createRateLimiter(
  maxCalls = MAX_CALLS_PER_MINUTE,
  windowMs = WINDOW_MS,
): RateLimiter {
  const timestamps = new Map<string, number[]>();

  // Periodic cleanup to prevent memory leak from stale tool entries
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [tool, times] of timestamps) {
      const recent = times.filter(t => now - t < windowMs);
      if (recent.length === 0) {
        timestamps.delete(tool);
      } else {
        timestamps.set(tool, recent);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  // Allow the process to exit without waiting for this timer
  if (cleanupTimer && typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
    cleanupTimer.unref();
  }

  return {
    check(toolName: string): boolean {
      const now = Date.now();
      const existing = timestamps.get(toolName) ?? [];
      const recent = existing.filter(t => now - t < windowMs);
      if (recent.length >= maxCalls) {
        timestamps.set(toolName, recent);
        return false;
      }
      recent.push(now);
      timestamps.set(toolName, recent);
      return true;
    },
    reset() {
      timestamps.clear();
    },
    destroy() {
      clearInterval(cleanupTimer);
      timestamps.clear();
    },
  };
}

/**
 * Wrap an McpServer so that each tool registered through the wrapper
 * has per-tool rate limiting applied before the handler executes.
 */
export function wrapServerWithRateLimit(
  server: McpServer,
  limiter: RateLimiter,
): McpServer {
  const originalRegisterTool = server.registerTool.bind(server);

  // Create a proxy that intercepts registerTool calls
  const proxy = new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === 'registerTool') {
        return function registerToolWithRateLimit(
          name: string,
          config: unknown,
          handler: (...handlerArgs: unknown[]) => Promise<unknown>,
        ) {
          const wrappedHandler = async (...handlerArgs: unknown[]) => {
            if (!limiter.check(name)) {
              return error(
                'RATE_LIMITED',
                `Too many requests for tool "${name}" — please wait before retrying.`,
                'Wait 60 seconds before calling this tool again.',
              );
            }
            return handler(...handlerArgs);
          };
          return originalRegisterTool(name, config as never, wrappedHandler as never);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  return proxy;
}
