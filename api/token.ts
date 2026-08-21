import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  generateToken,
  generateRefreshToken,
  validateRefreshToken,
  consumeAuthCode,
  ACCESS_TOKEN_EXPIRES_IN,
} from "../src/auth.js";

/**
 * Every successful grant returns the same envelope: a long-lived access
 * token plus a refresh token. Opal's TMS persists both; without the
 * refresh_token it silently drops the credential once the access token
 * expires, which is what broke the Limitless connector (see src/auth.ts).
 */
function issue(res: VercelResponse) {
  return res.status(200).json({
    access_token: generateToken(),
    refresh_token: generateRefreshToken(),
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_EXPIRES_IN,
    scope: "mcp:full",
  });
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, MCP-Protocol-Version"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const body = (req.body ?? {}) as {
    grant_type?: string;
    code?: string;
    redirect_uri?: string;
    refresh_token?: string;
  };
  const grantType = body.grant_type;

  if (grantType === "client_credentials") {
    return issue(res);
  }

  if (grantType === "refresh_token") {
    const refreshToken = body.refresh_token;
    if (!refreshToken) {
      return res
        .status(400)
        .json({ error: "invalid_request", error_description: "Missing refresh_token" });
    }
    if (!validateRefreshToken(refreshToken)) {
      return res
        .status(400)
        .json({ error: "invalid_grant", error_description: "Invalid or expired refresh token" });
    }
    return issue(res);
  }

  if (grantType === "authorization_code") {
    const code = body.code;
    const redirectUri = body.redirect_uri;

    if (!code || !redirectUri) {
      return res
        .status(400)
        .json({ error: "invalid_request", error_description: "Missing code or redirect_uri" });
    }

    const valid = consumeAuthCode(code, redirectUri);
    if (!valid) {
      return res
        .status(400)
        .json({
          error: "invalid_grant",
          error_description: "Invalid or expired authorization code",
        });
    }

    return issue(res);
  }

  return res.status(400).json({
    error: "unsupported_grant_type",
    error_description: `Grant type '${grantType}' is not supported`,
  });
}
