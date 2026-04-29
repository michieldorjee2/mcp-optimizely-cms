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
