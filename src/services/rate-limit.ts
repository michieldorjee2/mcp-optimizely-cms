import { hasRedis } from "./env.js";
import { log } from "./log.js";

/**
 * Tiny per-key token-bucket rate limiter backed by Upstash Redis.
 *
 * Keeps Optimizely's API quota safe from runaway agents — a malformed
 * loop calling update_page in a tight cycle can hammer the CMS otherwise.
 *
 * No-ops when Redis isn't configured. We deliberately don't pull
 * @upstash/ratelimit (it's small but adds another dep) — the algorithm is
 * a single INCR + EXPIRE.
 */

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number; // epoch ms
}

interface RateLimitOptions {
  /** Distinct key per logical bucket. Use the tool name + something
   *  identifying (traceId, ip, etc.). */
  key: string;
  /** Max requests in the window. */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
}

/**
 * Cheap fixed-window counter. INCR returns the new count; if it's the
 * first hit in the window, also set the EXPIRE so the bucket resets.
 */
export async function rateLimit(opts: RateLimitOptions): Promise<RateLimitResult> {
  if (!hasRedis()) {
    return { allowed: true, remaining: opts.limit, resetAt: Date.now() + opts.windowSec * 1000 };
  }
  try {
    const { Redis } = await import("@upstash/redis");
    const redis = new Redis({
      url: process.env.KV_REST_API_URL!,
      token: process.env.KV_REST_API_TOKEN!,
    });
    const now = Date.now();
    const bucket = Math.floor(now / 1000 / opts.windowSec);
    const key = `ratelimit:${opts.key}:${bucket}`;
    const count = await redis.incr(key);
    if (count === 1) {
      // First hit in this window; expire so the next window starts fresh.
      await redis.expire(key, opts.windowSec);
    }
    const allowed = count <= opts.limit;
    const remaining = Math.max(0, opts.limit - count);
    const resetAt = (bucket + 1) * opts.windowSec * 1000;
    if (!allowed) {
      log.warn("rate_limit.exceeded", { key: opts.key, count, limit: opts.limit, resetAt });
    }
    return { allowed, remaining, resetAt };
  } catch (e) {
    // Redis blip — fail open rather than blocking real traffic.
    log.warn("rate_limit.unreachable", {
      error: { message: e instanceof Error ? e.message : String(e) },
    });
    return { allowed: true, remaining: opts.limit, resetAt: Date.now() + opts.windowSec * 1000 };
  }
}
