import type { VercelRequest, VercelResponse } from "@vercel/node";
import { envSafe, hasGraphKey, hasRedis } from "../src/services/env.js";
import { getCmsToken } from "../src/services/cms-api.js";

/**
 * Liveness + readiness endpoint.
 *
 *   GET /health
 *
 * Returns 200 with a structured status payload describing what's
 * configured and reachable, or 503 if a hard dependency is broken.
 *
 *   {
 *     "status": "ok" | "degraded" | "down",
 *     "version": "<git commit sha>",
 *     "env": "production" | "preview" | "development",
 *     "checks": {
 *       "envVars":   "ok" | { error: "..." },
 *       "graphKey":  "configured" | "missing",
 *       "redis":     "configured" | "not-configured",
 *       "cmsAuth":   "ok" | { error: "..." }
 *     }
 *   }
 *
 * The TMS / Opal layer can register this as a heartbeat URL. Also useful
 * to hit by hand when triaging "all tools 404" — if /health is green,
 * the MCP itself is fine and the breakage is upstream.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const checks: Record<string, unknown> = {};
  let status: "ok" | "degraded" | "down" = "ok";

  // 1. Env variable validation.
  const e = envSafe();
  if ("error" in e) {
    checks.envVars = { error: e.error };
    status = "down";
    return res.status(503).json({
      status,
      version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "unknown",
      env: process.env.VERCEL_ENV ?? "development",
      checks,
    });
  }
  checks.envVars = "ok";
  checks.graphKey = hasGraphKey() ? "configured" : "missing";
  checks.redis = hasRedis() ? "configured" : "not-configured";

  // 2. CMS auth probe — exercises the OAuth round-trip (cached, so cheap
  //    on warm instances). Confirms the credentials are still valid.
  try {
    await getCmsToken(e.env.OPTIMIZELY_CMS_CLIENT_ID, e.env.OPTIMIZELY_CMS_CLIENT_SECRET);
    checks.cmsAuth = "ok";
  } catch (err) {
    checks.cmsAuth = { error: err instanceof Error ? err.message : String(err) };
    status = "degraded";
  }

  // status can only be "ok" or "degraded" at this point — the "down"
  // branch above already returned. Both should report 200 (degraded ≠
  // unavailable; the MCP can still serve some tools).
  return res.status(200).json({
    status,
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "unknown",
    env: process.env.VERCEL_ENV ?? "development",
    checks,
    deployedAt: new Date().toISOString(),
  });
}
