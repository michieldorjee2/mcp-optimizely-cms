---
title: Optimizely SaaS CMS data model — what lives where
updated: 2026-04-29
---

# Optimizely SaaS CMS data model

The single biggest source of bugs in this MCP has been getting confused about
**which fields live on which surface**. Optimizely splits a "page" across
several layers, and the API exposes them via different prefixes that return
different shapes for the same content key. This page is the cheat-sheet.

## The three layers

```
┌────────────────────────────────────────────────────┐
│ CONTENT (one per key)                              │
│  - key                                             │
│  - container (parent folder)                       │
│  - contentType[] (e.g. ["CompetitorComparisonPage",│
│      "_Page", "_Content"])                         │
│  - routeSegment ← lives here on SOME tenants;      │
│                   on others, it lives on the       │
│                   version (see below)              │
│  - locale                                          │
│  - status                                          │
│                                                    │
│ ┌──────────────────────────────────────────────┐   │
│ │ VERSION (many per content + locale)          │   │
│ │  - _metadata.version (numeric id)            │   │
│ │  - displayName                               │   │
│ │  - locale                                    │   │
│ │  - status (draft / ready / published / ...)  │   │
│ │  - properties { ...all your fields }         │   │
│ │  - routeSegment ← may also live here         │   │
│ └──────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────┘
```

Two things are true and not contradictory:

1. **Properties (the page's actual content) live on the version, not the
   content wrapper.** `GET /content/{key}` returns metadata; the displayName
   and the field values come from `GET /content/{key}/versions/{versionId}`.
2. **`routeSegment` is per-tenant.** On some Optimizely tenants it lives on
   the content; on others it lives on the version. We learned this the hard
   way — `update_page.ts` looks for it in both places.

## API surfaces

| Path prefix                | What it returns                                      | Used for                                           |
| -------------------------- | ---------------------------------------------------- | -------------------------------------------------- |
| `/preview3/experimental/`  | Stripped metadata (key, container, contentType)      | createContent, getContent, updateContent (PATCH)   |
| `/v1/`                     | Full metadata (incl. routeSegment on some tenants) + versions subresource + transitions | getContentV1, listVersions, createVersion, getVersion, patchVersion, publishVersion |
| `/preview3/contenttypes/`  | Content type definitions (schema only)               | getContentType, listContentTypes                   |
| `cg.optimizely.com/content/v2` (Graph) | Searchable indexed content                  | findContentByRoute, searchContent, introspectContentType |

The version + transition endpoints (`/versions`, `:publish`) DO NOT EXIST on
`/preview3/experimental/`. If you see a 404 from `/preview3/experimental/.../
versions`, that's the API saying "wrong surface" — try `/v1/`.

## Common workflows + where to look

### Update one property on a published page

The typical flow that update_page automates:

1. `GET /v1/content/{key}` for current routeSegment (and a fallback for
   displayName).
2. `GET /v1/content/{key}/versions?statuses=published&locales=...` to find
   the latest published version id.
3. `GET /v1/content/{key}/versions/{versionId}` to get displayName + the
   full property values.
4. Merge caller overrides into existing properties.
5. **Hash and short-circuit if no change.** (update_page does this.)
6. `POST /v1/content/{key}/versions` with `{ displayName, locale,
   routeSegment, properties }` — creates a new version. Body may be empty in
   the response; pull the new version id from the `Location: /v1/.../versions/{id}`
   header.
7. `POST /v1/content/{key}/versions/{newVersionId}:publish` to transition
   it. The body comes back empty on success; treat empty as `status:
   "published"`.
8. **Re-pin the routeSegment** by `PATCH /preview3/experimental/content/{key}`
   with `{ routeSegment }` — Optimizely auto-derives the slug from
   displayName on publish, so this is what stops the URL from silently
   drifting (e.g. `Amazon - AEM` → `/amazon---aem`).

### Find a page by slug

Optimizely's REST API doesn't expose a "lookup by slug" endpoint. Use
the Graph:

```graphql
{
  _Content(where: { _or: [
    { _metadata: { url: { default: { eq: "/amazon" } } } }
    { _metadata: { url: { default: { endsWith: "/amazon" } } } }
    { _metadata: { url: { default: { like: "%amazon" } } } }
  ] }) {
    items {
      _metadata {
        key
        displayName
        types
        locale
        url { default }
        ... on IInstanceMetadata { routeSegment }
      }
    }
  }
}
```

Notes:

- **`routeSegment` is on `IInstanceMetadata`, not the base
  `IContentMetadata`.** Filter on it via the inline fragment, not the
  top-level where.
- **`StringFilterInput` (regular strings) supports `like` with `%`
  wildcards but NOT `contains` or `match`.** Those operators only exist on
  `SearchableStringFilterInput` for full-text-indexed fields.
- The Graph only indexes published content. A draft you just created
  won't show up in slug search until it's published.

## Property value shapes

Component fields wrap values:

```json
{ "headline": { "value": "Hello" } }
```

Object arrays double-wrap (each item gets a properties block):

```json
{
  "comparisonTableRows": {
    "value": [
      { "properties": { "Category": { "value": "Speed" }, "OurValue": { "value": "Yes" } } }
    ]
  }
}
```

When in doubt, call `get_page` on a similar published page and copy the
shape verbatim. The schema returned alongside the values names every
field and its type but doesn't always make the wrapping convention
obvious.
