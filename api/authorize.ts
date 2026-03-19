// Removed - no OAuth2 needed
import type { VercelRequest, VercelResponse } from "@vercel/node";
export default function handler(_req: VercelRequest, res: VercelResponse) {
  return res.status(410).json({ error: "OAuth2 removed. Connect directly to /mcp." });
}
