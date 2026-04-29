---
title: mcp-optimizely-cms
aliases: [mcp-optimizely-cms]
type: mcp-server
product: optimizely-cms
status: active
stack: [typescript, node, nextjs, vercel, upstash-redis]
tags: [mcp, optimizely, cms, headless]
related:
  - "[[web-mcp/README]]"
  - "[[Notes/optimizely-abm-prompt]]"
  - "[[_MOCs/Optimizely Platform]]"
  - "[[_MOCs/MCP Servers]]"
updated: 2026-04-29
---

# mcp-optimizely-cms

MCP server for **Optimizely SaaS CMS** (headless). Exposes page and content
operations, content-type schemas, brand/logo data, and sitemap analysis to
LLM agents. Deployed to Vercel with Upstash Redis for caching, OAuth token
sharing across cold starts, and idempotency / rate-limit storage.

## Tools

- **`create_page`** — create new content with Zod-pre-validated properties.
  Auto-introspects the content type schema (no need to call create_template
  first). Optional `idempotencyKey` makes retries replay-safe.
- **`update_page`** — fork-then-publish flow with hash-based no-op detection,
  property merge (only fields you pass change), and routeSegment re-pinning
  so Optimizely's auto-slug-derive can't silently change the URL.
- **`get_page`** — resolve by `contentId`, `slug` (URL), or `search`
  (free-text). Returns identity + current values + lean schema in one call.
  Multi-match searches pick a primary and surface the rest as `alternatives`.
- **`list_page_templates` / `create_template`** — content-type schema
  cache. create_template stores a `schemaHash`; create_page detects drift
  and refreshes automatically.
- **`get_sitemap`** — fetch + analyse a website XML sitemap.
- **`get_logo` / `get_logo_svg` / `get_brand`** — Brandfetch wrappers.

## Resources

- `optimizely://templates` — index of cached content-type templates.
- `optimizely://templates/{name}` — full schema for one content type.

## Prompts

- `edit_page_section` — guides the agent through get_page → update_page.
- `create_competitor_page` — get_brand → list_page_templates → create_page.

## Setup

```bash
npm install
npm run dev
```

Required environment variables (see [src/services/env.ts](src/services/env.ts)
for the full Zod contract):

| Var | Required? | Purpose |
| --- | --- | --- |
| `OPTIMIZELY_CMS_CLIENT_ID` | yes | OAuth client id |
| `OPTIMIZELY_CMS_CLIENT_SECRET` | yes | OAuth client secret |
| `OPTIMIZELY_GRAPH_KEY` | optional | Graph (Content Cloud) key — enables get_page slug/search |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | optional | Upstash Redis — token cache, idempotency, rate limit, drift detection |
| `BRANDFETCH_API_KEY` | optional | Brandfetch — get_brand / get_logo |
| `MCP_AUTH_SECRET` | optional | HMAC for the OAuth shim |
| `DEFAULT_PARENT_ID` | optional | Override the site root container id |
| `SENTRY_DSN` | optional | Error reporting |
| `LOG_LEVEL` | optional | `debug` / `info` / `warn` / `error` |

## Operational endpoints

- **`/health`** — liveness + readiness probe. Returns env config status,
  CMS auth status, Redis connectivity, deployed git sha. Hook this up as
  the TMS heartbeat URL.
- **`/mcp`** — MCP JSON-RPC endpoint. POST with the standard MCP
  Streamable-HTTP envelope. Per-request traceId on the `X-Trace-Id`
  response header.

## Documentation

- [Optimizely data model — what lives where](docs/optimizely-data-model.md) —
  the cheat sheet for which fields live on the content vs the version vs
  IInstanceMetadata, and which API surface to hit for what.
- [Debugging guide](docs/debugging.md) — common failures and how to
  triage them, including "all my tools 404", routeSegment drift, and
  the property-shape wrapping convention.

## Development

```bash
npm run typecheck     # tsc --noEmit (strict)
npm run lint          # eslint
npm run format        # prettier --write
npm run format:check  # prettier --check (CI gate)
npm test              # vitest
```

The CI pipeline (`.github/workflows/ci.yml`) gates every PR on
typecheck + lint + format + tests, and is wired to run a smoke test
against the Vercel preview deployment once a `VERCEL_TOKEN` secret is
configured.

## Architecture notes

- Stateless MCP transport — `api/mcp.ts` creates a fresh server per
  request. Suits Vercel serverless; works around no in-process session
  state.
- Two-layer OAuth token cache. Process-local `Map` for warm-instance
  hits; Upstash Redis with TTL for shared cache across cold starts.
- Typed error hierarchy (`CmsApiError`, `CmsAuthError`, `CmsNotFoundError`,
  `CmsValidationError`, `LocalValidationError`) — every helper throws
  one of these; tools serialise via `errorToResponse`. No more
  string-parsing of error messages.
- Retry with exponential backoff + full jitter, only on 408/429/5xx
  + network errors. Auth/notfound/validation never retry.
- Zod runtime validation of every Optimizely API response. Type
  assertions (`as`) only used for narrowing within validated bodies.

## Paired with

- [[Notes/optimizely-abm-prompt|ABM Prompt]] — the prompt flow that drives
  this server to write `CompetitorComparisonPage` content for target
  accounts.

## Related

- [[_MOCs/Optimizely Platform]]
- [[_MOCs/MCP Servers]]
