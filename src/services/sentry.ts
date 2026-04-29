import { envSafe } from "./env.js";
import { log } from "./log.js";

/**
 * Sentry-shim — captureException/captureMessage that fall back to logging
 * when SENTRY_DSN isn't configured. Does NOT pull in the real Sentry SDK to
 * avoid ballooning cold-start size; we send events to Sentry's HTTP ingest
 * endpoint directly.
 *
 * If you want richer features (breadcrumbs, performance tracing) it's
 * trivial to swap this for `@sentry/node` later — the call sites use a
 * stable shape.
 */

interface SentryEnvelope {
  event_id: string;
  timestamp: number;
  level: "error" | "warning" | "info";
  platform: "node";
  release?: string;
  environment?: string;
  message?: { formatted: string };
  exception?: {
    values: Array<{
      type: string;
      value: string;
      stacktrace?: { frames: Array<{ filename: string; function: string; lineno?: number }> };
    }>;
  };
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

function generateEventId(): string {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

function parseDsn(dsn: string): { host: string; projectId: string; publicKey: string } | null {
  // sentry DSN: https://<publicKey>@<host>/<projectId>
  try {
    const url = new URL(dsn);
    return {
      host: url.host,
      projectId: url.pathname.replace(/^\//, ""),
      publicKey: url.username,
    };
  } catch {
    return null;
  }
}

async function send(envelope: SentryEnvelope): Promise<void> {
  const e = envSafe();
  if ("error" in e) return;
  if (!e.env.SENTRY_DSN) return;
  const dsn = parseDsn(e.env.SENTRY_DSN);
  if (!dsn) return;

  const url = `https://${dsn.host}/api/${dsn.projectId}/store/`;
  const auth = `Sentry sentry_version=7, sentry_key=${dsn.publicKey}, sentry_client=mcp-optimizely-cms/1.0.0`;

  try {
    // Best-effort fire-and-forget. Don't block the request on Sentry.
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sentry-Auth": auth },
      body: JSON.stringify(envelope),
    });
  } catch {
    // intentionally swallowed
  }
}

function baseEnvelope(): Omit<SentryEnvelope, "level"> {
  const e = envSafe();
  return {
    event_id: generateEventId(),
    timestamp: Date.now() / 1000,
    platform: "node",
    release:
      "error" in e ? undefined : e.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? undefined,
    environment: "error" in e ? undefined : e.env.VERCEL_ENV ?? "development",
  };
}

export async function captureException(
  error: unknown,
  context?: { traceId?: string; tool?: string; extra?: Record<string, unknown> }
): Promise<void> {
  const errObj =
    error instanceof Error ? error : new Error(String(error));

  // Always log locally — Sentry is supplementary, not a replacement.
  log.error("captured_exception", {
    error: { name: errObj.name, message: errObj.message, stack: errObj.stack },
    ...context,
  });

  await send({
    ...baseEnvelope(),
    level: "error",
    exception: {
      values: [
        {
          type: errObj.name || "Error",
          value: errObj.message,
          stacktrace: errObj.stack
            ? {
                frames: errObj.stack
                  .split("\n")
                  .slice(1)
                  .map((line) => {
                    const match = line.match(/at (\S+) \((.+):(\d+):\d+\)/);
                    return {
                      function: match?.[1] ?? line.trim(),
                      filename: match?.[2] ?? "",
                      lineno: match?.[3] ? Number(match[3]) : undefined,
                    };
                  }),
              }
            : undefined,
        },
      ],
    },
    tags: {
      ...(context?.tool ? { tool: context.tool } : {}),
      ...(context?.traceId ? { traceId: context.traceId } : {}),
    },
    extra: context?.extra,
  });
}

export async function captureMessage(
  message: string,
  level: "warning" | "info" = "info",
  context?: { traceId?: string; tool?: string; extra?: Record<string, unknown> }
): Promise<void> {
  log.info("captured_message", { msg: message, ...context });
  await send({
    ...baseEnvelope(),
    level,
    message: { formatted: message },
    tags: {
      ...(context?.tool ? { tool: context.tool } : {}),
      ...(context?.traceId ? { traceId: context.traceId } : {}),
    },
    extra: context?.extra,
  });
}
