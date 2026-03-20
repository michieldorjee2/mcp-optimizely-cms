import { createHmac, randomBytes } from "node:crypto";

function getAuthSecret(): string {
  return process.env.MCP_AUTH_SECRET || "default-dev-secret-" + (process.env.OPTIMIZELY_CMS_CLIENT_ID || "local");
}

export function getBaseUrl(req: Request): string {
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "localhost:3000";
  const proto = req.headers.get("x-forwarded-proto") || "https";
  return `${proto}://${host}`;
}

// ---------------------------------------------------------------------------
// JWT token generation & validation
// ---------------------------------------------------------------------------

export function generateToken(): string {
  const payload = {
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    scope: "mcp:full",
  };
  const payloadStr = JSON.stringify(payload);
  const payloadB64 = Buffer.from(payloadStr).toString("base64url");
  const headerB64 = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const sig = createHmac("sha256", getAuthSecret())
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");
  return `${headerB64}.${payloadB64}.${sig}`;
}

export function validateToken(token: string): boolean {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const [headerB64, payloadB64, sig] = parts;
    const expectedSig = createHmac("sha256", getAuthSecret())
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64url");
    if (sig !== expectedSig) return false;
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Stateless auth codes — HMAC-signed so they work across serverless instances
// ---------------------------------------------------------------------------

export function generateAuthCode(redirectUri: string, codeChallenge?: string): string {
  const payload = JSON.stringify({
    redirectUri,
    codeChallenge: codeChallenge || null,
    exp: Date.now() + 300_000, // 5 minutes
    nonce: randomBytes(8).toString("hex"),
  });
  const payloadB64 = Buffer.from(payload).toString("base64url");
  const sig = createHmac("sha256", getAuthSecret())
    .update(payloadB64)
    .digest("base64url");
  return `${payloadB64}.${sig}`;
}

export function consumeAuthCode(code: string, redirectUri: string): boolean {
  try {
    const dotIdx = code.lastIndexOf(".");
    if (dotIdx === -1) return false;
    const payloadB64 = code.slice(0, dotIdx);
    const sig = code.slice(dotIdx + 1);
    const expectedSig = createHmac("sha256", getAuthSecret())
      .update(payloadB64)
      .digest("base64url");
    if (sig !== expectedSig) return false;
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
    if (payload.exp < Date.now()) return false;
    if (payload.redirectUri !== redirectUri) return false;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Stateless client registration — always succeeds
// ---------------------------------------------------------------------------

export function registerClient(redirectUris: string[]): { clientId: string; clientSecret: string } {
  const clientId = `mcp-client-${randomBytes(16).toString("hex")}`;
  const clientSecret = randomBytes(32).toString("hex");
  return { clientId, clientSecret };
}

// ---------------------------------------------------------------------------
// OAuth server metadata (RFC 8414)
// ---------------------------------------------------------------------------

export function getServerMetadata(baseUrl: string) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "client_credentials"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    scopes_supported: ["mcp:full"],
  };
}
