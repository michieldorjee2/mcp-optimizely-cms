import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function getAuthSecret(): string {
  return process.env.MCP_AUTH_SECRET || "default-dev-secret";
}

export function getBaseUrl(headers: Record<string, string | string[] | undefined>): string {
  const host =
    (headers["x-forwarded-host"] as string) ||
    (headers["host"] as string) ||
    "localhost:3000";
  const proto = (headers["x-forwarded-proto"] as string) || "https";
  return `${proto}://${host}`;
}

export function generateToken(): string {
  const payload = {
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    scope: "mcp:full",
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
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

// Stateless auth code: HMAC-signed token containing redirect_uri + timestamp
// No server-side storage needed — works across serverless invocations
export function generateAuthCode(redirectUri: string, _codeChallenge?: string): string {
  const payload = {
    redirect_uri: redirectUri,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300, // 5 min expiry
    nonce: randomBytes(8).toString("hex"),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", getAuthSecret())
    .update(payloadB64)
    .digest("base64url");
  return `${payloadB64}.${sig}`;
}

export function consumeAuthCode(code: string, redirectUri: string): boolean {
  try {
    const parts = code.split(".");
    if (parts.length !== 2) return false;
    const [payloadB64, sig] = parts;

    // Verify signature
    const expectedSig = createHmac("sha256", getAuthSecret())
      .update(payloadB64)
      .digest("base64url");
    if (sig !== expectedSig) return false;

    // Verify payload
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return false;
    if (payload.redirect_uri !== redirectUri) return false;

    return true;
  } catch {
    return false;
  }
}

// Stateless client registration: always succeeds, returns deterministic IDs
export function registerClient(
  redirectUris: string[]
): { clientId: string; clientSecret: string } {
  const clientId = `mcp-client-${randomBytes(16).toString("hex")}`;
  const clientSecret = randomBytes(32).toString("hex");
  return { clientId, clientSecret };
}

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
