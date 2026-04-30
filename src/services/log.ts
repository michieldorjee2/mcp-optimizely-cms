import { randomUUID } from "node:crypto";
import { env, envSafe } from "./env.js";

/**
 * Structured logger + traceId helpers.
 *
 * Vercel's serverless logs pick up anything we write to stdout/stderr
 * with sensible parsing if it's JSON. We emit one JSON object per line
 * with a consistent shape so they're greppable / queryable later via
 * `vercel logs <deployment> --json`.
 *
 * Every MCP tool invocation generates a traceId; it's threaded through
 * the API helpers (via withTrace) so failed calls can be correlated
 * across stages. Tools that pass debug=true also surface the traceId in
 * their response to the caller.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function currentLevel(): number {
  const e = envSafe();
  if ("error" in e) return LEVELS.info;
  return LEVELS[e.env.LOG_LEVEL];
}

interface LogFields {
  msg: string;
  traceId?: string;
  tool?: string;
  endpoint?: string;
  method?: string;
  status?: number;
  durationMs?: number;
  attempt?: number;
  error?: { name?: string; message?: string; stack?: string };
  [k: string]: unknown;
}

function emit(level: LogLevel, entry: LogFields) {
  if (LEVELS[level] < currentLevel()) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    ...entry,
  };
  // Use stderr for warn/error so Vercel surfaces them in the logs UI's
  // error stream; stdout for info/debug.
  const stream = level === "warn" || level === "error" ? "stderr" : "stdout";
  const out = JSON.stringify(line);
  if (stream === "stderr") {
    process.stderr.write(out + "\n");
  } else {
    process.stdout.write(out + "\n");
  }
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) =>
    emit("debug", { msg, ...fields }),
  info: (msg: string, fields?: Record<string, unknown>) =>
    emit("info", { msg, ...fields }),
  warn: (msg: string, fields?: Record<string, unknown>) =>
    emit("warn", { msg, ...fields }),
  error: (msg: string, fields?: Record<string, unknown>) =>
    emit("error", { msg, ...fields }),
};

// ---------------------------------------------------------------------------
// Trace context — node:async_hooks would be ideal, but on Vercel serverless
// we just thread traceId explicitly. The MCP entry point (api/mcp.ts) calls
// `traceId()` once per JSON-RPC request and passes it through to tool
// handlers; tool handlers attach it to error responses when debug=true.
// ---------------------------------------------------------------------------

export function newTraceId(): string {
  // 12 hex chars — enough entropy for correlation, short enough to fit in
  // a log line and a tool response without bloat.
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

/**
 * Wrap an async operation with a trace marker — logs start/end + duration,
 * captures errors with stack. Returns the operation's value.
 */
export async function withTrace<T>(
  context: { traceId: string; tool: string; stage?: string },
  op: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  log.debug("stage.start", context);
  try {
    const result = await op();
    log.debug("stage.end", { ...context, durationMs: Date.now() - start });
    return result;
  } catch (e) {
    log.error("stage.error", {
      ...context,
      durationMs: Date.now() - start,
      error: {
        name: e instanceof Error ? e.name : undefined,
        message: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      },
    });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Tool-call logging — wraps a tool handler so every invocation produces a
// structured record of (tool, params, success/failure, duration, error).
//
// Many tools return failure as data (`{success: false, stage, error}`) rather
// than throwing — so a plain try/catch wouldn't surface them. We inspect the
// returned shape and emit a `tool.failure` warn line when success===false, so
// these calls are greppable in Vercel logs alongside thrown errors.
// ---------------------------------------------------------------------------

// Keys whose values can blow up the log line — truncate their string form.
const PARAM_TRUNCATE_KEYS = new Set(["propertiesJson"]);
// Hard cap on any individual string param so a giant payload can't drown out
// the rest of the log.
const PARAM_MAX_LEN = 500;

function summarizeParams(params: unknown): unknown {
  if (!params || typeof params !== "object") return params;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (typeof v === "string" && (PARAM_TRUNCATE_KEYS.has(k) || v.length > PARAM_MAX_LEN)) {
      out[k] =
        v.length > PARAM_MAX_LEN ? `${v.slice(0, PARAM_MAX_LEN)}…(${v.length} chars)` : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

interface ToolFailureShape {
  success?: boolean;
  stage?: string;
  error?: unknown;
  fieldErrors?: Array<{ field?: string; detail?: string }>;
  status?: number;
  endpoint?: string;
}

function errorSummary(err: unknown): string | undefined {
  if (err == null) return undefined;
  if (typeof err === "string") return err.length > 500 ? `${err.slice(0, 500)}…` : err;
  try {
    const s = JSON.stringify(err);
    return s.length > 500 ? `${s.slice(0, 500)}…` : s;
  } catch {
    return String(err);
  }
}

export async function withToolLogging<T>(
  context: { tool: string; traceId?: string; params?: unknown },
  op: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  log.info("tool.start", {
    tool: context.tool,
    traceId: context.traceId,
    params: summarizeParams(context.params),
  });
  try {
    const result = await op();
    const r = result as ToolFailureShape | null | undefined;
    const durationMs = Date.now() - start;
    if (r && typeof r === "object" && r.success === false) {
      // Hoist stage / fieldErrors / status to top-level fields so Vercel's
      // CLI bulk view (which only shows one log line per request) still
      // surfaces the diagnostic detail. Otherwise it'd be buried inside the
      // truncated `error` blob and only visible to live streaming.
      log.warn("tool.failure", {
        tool: context.tool,
        traceId: context.traceId,
        durationMs,
        stage: r.stage,
        status: r.status,
        endpoint: r.endpoint,
        error: errorSummary(r.error),
        ...(r.fieldErrors && r.fieldErrors.length > 0 ? { fieldErrors: r.fieldErrors } : {}),
      });
      // Inject the traceId into the response so the agent (which often
      // doesn't surface response headers) can quote it back when reporting
      // the error. Only mutate plain failure-as-data objects, never overwrite
      // an existing _traceId.
      if (context.traceId && !("_traceId" in (r as object))) {
        (r as Record<string, unknown>)._traceId = context.traceId;
      }
    } else {
      log.info("tool.end", { tool: context.tool, traceId: context.traceId, durationMs });
    }
    return result;
  } catch (e) {
    log.error("tool.error", {
      tool: context.tool,
      traceId: context.traceId,
      durationMs: Date.now() - start,
      error: {
        name: e instanceof Error ? e.name : undefined,
        message: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      },
    });
    // Annotate the error so the outer handler (server.ts catch block) can
    // include the traceId in the response body without re-threading state.
    if (context.traceId && e instanceof Error) {
      (e as Error & { traceId?: string }).traceId = context.traceId;
    }
    throw e;
  }
}
