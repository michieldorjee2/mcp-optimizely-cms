import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getServerMetadata, getBaseUrl } from "../src/auth";

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, MCP-Protocol-Version");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const baseUrl = getBaseUrl(req.headers);
  return res.status(200).json(getServerMetadata(baseUrl));
}
