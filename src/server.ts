import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createPage } from "./tools/create-page";
import { updatePage } from "./tools/update-page";
import { listTemplatesHandler } from "./tools/list-templates";
import { createTemplate } from "./tools/create-template";
import type { CreatePageInput } from "./tools/create-page";
import type { UpdatePageInput } from "./tools/update-page";

export function createMcpServer() {
  const server = new McpServer({
    name: "optimizely-cms",
    version: "1.0.0",
  });

  server.tool(
    "create_page",
    "Create a new page or content item in Optimizely CMS. Requires a content type, display name, and properties. Will validate against saved templates if one exists for the content type.",
    {
      contentType: z.string().describe("The content type key (e.g. 'CompetitorComparisonPage')"),
      name: z.string().describe("Display name for the page"),
      locale: z.string().optional().describe("Content locale (default: 'en')"),
      parentId: z.string().optional().describe("Parent container content ID"),
      status: z.string().optional().describe("Content status: 'draft' or 'published'"),
      routeSegment: z.string().optional().describe("URL route segment for the page"),
      properties: z.any().optional().describe("Key-value map of content properties"),
    },
    async (params) => {
      const clientId = process.env.OPTIMIZELY_CMS_CLIENT_ID;
      const clientSecret = process.env.OPTIMIZELY_CMS_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "Missing CMS credentials: set OPTIMIZELY_CMS_CLIENT_ID and OPTIMIZELY_CMS_CLIENT_SECRET env vars" }) }],
        };
      }
      try {
        const input: CreatePageInput = {
          contentType: params.contentType,
          name: params.name,
          locale: params.locale ?? "en",
          parentId: params.parentId,
          status: params.status ?? "draft",
          routeSegment: params.routeSegment,
          properties: params.properties ?? {},
        };
        const result = await createPage(input, clientId, clientSecret);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: String(err) }) }] };
      }
    }
  );

  server.tool(
    "update_page",
    "Update an existing page or content item in Optimizely CMS. Fetches the current version for ETag concurrency, then applies a merge patch with the provided properties.",
    {
      contentId: z.string().describe("The content ID of the page to update"),
      locale: z.string().optional().describe("Content locale to update"),
      displayName: z.string().optional().describe("New display name"),
      routeSegment: z.string().optional().describe("New URL route segment"),
      status: z.string().optional().describe("New status: 'draft' or 'published'"),
      properties: z.any().optional().describe("Key-value map of properties to update"),
    },
    async (params) => {
      const clientId = process.env.OPTIMIZELY_CMS_CLIENT_ID;
      const clientSecret = process.env.OPTIMIZELY_CMS_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "Missing CMS credentials: set OPTIMIZELY_CMS_CLIENT_ID and OPTIMIZELY_CMS_CLIENT_SECRET env vars" }) }],
        };
      }
      try {
        const input: UpdatePageInput = {
          contentId: params.contentId,
          locale: params.locale,
          displayName: params.displayName,
          routeSegment: params.routeSegment,
          status: params.status,
          properties: params.properties ?? {},
        };
        const result = await updatePage(input, clientId, clientSecret);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: String(err) }) }] };
      }
    }
  );

  server.tool(
    "list_templates",
    "List all saved content type templates. Templates define the field structure and validation rules for page types. Returns field names, types, and requirements.",
    {
      filter: z.string().optional().describe("Optional filter string to match template names"),
    },
    async (params) => {
      try {
        const result = await listTemplatesHandler(params);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: String(err) }) }] };
      }
    }
  );

  server.tool(
    "create_template",
    "Create a template for a content type by introspecting its schema from Optimizely Graph. The template captures all fields, their types, and validation constraints for use with create_page.",
    {
      contentTypeName: z.string().describe("The name of a page/content type in Optimizely Graph (e.g. 'CompetitorComparisonPage')"),
    },
    async (params) => {
      const graphKey = process.env.OPTIMIZELY_GRAPH_KEY;
      if (!graphKey) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "Missing Graph API key: set OPTIMIZELY_GRAPH_KEY env var" }) }],
        };
      }
      try {
        const result = await createTemplate(params, graphKey);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: String(err) }) }] };
      }
    }
  );

  return server;
}
