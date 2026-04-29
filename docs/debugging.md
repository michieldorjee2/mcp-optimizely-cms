---
title: Debugging the Optimizely CMS MCP
updated: 2026-04-29
---

# Debugging guide

## "All my tools 404"

Almost always a **wrapper layer** problem (TMS / Opal / your AI's tool
registry) — not the MCP. Triage in this order:

1. **Hit the health endpoint directly.**
   ```bash
   curl https://mcp-optimizely-cms.vercel.app/health
   ```
   Expect `{ "status": "ok", "checks": { "envVars": "ok", "cmsAuth": "ok", ... } }`.
   - 503 with `envVars: { error: ... }` → the MCP is down because env vars
     are missing on Vercel.
   - 200 with `cmsAuth: { error: ... }` → the OAuth credentials are
     stale; rotate them.
   - 200 with everything ok → the MCP is fine and the breakage is upstream.

2. **Hit `tools/list` directly via vercel curl.**
   ```bash
   vercel curl /mcp --deployment <prod-url> -- \
     -X POST \
     -H 'Content-Type: application/json' \
     -H 'Accept: application/json, text/event-stream' \
     -H 'MCP-Protocol-Version: 2024-11-05' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
   ```
   If this returns the tool list, the MCP itself is healthy.

3. **Confirm what URL the wrapper is hitting.** Old deployment-specific
   URLs (`mcp-optimizely-abc123-...vercel.app`) get replaced when a new
   prod deploy aliases over them. The TMS may have pinned an old URL.
   The stable alias is `mcp-optimizely-cms.vercel.app`.

4. **Confirm the tool registry is current.** Adding new tools (e.g.
   `get_page`, `get_sitemap`) requires the wrapper to re-discover them.
   Many wrappers cache the tool list — they need a manual refresh.

## "update_page accidentally changed the slug"

Optimizely auto-derives the URL slug from displayName on publish. If
neither the caller nor the latest published version had a routeSegment
the MCP could re-pin to, the new slug wins. The MCP tries:

1. `input.routeSegment` if the caller passed one.
2. `existingMeta.routeSegment` from `GET /v1/content/{key}`.
3. `base.routeSegment` from the latest version (some tenants store it
   here, not on the content).

If all three are empty, the MCP can't prevent drift. Check the response —
the `routeSegmentRepinned: true|false` field tells you whether the
defensive PATCH ran.

To force a specific slug, pass `routeSegment` explicitly to update_page.

## "create_page returned a duplicate page after I retried"

Pass `idempotencyKey` on the create_page call. Same key + same args →
returns the original contentId without creating a duplicate. 24h TTL
in Upstash; falls through cleanly when Redis isn't configured.

## Reading server logs

Vercel logs are JSON-line structured:

```bash
vercel logs <prod-url> --json | jq 'select(.level == "error")'
```

Useful field paths:

- `traceId` — correlate a request across multiple log lines. Also
  surfaced as the `X-Trace-Id` response header so clients can quote it
  back when reporting an issue.
- `endpoint` / `method` / `status` on captured CmsApiError exceptions —
  tells you which Optimizely call failed.
- `attempt` / `waitMs` — when retry kicks in. Repeated `retry.scheduled`
  entries with rising attempt counts mean the upstream is flapping.

## "The schema validation says my analystCards is wrong but I copied it
from the Optimizely UI"

The Optimizely UI strips wrapping. The API expects every primitive value
wrapped in `{ "value": ... }` and every component item wrapped in
`{ "properties": { ... } }`. Run `get_page` on an existing similar page
and copy the *exact* wrapped shape — don't try to infer from the UI's
JSON view.

If the call still fails, the response includes:
- `attemptedOverrides` (what you sent)
- `currentProperties` (what Optimizely currently has)
- `apiError.errors[]` (which fields failed and why)

Diff those three to find the wrapping difference.

## Hard-resetting cached data

If a content type changed in Optimizely and the cached template is
stale (you'll see `template_drift_detected` in the logs):

```
create_template { contentTypeName: "CompetitorComparisonPage", force: true }
```

The MCP also auto-detects drift on `create_page` and refreshes the
cached template before validating. So in practice you rarely need to
force-refresh manually — but the option's there.
