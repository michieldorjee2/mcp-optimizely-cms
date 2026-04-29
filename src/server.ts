import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

export function createMcpServer() {
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
      "- Validates propertiesJson against required fields, length and array bounds, enum values, and pattern constraints BEFORE calling Optimizely, so shape errors come back as a structured validation report instead of a raw API 400.",
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
    },
    async (params) => {
      const clientId = process.env.OPTIMIZELY_CMS_CLIENT_ID;
      const clientSecret = process.env.OPTIMIZELY_CMS_CLIENT_SECRET;
      const graphKey = process.env.OPTIMIZELY_GRAPH_KEY;
      if (!clientId || !clientSecret) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Missing CMS credentials" }) }] };
      }
      try {
        const result = await createPage(params, clientId, clientSecret, graphKey);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }] };
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
      "On error, the response includes the failed stage, the parsed Optimizely error, the attempted overrides, and the current properties — so a shape mismatch on a single field (e.g. an `analystCards` component) is debuggable in one glance.",
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
      if (!clientId || !clientSecret) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Missing CMS credentials" }) }] };
      }
      try {
        const result = await updatePage(params, clientId, clientSecret);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }] };
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
      "If a slug/search resolves to multiple pages, returns { ambiguous: true, matches: [...] } so the caller can pick one and re-call with contentId.",
      "",
      "Response is compact JSON (no pretty-print) with a lean schema by default — see the verbose flag if you want the full template-style schema with examples and descriptions.",
    ].join("\n"),
    {
      contentId: getPageSchema.shape.contentId,
      slug: getPageSchema.shape.slug,
      search: getPageSchema.shape.search,
      locale: getPageSchema.shape.locale,
      includeSchema: getPageSchema.shape.includeSchema,
      verbose: getPageSchema.shape.verbose,
    },
    async (params) => {
      const clientId = process.env.OPTIMIZELY_CMS_CLIENT_ID;
      const clientSecret = process.env.OPTIMIZELY_CMS_CLIENT_SECRET;
      const graphKey = process.env.OPTIMIZELY_GRAPH_KEY;
      if (!clientId || !clientSecret) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Missing CMS credentials" }) }] };
      }
      try {
        const result = await getPage(params, clientId, clientSecret, graphKey);
        // Compact JSON (no pretty-print): saves ~25-35% tokens on large
        // page payloads compared to JSON.stringify(result, null, 2). The
        // agent reads it just fine.
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }] };
      }
    }
  );

  server.tool(
    "list_templates",
    [
      "List cached content-type templates — flat per-type schemas built from the CMS Content Types API + Graph introspection.",
      "",
      "When to use:",
      "- Before create_page, to see what content types are available and what properties each needs.",
      "- To check whether a template is already cached before forcing a fresh create_template.",
      "",
      "Each template entry includes: name, contentType, propertyCount, properties (array of { key, label, type, required, description, example, validation constraints, itemShape for object arrays, allowedTypes for content references }), contentReferences (which fields need separate content IDs to point at), and createdAt.",
      "",
      "Note: get_page on a specific page returns the same schema shape inline alongside the page's current values — use that for a per-page workflow. list_templates is for surveying content types globally.",
    ].join("\n"),
    {
      filter: listTemplatesSchema.shape.filter,
    },
    async (params) => {
      try {
        const result = await listTemplatesHandler(params);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }] };
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
      "- Saves the result keyed by content type name; list_templates shows what's cached.",
      "",
      "Returns: { success, template: { name, contentType, propertyCount, properties, contentReferences, createdAt } }.",
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
        const result = await createTemplate(params, graphKey, clientId, clientSecret);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }] };
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
        const result = await getSitemap(params);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }] };
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
        const result = await getLogo(params);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }] };
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
        const result = await getLogoSvg(params);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }] };
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
        const result = await getBrand(params);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }] };
      }
    }
  );

  return server;
}
