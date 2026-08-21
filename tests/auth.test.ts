import { describe, it, expect } from "vitest";
import {
  generateToken,
  validateToken,
  generateRefreshToken,
  validateRefreshToken,
  getServerMetadata,
  ACCESS_TOKEN_EXPIRES_IN,
} from "../src/auth.js";

function decodePayload(token: string): Record<string, unknown> {
  const payloadB64 = token.split(".")[1] as string;
  return JSON.parse(Buffer.from(payloadB64, "base64url").toString());
}

describe("access tokens", () => {
  it("round-trips", () => {
    expect(validateToken(generateToken())).toBe(true);
  });

  it("outlives a single agent run by a wide margin", () => {
    // The 1h TTL this replaced was what let TMS drop the Limitless
    // credential between runs. Anything under a day reintroduces that.
    expect(ACCESS_TOKEN_EXPIRES_IN).toBeGreaterThan(24 * 60 * 60);
    const { iat, exp } = decodePayload(generateToken()) as { iat: number; exp: number };
    expect(exp - iat).toBe(ACCESS_TOKEN_EXPIRES_IN);
  });

  it("rejects a tampered signature", () => {
    const token = generateToken();
    expect(validateToken(token.slice(0, -4) + "aaaa")).toBe(false);
  });
});

describe("refresh tokens", () => {
  it("round-trips", () => {
    expect(validateRefreshToken(generateRefreshToken())).toBe(true);
  });

  it("outlives the access token", () => {
    const access = decodePayload(generateToken()) as { exp: number };
    const refresh = decodePayload(generateRefreshToken()) as { exp: number };
    expect(refresh.exp).toBeGreaterThan(access.exp);
  });

  it("is not accepted as an access token", () => {
    expect(validateToken(generateRefreshToken())).toBe(false);
  });

  it("does not accept an access token in its place", () => {
    expect(validateRefreshToken(generateToken())).toBe(false);
  });
});

describe("server metadata", () => {
  it("advertises the refresh_token grant so TMS renews instead of dropping", () => {
    expect(getServerMetadata("https://example.test").grant_types_supported).toContain(
      "refresh_token"
    );
  });
});
