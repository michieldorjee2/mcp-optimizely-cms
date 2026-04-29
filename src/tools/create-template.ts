import { z } from "zod";
import { getContentType } from "../services/cms-api.js";
import { saveTemplate, getTemplate, deleteTemplate } from "../services/template-store.js";
import { buildPropertiesFromContentType } from "../services/template-builder.js";
import type { Template } from "../types.js";

export const createTemplateSchema = z.object({
  contentTypeName: z.string().describe("The name of a page/content type in Optimizely CMS (e.g. 'CompetitorComparisonPage')"),
  force: z.boolean().optional().default(false).describe("If true, overwrite existing template"),
});

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

export async function createTemplate(
  input: CreateTemplateInput,
  graphKey: string,
  clientId: string,
  clientSecret: string
) {
  const existing = await getTemplate(input.contentTypeName).catch(() => null);
  if (existing && !input.force) {
    return {
      success: false,
      error: `Template '${input.contentTypeName}' already exists. Use force=true to overwrite.`,
      existing: {
        name: existing.name,
        propertyCount: existing.properties.length,
        createdAt: existing.createdAt,
      },
    };
  }

  if (existing && input.force) {
    await deleteTemplate(input.contentTypeName).catch(() => {});
  }

  // Fetch content type definition from CMS REST API (has accurate validation rules)
  const contentType = await getContentType(clientId, clientSecret, input.contentTypeName);
  if (!contentType.properties || Object.keys(contentType.properties).length === 0) {
    return {
      success: false,
      error: `Content type '${input.contentTypeName}' has no properties. Check the type name.`,
    };
  }

  const { properties, contentReferences } = await buildPropertiesFromContentType(
    contentType,
    graphKey
  );

  const template: Template = {
    name: input.contentTypeName,
    contentType: input.contentTypeName,
    properties,
    contentReferences,
    createdAt: new Date().toISOString(),
  };

  await saveTemplate(template);

  return {
    success: true,
    template: {
      name: template.name,
      contentType: template.contentType,
      propertyCount: template.properties.length,
      properties: template.properties,
      contentReferences: template.contentReferences,
      createdAt: template.createdAt,
    },
  };
}
