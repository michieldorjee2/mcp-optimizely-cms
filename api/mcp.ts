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

      await transport.handleRequest(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
        req.body
      );

      log.info("mcp.response", {
        traceId,
        durationMs: Date.now() - start,
        status: res.statusCode,
      });

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
