import type { VercelRequest, VercelResponse } from "@vercel/node";
import { registerClient } from "../src/auth.js";

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, MCP-Protocol-Version");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const body = req.body || {};
  const redirectUris = body.redirect_uris || [];

  const { clientId, clientSecret } = registerClient(redirectUris);

  return res.status(201).json({
    client_id: clientId,
    client_secret: clientSecret,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "client_credentials"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
  });
}
