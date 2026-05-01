import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createPageSchema, createPage } from "./tools/create-page.js";
import { updatePageSchema, updatePage } from "./tools/update-page.js";
import { listTemplatesSchema, listTemplatesHandler } from "./tools/list-templates.js";
import { createTemplateSchema, createTemplate } from "./tools/create-template.js";
import { getPageSchema, getPage } from "./tools/get-page.js";
import { getSitemapSchema, getSitemap } from "./tools/get-sitemap.js";
import {
  getLogoSchema,
  getLogo,
  getBrandSchema,
  getBrand,
  getLogoSvgSchema,
  getLogoSvg,
} from "./tools/brand.js";
import { withToolLogging } from "./services/log.js";
import { errorToResponse } from "./services/errors.js";

export interface CreateServerOptions {
  /**
   * Per-request trace id, generated in api/mcp.ts. Threaded into every
   * tool handler so error responses can include it (the agent can quote
   * the traceId when reporting an issue, and we can grep Vercel logs by
   * it). Optional for unit tests / local invocation.
   */
  traceId?: string;
}

export function createMcpServer(opts: CreateServerOptions = {}) {
  const traceId = opts.traceId;
  const server = new McpServer({
    name: "optimizely-cms",
    version: "1.0.0",
  });

  server.tool(
    "create_page",
    [
      "Create a NEW page or content item in Optimizely CMS.",
      "",
      "When to use:",
      "- The page does not exist yet. To change an existing page, use update_page.",
      "",
      "What it does:",
      "- Auto-introspects the content type's schema (no need to call create_template first).",
      "- AUTO-NORMALIZES propertiesJson: you can pass values flat ({\"headline\": \"Hi\"}) or already wrapped ({\"headline\": {\"value\": \"Hi\"}}) and the tool emits the canonical CMS shape. Component arrays accept flat items or pre-shaped {properties: …} items. Content references stay as raw string ids. Coercions are reported under `normalizationNotes` so you can learn the canonical shape.",
      "- Validates propertiesJson against required fields, length and array bounds, enum values, and pattern constraints BEFORE calling Optimizely, so shape errors come back as a structured validation report instead of a raw API 400.",
      "- On a CMS-side shape error, decodes Optimizely's cryptic .NET deserialization messages (\"Cannot get the value of a token type 'StartObject' as a string\") into per-field `shapeHints` that name the property, the expected wrapping, and what was sent.",
      "- Creates the page directly in published state by default; pass status='draft' to stage.",
      "",
      "Returns: { success, contentId, displayName, contentType, status }. Pass contentId to update_page or get_page next.",
    ].join("\n"),
    {
      contentType: createPageSchema.shape.contentType,
      name: createPageSchema.shape.name,
      locale: createPageSchema.shape.locale,
      parentId: createPageSchema.shape.parentId,
      status: createPageSchema.shape.status,
      routeSegment: createPageSchema.shape.routeSegment,
      propertiesJson: createPageSchema.shape.propertiesJson,
      idempotencyKey: createPageSchema.shape.idempotencyKey,
    },
    async (params) => {
      const clientId = process.env.OPTIMIZELY_CMS_CLIENT_ID;
      const clientSecret = process.env.OPTIMIZELY_CMS_CLIENT_SECRET;
      const graphKey = process.env.OPTIMIZELY_GRAPH_KEY;
      if (!clientId || !clientSecret) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Missing CMS credentials" }) }] };
      }
      try {
        const result = await withToolLogging(
          { tool: "create_page", traceId, params },
          () => createPage(params, clientId, clientSecret, graphKey)
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const errTrace = (err as Error & { traceId?: string }).traceId ?? traceId;
        // Pull the structured shape (status, endpoint, apiError body,
        // fieldErrors) instead of stringifying the error — otherwise a
        // CmsValidationError comes back as just "Validation failed." with
        // no useful detail for the agent or for log analysis.
        const parsed = errorToResponse(err);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                ...parsed,
                ...(errTrace ? { _traceId: errTrace } : {}),
              }),
            },
          ],
        };
      }
    }
  );

  server.tool(
    "update_page",
    [
      "Update an EXISTING page in Optimizely CMS, optionally publishing the change in the same call.",
      "",
      "When to use:",
      "- You already have a contentId (from create_page, get_page, or saved earlier) and want to change one or more property values, the displayName, the slug, or republish the page.",
      "- For brand-new content, use create_page instead.",
      "",
      "What it does (single tool call, multiple API calls under the hood):",
      "1. Reads the current routeSegment off the content wrapper so the slug can be re-pinned at the end (Optimizely otherwise auto-derives the slug from displayName on publish, silently changing the URL — this tool prevents that drift).",
      "2. Finds the latest published version (or any version if none are published).",
      "3. Forks a new version, with the caller's property overrides merged into the current property set — keys you don't pass keep their existing values.",
      "4. Publishes the new version unless status='draft' was passed.",
      "5. Re-pins routeSegment back to the desired value (caller's override or the prior slug).",
      "",
      "Property overrides are AUTO-NORMALIZED: pass values flat ({\"headline\": \"Hi\"}) or already wrapped ({\"headline\": {\"value\": \"Hi\"}}) — the tool emits the canonical CMS shape. Coercions are reported under `normalizationNotes`.",
      "",
      "On error, the response includes the failed stage, the parsed Optimizely error, the attempted overrides, the current properties, and per-field `shapeHints` decoded from Optimizely's cryptic .NET deserialization messages — so a shape mismatch on a single field (e.g. an `analystCards` component) is debuggable in one glance.",
      "",
      "Returns: { success, contentId, baseVersionId, versionId, status, published, routeSegment, routeSegmentRepinned, updatedFields, ... }.",
    ].join("\n"),
    {
      contentId: updatePageSchema.shape.contentId,
      locale: updatePageSchema.shape.locale,
      displayName: updatePageSchema.shape.displayName,
      routeSegment: updatePageSchema.shape.routeSegment,
      status: updatePageSchema.shape.status,
      propertiesJson: updatePageSchema.shape.propertiesJson,
    },
    async (params) => {
      const clientId = process.env.OPTIMIZELY_CMS_CLIENT_ID;
      const clientSecret = process.env.OPTIMIZELY_CMS_CLIENT_SECRET;
      const graphKey = process.env.OPTIMIZELY_GRAPH_KEY;
      if (!clientId || !clientSecret) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Missing CMS credentials" }) }] };
      }
      try {
        const result = await withToolLogging(
          { tool: "update_page", traceId, params },
          () => updatePage(params, clientId, clientSecret, graphKey)
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const errTrace = (err as Error & { traceId?: string }).traceId ?? traceId;
        // Pull the structured shape (status, endpoint, apiError body,
        // fieldErrors) instead of stringifying the error — otherwise a
        // CmsValidationError comes back as just "Validation failed." with
        // no useful detail for the agent or for log analysis.
        const parsed = errorToResponse(err);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                ...parsed,
                ...(errTrace ? { _traceId: errTrace } : {}),
              }),
            },
          ],
        };
      }
    }
  );

  server.tool(
    "get_page",
    [
      "Look up a page in Optimizely CMS and return its current values + property schema in one call.",
      "",
      "When to use:",
      "- Before calling update_page, to see what fields exist, what shape each expects, and what each currently holds — so the update can be planned without extra Graph round-trips.",
      "- To resolve a contentId from a human-friendly slug or display-name search.",
      "- To inspect a page's current state without making changes.",
      "",
      "Resolution priority: contentId > slug > search.",
      "- contentId: direct fetch, no Graph call.",
      "- slug: Graph lookup against url.default with eq / endsWith / like wildcards.",
      "- search: Graph substring match across displayName + URL.",
      "",
      "If a slug/search resolves to multiple pages, the tool picks the best primary match (exact slug/displayName equality first, then prefix match, then shortest URL) and surfaces the other candidates as `alternatives` in the response so the caller can re-call with contentId if our pick is wrong.",
      "",
      "Response is compact JSON (no pretty-print) with a lean schema by default — see the verbose flag if you want the full template-style schema with examples and descriptions.",
      "",
      "Cheap existence check: pass existsOnly=true to get just { exists: true|false, contentId?, displayName?, url? } without fetching versions, properties, or schema. Useful for 'do we already have a page for this company?' lookups that would otherwise bloat the context with the full page payload.",
    ].join("\n"),
    {
      contentId: getPageSchema.shape.contentId,
      slug: getPageSchema.shape.slug,
      search: getPageSchema.shape.search,
      locale: getPageSchema.shape.locale,
      includeSchema: getPageSchema.shape.includeSchema,
      verbose: getPageSchema.shape.verbose,
      existsOnly: getPageSchema.shape.existsOnly,
    },
    async (params) => {
      const clientId = process.env.OPTIMIZELY_CMS_CLIENT_ID;
      const clientSecret = process.env.OPTIMIZELY_CMS_CLIENT_SECRET;
      const graphKey = process.env.OPTIMIZELY_GRAPH_KEY;
      if (!clientId || !clientSecret) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Missing CMS credentials" }) }] };
      }
      try {
        const result = await withToolLogging(
          { tool: "get_page", traceId, params },
          () => getPage(params, clientId, clientSecret, graphKey)
        );
        // Compact JSON (no pretty-print): saves ~25-35% tokens on large
        // page payloads compared to JSON.stringify(result, null, 2). The
        // agent reads it just fine.
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err) {
        const errTrace = (err as Error & { traceId?: string }).traceId ?? traceId;
        // Pull the structured shape (status, endpoint, apiError body,
        // fieldErrors) instead of stringifying the error — otherwise a
        // CmsValidationError comes back as just "Validation failed." with
        // no useful detail for the agent or for log analysis.
        const parsed = errorToResponse(err);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                ...parsed,
                ...(errTrace ? { _traceId: errTrace } : {}),
              }),
            },
          ],
        };
      }
    }
  );

  server.tool(
    "list_page_templates",
    [
      "List cached Optimizely CMS content-type templates — flat per-type schemas built from the CMS Content Types API + Graph introspection.",
      "",
      "(Renamed from list_templates to avoid collision with another tool of the same name in the host environment's registry.)",
      "",
      "When to use:",
      "- Before create_page, to see what content types are available and what properties each needs.",
      "- To check whether a template is already cached before forcing a fresh create_template.",
      "",
      "Each template entry includes: name, contentType, propertyCount, properties (array of { key, label, type, required, description, example, validation constraints, itemShape for object arrays, allowedTypes for content references }), contentReferences (which fields need separate content IDs to point at), submissionExample (a single ready-to-paste propertiesJson skeleton with every required field populated in the exact wrapped CMS shape), and createdAt.",
      "",
      "Note: get_page on a specific page returns the same schema shape inline alongside the page's current values — use that for a per-page workflow. list_page_templates is for surveying content types globally.",
    ].join("\n"),
    {
      filter: listTemplatesSchema.shape.filter,
    },
    async (params) => {
      try {
        const result = await withToolLogging(
          { tool: "list_page_templates", traceId, params },
          () => listTemplatesHandler(params)
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const errTrace = (err as Error & { traceId?: string }).traceId ?? traceId;
        // Pull the structured shape (status, endpoint, apiError body,
        // fieldErrors) instead of stringifying the error — otherwise a
        // CmsValidationError comes back as just "Validation failed." with
        // no useful detail for the agent or for log analysis.
        const parsed = errorToResponse(err);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                ...parsed,
                ...(errTrace ? { _traceId: errTrace } : {}),
              }),
            },
          ],
        };
      }
    }
  );

  server.tool(
    "create_template",
    [
      "Build a flat, LLM-friendly template for a single content type and cache it in the template store.",
      "",
      "When to use:",
      "- Rarely needed — create_page auto-introspects on demand. Use this when you want to inspect a content type's schema without creating a page, or pre-warm the cache.",
      "- Pass force=true to refresh after a content-type change in the CMS UI.",
      "",
      "What it does:",
      "- Pulls the content type definition from the CMS REST API (validation rules: required, min/max length, min/max items, patterns, enums, allowed content types).",
      "- For object/component sub-types, introspects via Graph to surface the inner field shape.",
      "- Saves the result keyed by content type name; list_page_templates shows what's cached.",
      "",
      "Returns: { success, template: { name, contentType, propertyCount, properties, contentReferences, submissionExample, createdAt } }. submissionExample is a paste-and-fill propertiesJson skeleton — copy it, replace example values with your own, and pass to create_page.",
    ].join("\n"),
    {
      contentTypeName: createTemplateSchema.shape.contentTypeName,
      force: createTemplateSchema.shape.force,
    },
    async (params) => {
      const graphKey = process.env.OPTIMIZELY_GRAPH_KEY;
      const clientId = process.env.OPTIMIZELY_CMS_CLIENT_ID;
      const clientSecret = process.env.OPTIMIZELY_CMS_CLIENT_SECRET;
      if (!graphKey) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Missing Graph API key" }) }] };
      }
      if (!clientId || !clientSecret) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Missing CMS credentials" }) }] };
      }
      try {
        const result = await withToolLogging(
          { tool: "create_template", traceId, params },
          () => createTemplate(params, graphKey, clientId, clientSecret)
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const errTrace = (err as Error & { traceId?: string }).traceId ?? traceId;
        // Pull the structured shape (status, endpoint, apiError body,
        // fieldErrors) instead of stringifying the error — otherwise a
        // CmsValidationError comes back as just "Validation failed." with
        // no useful detail for the agent or for log analysis.
        const parsed = errorToResponse(err);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                ...parsed,
                ...(errTrace ? { _traceId: errTrace } : {}),
              }),
            },
          ],
        };
      }
    }
  );

  server.tool(
    "get_sitemap",
    [
      "Fetch and analyze a website's XML sitemap (or sitemap index) to understand its size, structure, and freshness.",
      "",
      "When to use:",
      "- Before building competitor or research pages, to see what topics/sections a site publishes and how big it is.",
      "- To get URL counts broken down by language, path segment, or change frequency.",
      "- Follows sitemap-index files recursively up to max_sitemaps.",
      "",
      "Returns: total URL count, estimated unique content pages (excluding localized variants), URLs grouped by language and by top-level path, hreflang languages declared, lastmod freshness buckets, and changefreq/priority distributions.",
    ].join("\n"),
    {
      url: getSitemapSchema.shape.url,
      follow_index: getSitemapSchema.shape.follow_index,
      max_sitemaps: getSitemapSchema.shape.max_sitemaps,
    },
    async (params) => {
      try {
        const result = await withToolLogging(
          { tool: "get_sitemap", traceId, params },
          () => getSitemap(params)
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const errTrace = (err as Error & { traceId?: string }).traceId ?? traceId;
        // Pull the structured shape (status, endpoint, apiError body,
        // fieldErrors) instead of stringifying the error — otherwise a
        // CmsValidationError comes back as just "Validation failed." with
        // no useful detail for the agent or for log analysis.
        const parsed = errorToResponse(err);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                ...parsed,
                ...(errTrace ? { _traceId: errTrace } : {}),
              }),
            },
          ],
        };
      }
    }
  );

  server.tool(
    "get_logo",
    [
      "Get a brand's logo URL by domain via Brandfetch.",
      "",
      "When to use:",
      "- You need a logo image URL (SVG or PNG) for embedding in CMS content — e.g. setting customerLogo on a competitor comparison page.",
      "- Pick the right type: 'icon' (favicon-style square), 'logo' (full lockup), 'symbol' (mark only).",
      "- Pick theme 'light' for use on dark backgrounds, 'dark' for light backgrounds.",
      "",
      "Returns: { url, format, type, theme } where url is the best matching asset.",
    ].join("\n"),
    {
      domain: getLogoSchema.shape.domain,
      theme: getLogoSchema.shape.theme,
      type: getLogoSchema.shape.type,
      fallback: getLogoSchema.shape.fallback,
      w: getLogoSchema.shape.w,
      h: getLogoSchema.shape.h,
    },
    async (params) => {
      try {
        const result = await withToolLogging(
          { tool: "get_logo", traceId, params },
          async () => getLogo(params)
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const errTrace = (err as Error & { traceId?: string }).traceId ?? traceId;
        // Pull the structured shape (status, endpoint, apiError body,
        // fieldErrors) instead of stringifying the error — otherwise a
        // CmsValidationError comes back as just "Validation failed." with
        // no useful detail for the agent or for log analysis.
        const parsed = errorToResponse(err);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                ...parsed,
                ...(errTrace ? { _traceId: errTrace } : {}),
              }),
            },
          ],
        };
      }
    }
  );

  server.tool(
    "get_logo_svg",
    [
      "Get a brand's logo as raw SVG markup (not just a URL).",
      "",
      "When to use:",
      "- You need to embed the logo as inline SVG in a page — e.g. for color-tinting via CSS, or inlining without a separate fetch.",
      "- If Brandfetch has a native SVG, returns that directly. Otherwise traces the PNG to SVG via vtracer.",
      "",
      "Returns: { svg, source: 'brandfetch' | 'traced' } where svg is the raw <svg>... markup.",
    ].join("\n"),
    {
      domain: getLogoSvgSchema.shape.domain,
      theme: getLogoSvgSchema.shape.theme,
      type: getLogoSvgSchema.shape.type,
    },
    async (params) => {
      try {
        const result = await withToolLogging(
          { tool: "get_logo_svg", traceId, params },
          () => getLogoSvg(params)
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const errTrace = (err as Error & { traceId?: string }).traceId ?? traceId;
        // Pull the structured shape (status, endpoint, apiError body,
        // fieldErrors) instead of stringifying the error — otherwise a
        // CmsValidationError comes back as just "Validation failed." with
        // no useful detail for the agent or for log analysis.
        const parsed = errorToResponse(err);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                ...parsed,
                ...(errTrace ? { _traceId: errTrace } : {}),
              }),
            },
          ],
        };
      }
    }
  );

  server.tool(
    "get_brand",
    [
      "Get comprehensive brand data for a domain via Brandfetch: logos in every type/format, brand colors, fonts, company info, social links, and stock imagery.",
      "",
      "When to use:",
      "- Building a branded page (e.g. competitor comparison, customer landing) and you want one call that gives you everything: logo URL + accent color + brand fonts.",
      "- Use this instead of multiple get_logo + get_brand_color calls.",
      "",
      "Returns the full Brandfetch payload including arrays of logos, colors with hex values, fonts with names, social links, and company description.",
    ].join("\n"),
    {
      domain: getBrandSchema.shape.domain,
    },
    async (params) => {
      try {
        const result = await withToolLogging(
          { tool: "get_brand", traceId, params },
          () => getBrand(params)
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const errTrace = (err as Error & { traceId?: string }).traceId ?? traceId;
        // Pull the structured shape (status, endpoint, apiError body,
        // fieldErrors) instead of stringifying the error — otherwise a
        // CmsValidationError comes back as just "Validation failed." with
        // no useful detail for the agent or for log analysis.
        const parsed = errorToResponse(err);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                ...parsed,
                ...(errTrace ? { _traceId: errTrace } : {}),
              }),
            },
          ],
        };
      }
    }
  );

  // ---------------------------------------------------------------------
  // MCP resources
  //
  // Resources let clients enumerate readable content without invoking a
  // tool — discoverable, paginated, cacheable. Saves round-trips for
  // anything that's "list and inspect" rather than "act".
  //
  // We expose:
  //   optimizely://templates         → list of cached content-type templates
  //   optimizely://templates/{name}  → one template's full schema
  //
  // Pages aren't resources because there can be thousands of them and
  // listing all is wasteful — get_page handles that lookup-style access.
  // ---------------------------------------------------------------------

  server.resource(
    "templates-index",
    "optimizely://templates",
    {
      description:
        "List of every Optimizely content type whose schema has been cached. Read this to discover what types are available without invoking list_page_templates.",
      mimeType: "application/json",
    },
    async () => {
      const { listTemplates } = await import("./services/template-store.js");
      const templates = await listTemplates();
      return {
        contents: [
          {
            uri: "optimizely://templates",
            mimeType: "application/json",
            text: JSON.stringify(
              templates.map((t) => ({
                name: t.name,
                contentType: t.contentType,
                propertyCount: t.properties.length,
                createdAt: t.createdAt,
              })),
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Per-template resource template — clients enumerate via the index above
  // and resolve URIs of the form optimizely://templates/{name}. The
  // ResourceTemplate handles URI parsing and passes the resolved variable
  // to the read callback.
  server.resource(
    "template-detail",
    new ResourceTemplate("optimizely://templates/{name}", { list: undefined }),
    {
      description:
        "Full schema for one content type. URI: optimizely://templates/{name} where {name} matches the contentType key (e.g. 'CompetitorComparisonPage').",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const rawName = variables.name;
      const name = Array.isArray(rawName) ? rawName[0] : rawName;
      if (!name) {
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: "application/json",
              text: JSON.stringify({ error: "Invalid template URI — missing {name}." }),
            },
          ],
        };
      }
      const { getTemplate } = await import("./services/template-store.js");
      const template = await getTemplate(decodeURIComponent(name));
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "application/json",
            text: template
              ? JSON.stringify(template, null, 2)
              : JSON.stringify({ error: `Template '${name}' not found. Run create_template first.` }),
          },
        ],
      };
    }
  );

  // ---------------------------------------------------------------------
  // MCP prompts — pre-canned conversational templates clients can offer
  // as slash-commands or quick-actions. Each takes structured args; the
  // returned messages guide the agent to follow the right tool sequence
  // without re-deriving the workflow from scratch.
  // ---------------------------------------------------------------------

  server.prompt(
    "edit_page_section",
    "Update one section of an existing Optimizely page — guides the agent to fetch the current shape with get_page, then call update_page with the right wrapping.",
    {
      slug: getPageSchema.shape.slug as never,
      field: getPageSchema.shape.search as never,
    },
    (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `I want to edit the ${args.field ?? "<field>"} on the page at slug '${args.slug ?? "<slug>"}'.`,
              "",
              "Please:",
              "1. Call get_page with the slug to fetch the current values + property schema.",
              "2. Inspect the existing value of the target field in `properties` so you copy the exact wrapping shape (Optimizely components are nested {value: …} or {properties: {…}}).",
              "3. Build the new value in the same shape and call update_page with propertiesJson containing only that one field. Leave status default ('published') unless I ask for a draft.",
              "4. Confirm the change by reporting back the new versionId and routeSegment.",
            ].join("\n"),
          },
        },
      ],
    })
  );

  server.prompt(
    "create_competitor_page",
    "Create a new competitor-comparison page from a brand domain — coordinates get_brand → create_page with sensible defaults.",
    {
      brand_domain: getBrandSchema.shape.domain as never,
      competitor_name: createPageSchema.shape.name as never,
    },
    (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Create a new CompetitorComparisonPage comparing Optimizely against ${args.competitor_name ?? "<competitor>"}, branded for ${args.brand_domain ?? "<brand domain>"}.`,
              "",
              "Steps:",
              "1. Call get_brand for the brand domain to grab the customer's logo URL, accent color, and font.",
              "2. Call list_page_templates (filter='CompetitorComparisonPage') to get the property schema.",
              "3. Build propertiesJson using example values from the template, populated with brand-appropriate copy and the customer's actual values.",
              "4. Call create_page with status='published' and an idempotencyKey of `competitor-${brand_domain}-${competitor_name}` to make the create replay-safe.",
              "5. Report back the contentId and the live URL.",
            ].join("\n"),
          },
        },
      ],
    })
  );

  return server;
}
