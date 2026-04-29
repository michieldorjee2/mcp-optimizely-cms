import { isRetryable } from "./errors.js";
import { log } from "./log.js";

/**
 * Run a fetch-style operation with exponential backoff. Retries on
 * 408 / 429 / 5xx and network errors only — never on 4xx-but-not-408/429,
 * which are deterministic input issues that wouldn't fix themselves.
 *
 * Defaults: 3 attempts, 200ms / 600ms / 1800ms backoff with full jitter.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options?: {
    attempts?: number;
    baseMs?: number;
    factor?: number;
    onRetry?: (e: unknown, attempt: number, waitMs: number) => void;
  }
): Promise<T> {
  const attempts = options?.attempts ?? 3;
  const baseMs = options?.baseMs ?? 200;
  const factor = options?.factor ?? 3;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (e) {
      lastError = e;
      if (attempt === attempts || !isRetryable(e)) throw e;
      const exp = baseMs * Math.pow(factor, attempt - 1);
      // Full jitter — random between 0 and the full window.
      const wait = Math.floor(Math.random() * exp);
      log.warn("retry.scheduled", {
        attempt,
        waitMs: wait,
        error: { message: e instanceof Error ? e.message : String(e) },
      });
      options?.onRetry?.(e, attempt, wait);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  // Unreachable, but TS can't prove it.
  throw lastError;
}
