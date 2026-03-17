import type { VercelRequest, VercelResponse } from "@vercel/node";
import { generateAuthCode } from "../src/auth.js";

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, MCP-Protocol-Version");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const redirectUri = (req.query.redirect_uri as string) || "";
  const state = (req.query.state as string) || "";
  const codeChallenge = req.query.code_challenge as string | undefined;

  if (!redirectUri) {
    return res.status(400).json({ error: "missing redirect_uri" });
  }

  // Generate auth code immediately (no real login required — env vars handle auth)
  const code = generateAuthCode(redirectUri, codeChallenge);

  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);

  return res.redirect(302, url.toString());
}
