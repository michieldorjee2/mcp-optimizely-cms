import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMcpServer } from "../src/server";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { validateToken } from "../src/auth";

const sessions = new Map<
  string,
  { transport: StreamableHTTPServerTransport; server: ReturnType<typeof createMcpServer> }
>();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
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

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "unauthorized",
        error_description: "Missing or invalid Bearer token",
      });
    }
    const token = authHeader.slice(7);
    if (!validateToken(token)) {
      return res.status(401).json({
        error: "unauthorized",
        error_description: "Invalid or expired token",
      });
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "DELETE") {
      if (sessionId && sessions.has(sessionId)) {
        const { transport } = sessions.get(sessionId)!;
        await transport.close();
        sessions.delete(sessionId);
      }
      return res.status(200).end();
    }

    if (req.method === "POST") {
      if (!sessionId || !sessions.has(sessionId)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, { transport, server });
          },
        });

        transport.onclose = () => {
          const sid = [...sessions.entries()].find(([, s]) => s.transport === transport)?.[0];
          if (sid) sessions.delete(sid);
        };

        const server = createMcpServer();
        await server.connect(transport);

        await transport.handleRequest(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
          req.body
        );
        return;
      }

      const { transport } = sessions.get(sessionId)!;
      await transport.handleRequest(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
        req.body
      );
      return;
    }

    if (req.method === "GET") {
      if (!sessionId || !sessions.has(sessionId)) {
        return res.status(400).json({ error: "Missing or invalid session ID" });
      }
      const { transport } = sessions.get(sessionId)!;
      await transport.handleRequest(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse
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
