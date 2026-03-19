import { createHmac, randomBytes } from "node:crypto";

const AUTH_CODES = new Map<
  string,
  { redirectUri: string; codeChallenge?: string; createdAt: number }
>();
const REGISTERED_CLIENTS = new Map<
  string,
  { clientSecret: string; redirectUris: string[] }
>();

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

export function generateAuthCode(redirectUri: string, codeChallenge?: string): string {
  const code = randomBytes(32).toString("hex");
  AUTH_CODES.set(code, { redirectUri, codeChallenge, createdAt: Date.now() });
  for (const [k, v] of AUTH_CODES) {
    if (Date.now() - v.createdAt > 300_000) AUTH_CODES.delete(k);
  }
  return code;
}

export function consumeAuthCode(code: string, redirectUri: string): boolean {
  const entry = AUTH_CODES.get(code);
  if (!entry) return false;
  if (entry.redirectUri !== redirectUri) return false;
  if (Date.now() - entry.createdAt > 300_000) {
    AUTH_CODES.delete(code);
    return false;
  }
  AUTH_CODES.delete(code);
  return true;
}

export function registerClient(
  redirectUris: string[]
): { clientId: string; clientSecret: string } {
  const clientId = `mcp-client-${randomBytes(16).toString("hex")}`;
  const clientSecret = randomBytes(32).toString("hex");
  REGISTERED_CLIENTS.set(clientId, { clientSecret, redirectUris });
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
