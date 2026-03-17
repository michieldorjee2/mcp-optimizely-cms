import type { VercelRequest, VercelResponse } from "@vercel/node";
import { generateToken, consumeAuthCode } from "../src/auth.js";

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Protocol-Version");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const body = req.body || {};
  const grantType = body.grant_type;

  if (grantType === "client_credentials") {
    // For client_credentials, we just issue a token — real auth is via env vars
    const token = generateToken();
    return res.status(200).json({
      access_token: token,
      token_type: "Bearer",
      expires_in: 3600,
      scope: "mcp:full",
    });
  }

  if (grantType === "authorization_code") {
    const code = body.code;
    const redirectUri = body.redirect_uri;

    if (!code || !redirectUri) {
      return res.status(400).json({ error: "invalid_request", error_description: "Missing code or redirect_uri" });
    }

    const valid = consumeAuthCode(code, redirectUri);
    if (!valid) {
      return res.status(400).json({ error: "invalid_grant", error_description: "Invalid or expired authorization code" });
    }

    const token = generateToken();
    return res.status(200).json({
      access_token: token,
      token_type: "Bearer",
      expires_in: 3600,
      scope: "mcp:full",
    });
  }

  return res.status(400).json({
    error: "unsupported_grant_type",
    error_description: `Grant type '${grantType}' is not supported`,
  });
}
