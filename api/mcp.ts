import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMcpServer } from "../src/server.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version"
    );
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }

    if (req.method === "DELETE") {
      return res.status(200).end();
    }

    if (req.method === "GET") {
      // SSE not supported in stateless serverless mode
      return res.status(405).json({ error: "SSE not supported in stateless mode. Use POST." });
    }

    if (req.method === "POST") {
      // Stateless: every POST gets a fresh transport and server
      // This works on Vercel serverless where in-memory state doesn't persist
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined as unknown as (() => string),
      });

      const server = createMcpServer();
      await server.connect(transport);

      await transport.handleRequest(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
        req.body
      );

      return;
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("MCP handler error:", err);
    if (!res.headersSent) {
      return res.status(500).json({ error: "Internal server error", message: String(err) });
    }
  }
}
