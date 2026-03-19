import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createPageSchema, createPage } from "./tools/create-page";
import { updatePageSchema, updatePage } from "./tools/update-page";
import { listTemplatesSchema, listTemplatesHandler } from "./tools/list-templates";
import { createTemplateSchema, createTemplate } from "./tools/create-template";

export function createMcpServer() {
  const server = new McpServer({
    name: "optimizely-cms",
    version: "1.0.0",
  });

  server.tool(
    "create_page",
    "Create a new page or content item in Optimizely CMS. Requires a content type, display name, and properties. Will validate against saved templates if one exists for the content type.",
    {
      contentType: createPageSchema.shape.contentType,
      name: createPageSchema.shape.name,
      locale: createPageSchema.shape.locale,
      parentId: createPageSchema.shape.parentId,
      status: createPageSchema.shape.status,
      routeSegment: createPageSchema.shape.routeSegment,
      properties: createPageSchema.shape.properties,
    },
    async (params) => {
      const clientId = process.env.OPTIMIZELY_CMS_CLIENT_ID;
      const clientSecret = process.env.OPTIMIZELY_CMS_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Missing CMS credentials: set OPTIMIZELY_CMS_CLIENT_ID and OPTIMIZELY_CMS_CLIENT_SECRET env vars" }) }],
        };
      }
      try {
        const result = await createPage(params, clientId, clientSecret);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }] };
      }
    }
  );

  server.tool(
    "update_page",
    "Update an existing page or content item in Optimizely CMS. Fetches the current version for ETag concurrency, then applies a merge patch with the provided properties.",
    {
      contentId: updatePageSchema.shape.contentId,
      locale: updatePageSchema.shape.locale,
      displayName: updatePageSchema.shape.displayName,
      routeSegment: updatePageSchema.shape.routeSegment,
      status: updatePageSchema.shape.status,
      properties: updatePageSchema.shape.properties,
    },
    async (params) => {
      const clientId = process.env.OPTIMIZELY_CMS_CLIENT_ID;
      const clientSecret = process.env.OPTIMIZELY_CMS_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Missing CMS credentials: set OPTIMIZELY_CMS_CLIENT_ID and OPTIMIZELY_CMS_CLIENT_SECRET env vars" }) }],
        };
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
    "list_templates",
    "List all saved content type templates. Templates define the field structure and validation rules for page types. Returns field names, types, and requirements.",
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
    "Create a template for a content type by introspecting its schema from Optimizely Graph. The template captures all fields, their types, and validation constraints for use with create_page.",
    {
      contentTypeName: createTemplateSchema.shape.contentTypeName,
    },
    async (params) => {
      const graphKey = process.env.OPTIMIZELY_GRAPH_KEY;
      if (!graphKey) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Missing Graph API key: set OPTIMIZELY_GRAPH_KEY env var" }) }],
        };
      }
      try {
        const result = await createTemplate(params, graphKey);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }] };
      }
    }
  );

  return server;
}
