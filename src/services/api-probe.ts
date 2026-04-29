import { hasRedis } from "./env.js";
import { log } from "./log.js";

/**
 * API surface probe + fallback resolution.
 *
 * Optimizely has multiple API surfaces (/preview3/, /preview3/experimental/,
 * /v1/) with overlapping but not identical functionality. We've already hit
 * one regression ("the versions endpoint doesn't exist on
 * /preview3/experimental/") this session. To avoid the next one, this module
 * lets helpers declare a list of candidate endpoints; the probe tries each in
 * order and caches the first one that works for 1 hour.
 *
 * Cache backed by Upstash Redis (shared across cold starts) with a process-
 * local memo as the warm-instance fast path. Falls through cleanly to the
 * first candidate when Redis isn't configured (still fast — usually right).
 */

interface ProbeResult {
  pickedIndex: number;
  ts: number; // epoch ms
}

const memoryCache = new Map<string, ProbeResult>();

const CACHE_TTL_SECONDS = 60 * 60; // 1h
const REDIS_KEY = (operation: string) => `api_probe:${operation}`;

async function readCache(operation: string): Promise<ProbeResult | null> {
  const memo = memoryCache.get(operation);
  if (memo && Date.now() - memo.ts < CACHE_TTL_SECONDS * 1000) return memo;

  if (!hasRedis()) return null;
  try {
    const { Redis } = await import("@upstash/redis");
    const redis = new Redis({
      url: process.env.KV_REST_API_URL!,
      token: process.env.KV_REST_API_TOKEN!,
    });
    const raw = await redis.get<ProbeResult | string>(REDIS_KEY(operation));
    if (!raw) return null;
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as ProbeResult) : (raw as ProbeResult);
    memoryCache.set(operation, parsed);
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(operation: string, result: ProbeResult): Promise<void> {
  memoryCache.set(operation, result);
  if (!hasRedis()) return;
  try {
    const { Redis } = await import("@upstash/redis");
    const redis = new Redis({
      url: process.env.KV_REST_API_URL!,
      token: process.env.KV_REST_API_TOKEN!,
    });
    await redis.set(REDIS_KEY(operation), JSON.stringify(result), { ex: CACHE_TTL_SECONDS });
  } catch {
    // best-effort
  }
}

/**
 * Try each candidate in order. The first one that resolves wins; the
 * choice is cached for an hour. On a 404 from a candidate, fall through
 * to the next; any other error fails the whole probe (the user's
 * candidate ordering is at fault, not the API surface).
 *
 * The classifier is configurable so callers can decide what counts as
 * "this surface doesn't exist" vs "this call legitimately failed."
 */
export async function probeApiSurface<T>(
  operation: string,
  candidates: Array<() => Promise<T>>,
  isSurfaceNotFound: (e: unknown) => boolean = defaultIsSurfaceNotFound
): Promise<T> {
  const cached = await readCache(operation);
  if (cached !== null && cached.pickedIndex < candidates.length) {
    const fn = candidates[cached.pickedIndex];
    if (fn) {
      try {
        return await fn();
      } catch (e) {
        if (!isSurfaceNotFound(e)) throw e;
        // Cached pick now 404s — fall through to a fresh probe.
        log.warn("api_probe.cached_pick_invalid", { operation, pickedIndex: cached.pickedIndex });
      }
    }
  }

  let lastError: unknown;
  for (let i = 0; i < candidates.length; i++) {
    const fn = candidates[i];
    if (!fn) continue;
    try {
      const result = await fn();
      await writeCache(operation, { pickedIndex: i, ts: Date.now() });
      log.info("api_probe.picked", { operation, pickedIndex: i });
      return result;
    } catch (e) {
      lastError = e;
      if (!isSurfaceNotFound(e)) throw e;
      // 404 — try next.
    }
  }
  throw lastError ?? new Error(`No surface available for operation '${operation}'.`);
}

function defaultIsSurfaceNotFound(e: unknown): boolean {
  if (typeof e === "object" && e !== null && "status" in e) {
    return (e as { status: number }).status === 404;
  }
  return false;
}
