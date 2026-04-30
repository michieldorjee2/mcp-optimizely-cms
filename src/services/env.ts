import { z } from "zod";

/**
 * Environment-variable contract for the MCP server.
 *
 * Parsed once at module load via `Zod.parse(process.env)` so:
 *   - Missing vars fail fast at cold start, not per-tool-call.
 *   - Optional vars get correct defaults / undefined.
 *   - The rest of the codebase consumes a typed `env` object instead of
 *     pulling raw strings out of process.env scattered everywhere.
 *
 * Required variables (cold-start fails without them):
 *   OPTIMIZELY_CMS_CLIENT_ID       — OAuth client id for the CMS
 *   OPTIMIZELY_CMS_CLIENT_SECRET   — OAuth client secret for the CMS
 *
 * Optional but feature-gating:
 *   OPTIMIZELY_GRAPH_KEY           — Graph (Content Cloud) API key for slug
 *                                    lookup, content-type introspection, etc.
 *   CMS_KV_REST_API_URL / _TOKEN   — Upstash Redis for the template store, OAuth
 *                                    token cache, idempotency and rate-limit.
 *                                    The un-prefixed KV_REST_API_URL / _TOKEN
 *                                    are accepted as a fallback so existing dev
 *                                    bindings keep working. See kvCreds().
 *                                    Falls back to in-memory if neither set.
 *   BRANDFETCH_API_KEY             — used by get_logo / get_brand tools.
 *   MCP_AUTH_SECRET                — HMAC secret for the OAuth-shim helpers
 *                                    in src/auth.ts. Has a deterministic
 *                                    dev fallback if unset.
 *   DEFAULT_PARENT_ID              — site-root container id; falls back to a
 *                                    constant in create-page.ts.
 *   SENTRY_DSN                     — error reporting (optional).
 *   LOG_LEVEL                      — "debug" | "info" | "warn" | "error".
 */

const EnvSchema = z.object({
  OPTIMIZELY_CMS_CLIENT_ID: z.string().min(1, "OPTIMIZELY_CMS_CLIENT_ID is required"),
  OPTIMIZELY_CMS_CLIENT_SECRET: z.string().min(1, "OPTIMIZELY_CMS_CLIENT_SECRET is required"),
  OPTIMIZELY_GRAPH_KEY: z.string().optional(),
  // KV credentials: Vercel/Upstash bindings vary by project — some use the
  // un-prefixed names, others (this project) use a CMS_ prefix to disambiguate
  // multiple stores. Both are documented; resolution lives in kvCreds() below.
  CMS_KV_REST_API_URL: z.string().url().optional(),
  CMS_KV_REST_API_TOKEN: z.string().optional(),
  KV_REST_API_URL: z.string().url().optional(),
  KV_REST_API_TOKEN: z.string().optional(),
  BRANDFETCH_API_KEY: z.string().optional(),
  MCP_AUTH_SECRET: z.string().optional(),
  DEFAULT_PARENT_ID: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  VERCEL_GIT_COMMIT_SHA: z.string().optional(),
  VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Lazy-loaded env. We don't call this at module load because tools that don't
 * need CMS credentials (e.g. get_sitemap, brand tools using only Brandfetch
 * key) shouldn't fail just because CMS creds are missing in dev.
 *
 * Instead, callers explicitly pull what they need:
 *   const e = env();             // parse + cache, throws on missing required
 *   const e = envSafe();         // never throws — returns either { env } or { error }
 *   const k = optionalEnv("KEY") // never throws, returns string | undefined
 */
let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function envSafe(): { env: Env } | { error: string } {
  try {
    return { env: env() };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function hasGraphKey(): boolean {
  return Boolean(env().OPTIMIZELY_GRAPH_KEY);
}

export interface KvCreds {
  url: string;
  token: string;
}

/**
 * Resolve the Upstash REST credentials. Prefers the CMS_ prefixed names so
 * deployments that bind multiple KV stores can disambiguate; falls back to the
 * un-prefixed names for vanilla / dev setups. Reads process.env directly so it
 * works even when the strict EnvSchema parse hasn't run.
 */
export function kvCreds(): KvCreds | null {
  const url = process.env.CMS_KV_REST_API_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.CMS_KV_REST_API_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

export function hasRedis(): boolean {
  return kvCreds() !== null;
}
