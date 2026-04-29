import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createPageSchema, createPage } from "./tools/create-page.js";
import { updatePageSchema, updatePage } from "./tools/update-page.js";
import { listTemplatesSchema, listTemplatesHandler } from "./tools/list-templates.js";
import { createTemplateSchema, createTemplate } from "./tools/create-template.js";
import { getPageSchema, getPage } from "./tools/get-page.js";

export function createMcpServer() {
  const server = new McpServer({
    name: "optimizely-cms",
    version: "1.0.0",
  });

  server.tool(
    "create_page",
    "Create a new page or content item in Optimizely CMS. Requires a content type, display name, and propertiesJson (a JSON string). Will auto-introspect and validate against the content type schema — no need to call create_template first.",
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
    "Update an existing page or content item in Optimizely CMS. Fetches the current version for ETag concurrency, then applies a merge patch with the provided propertiesJson (a JSON string).",
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
    "Look up a page in Optimizely CMS by contentId, slug (URL route), or free-text search, and return its current values + property schema. Use this before update_page to see what fields exist, what shape they expect, and what they currently hold — so updates can be built in a single round-trip without separate Graph queries.",
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
    "List all saved content type templates. Each template has a flat list of properties with keys, types, examples, and whether they're required. Use this before create_page to see what properties a content type needs.",
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
    "Create a flat, LLM-friendly template for a content type using the CMS content types API. Returns properties with accurate required flags, validation constraints (min/max items, string lengths), and example values ready for create_page. Use force=true to overwrite.",
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

  return server;
}
