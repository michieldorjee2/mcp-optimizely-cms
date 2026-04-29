import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMcpServer } from "../src/server.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { log, newTraceId } from "../src/services/log.js";
import { captureException } from "../src/services/sentry.js";

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
      // Stateless: every POST gets a fresh transport and server.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined as unknown as (() => string),
      });

      const server = createMcpServer({ traceId });
      await server.connect(transport);

      log.info("mcp.request", {
        traceId,
        method: req.method,
        method_jsonrpc:
          (req.body as { method?: string } | undefined)?.method ?? "unknown",
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
