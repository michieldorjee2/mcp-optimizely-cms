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

MCP server for **Optimizely SaaS CMS** (headless). Exposes page and content operations, brand data retrieval, sitemap inspection, and content-type management. Deployed to Vercel with Upstash Redis for caching.

## Key capabilities

- Create / update pages and templates
- Fetch brand info, logos, sitemap
- List and manage templates

## Paired with

- [[Notes/optimizely-abm-prompt|ABM Prompt]] — the prompt flow that drives this server to write `CompetitorComparisonPage` content for target accounts.

## Setup

```bash
npm install
npm run dev
```

Requires Optimizely CMS API token + Upstash Redis credentials in env.

## Related

- [[_MOCs/Optimizely Platform]]
- [[_MOCs/MCP Servers]]
