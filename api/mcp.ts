import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMcpServer } from "../src/server.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { log, newTraceId } from "../src/services/log.js";
import { captureException } from "../src/services/sentry.js";
import { rateLimit } from "../src/services/rate-limit.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Generate or accept a traceId per request. Clients can send their own
  // x-trace-id (e.g. agent runtime correlation); otherwise we mint one.
  const traceId =
    (typeof req.headers["x-trace-id"] === "string" && req.headers["x-trace-id"]) || newTraceId();
  res.setHeader("X-Trace-Id", traceId);

  const start = Date.now();

  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version, X-Trace-Id"
    );
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, X-Trace-Id");

    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }

    if (req.method === "DELETE") {
      return res.status(200).end();
    }

    if (req.method === "GET") {
      return res.status(405).json({ error: "SSE not supported in stateless mode. Use POST." });
    }

    if (req.method === "POST") {
      // Per-IP rate limit. Generous default (60 req / min) — only catches
      // pathological loops, not normal agent traffic. Backed by Upstash;
      // no-ops if Redis isn't configured. Keyed by client IP so multi-
      // tenant deployments don't share buckets.
      const ipHeader =
        (typeof req.headers["x-forwarded-for"] === "string" && req.headers["x-forwarded-for"]) ||
        req.socket?.remoteAddress ||
        "unknown";
      const ip = ipHeader.split(",")[0]?.trim() ?? "unknown";
      const rl = await rateLimit({ key: `mcp:${ip}`, limit: 60, windowSec: 60 });
      res.setHeader("X-RateLimit-Limit", "60");
      res.setHeader("X-RateLimit-Remaining", String(rl.remaining));
      res.setHeader("X-RateLimit-Reset", String(Math.floor(rl.resetAt / 1000)));
      if (!rl.allowed) {
        return res.status(429).json({
          error: "Too Many Requests",
          message: `Rate limit exceeded — wait until ${new Date(rl.resetAt).toISOString()}.`,
          traceId,
        });
      }

      // Stateless: every POST gets a fresh transport and server.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined as unknown as (() => string),
      });

      const server = createMcpServer({ traceId });
      await server.connect(transport);

      // Pull both the JSON-RPC method (initialize / tools/call / tools/list)
      // and — when it's a tools/call — the actual tool name from params.
      // Otherwise the request line says "tools/call" for every tool, and the
      // tool name only appears in tool.start, which Vercel's CLI bulk view
      // collapses out of the visible output.
      const body = req.body as
        | { method?: string; params?: { name?: string } }
        | undefined;
      const jsonrpcMethod = body?.method ?? "unknown";
      const toolName = jsonrpcMethod === "tools/call" ? body?.params?.name : undefined;
      log.info("mcp.request", {
        traceId,
        method: req.method,
        method_jsonrpc: jsonrpcMethod,
        ...(toolName ? { tool: toolName } : {}),
      });

      // Capture the JSON-RPC response body as the transport streams it,
      // so the per-request summary log can hoist outcome fields (success,
      // stage, fieldErrors count, shapeHints / normalizationNotes flags)
      // onto a single line. Vercel's CLI surfaces one structured line per
      // request reliably; collapsing the outcome here avoids relying on
      // the inner tool.* logs that get dropped post-res.end.
      const captured: Buffer[] = [];
      // Patch res.write to tee bytes into `captured` (passes through
      // immediately so progressive SSE writes still reach the wire);
      // patch res.end to tee + DEFER. Vercel's serverless runtime stops
      // capturing stdout once res.end fires, so any log emitted after the
      // transport's final write is silently dropped — that's why
      // mcp.complete previously never surfaced. We hold the end signal
      // until after we've logged, then call origEnd ourselves.
      type Patchable = {
        write: (chunk: unknown, ...rest: unknown[]) => boolean;
        end: (chunk?: unknown, ...rest: unknown[]) => unknown;
      };
      const patchable = res as unknown as Patchable;
      const origWrite = patchable.write.bind(patchable);
      const origEnd = patchable.end.bind(patchable);
      let endChunk: unknown = undefined;
      let endRest: unknown[] = [];
      let endCalled = false;
      patchable.write = (chunk: unknown, ...rest: unknown[]) => {
        if (typeof chunk === "string") captured.push(Buffer.from(chunk));
        else if (chunk instanceof Buffer) captured.push(chunk);
        return origWrite(chunk, ...rest);
      };
      patchable.end = (chunk?: unknown, ...rest: unknown[]) => {
        if (chunk !== undefined) {
          if (typeof chunk === "string") captured.push(Buffer.from(chunk));
          else if (chunk instanceof Buffer) captured.push(chunk);
        }
        endChunk = chunk;
        endRest = rest;
        endCalled = true;
        return res; // claim success; we'll really end the response below
      };

      await transport.handleRequest(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
        req.body
      );

      // Parse the captured response body — best-effort. SSE framing means
      // the body looks like "event: message\ndata: {...}\n"; pull out the
      // first JSON object after `data: `.
      const bodyText = Buffer.concat(captured).toString("utf8");
      const dataLine = bodyText.match(/data:\s*(\{[\s\S]*?\})/);
      let outcome: {
        success?: boolean;
        stage?: string;
        fieldErrorCount?: number;
        hasShapeHints?: boolean;
        hasNormalizationNotes?: boolean;
      } = {};
      if (dataLine && dataLine[1]) {
        try {
          const parsed = JSON.parse(dataLine[1]) as {
            result?: { content?: Array<{ text?: string }> };
            error?: unknown;
          };
          const text = parsed.result?.content?.[0]?.text;
          if (typeof text === "string" && text.startsWith("{")) {
            const inner = JSON.parse(text) as {
              success?: boolean;
              stage?: string;
              fieldErrors?: unknown[];
              shapeHints?: unknown[];
              normalizationNotes?: unknown[];
            };
            outcome = {
              success: inner.success,
              stage: inner.stage,
              fieldErrorCount: Array.isArray(inner.fieldErrors)
                ? inner.fieldErrors.length
                : undefined,
              hasShapeHints:
                Array.isArray(inner.shapeHints) && inner.shapeHints.length > 0,
              hasNormalizationNotes:
                Array.isArray(inner.normalizationNotes) &&
                inner.normalizationNotes.length > 0,
            };
          }
          if (parsed.error) {
            outcome.success = false;
          }
        } catch {
          /* unparseable response body — skip outcome */
        }
      }

      log.info("mcp.complete", {
        traceId,
        method_jsonrpc: jsonrpcMethod,
        ...(toolName ? { tool: toolName } : {}),
        durationMs: Date.now() - start,
        status: res.statusCode,
        ...(outcome.success !== undefined ? { success: outcome.success } : {}),
        ...(outcome.stage ? { stage: outcome.stage } : {}),
        ...(outcome.fieldErrorCount !== undefined
          ? { fieldErrorCount: outcome.fieldErrorCount }
          : {}),
        ...(outcome.hasShapeHints ? { hasShapeHints: true } : {}),
        ...(outcome.hasNormalizationNotes ? { hasNormalizationNotes: true } : {}),
      });

      // Now actually end the response. Up to here res.end was deferred
      // so the log above lands while stdout capture is still attached.
      if (endCalled) {
        origEnd(endChunk, ...endRest);
      }

      return;
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    log.error("mcp.handler_error", {
      traceId,
      error: { message: err instanceof Error ? err.message : String(err) },
    });
    await captureException(err, { traceId });
    if (!res.headersSent) {
      return res.status(500).json({
        error: "Internal server error",
        message: String(err),
        traceId,
      });
    }
  }
}
