import { z } from "zod";
import { introspectContentType, buildProperty, isUserField, clearTypeCache } from "../services/graph-api.js";
import { saveTemplate, getTemplate, deleteTemplate } from "../services/template-store.js";
import type { Template, TemplateProperty } from "../types.js";

export const createTemplateSchema = z.object({
  contentTypeName: z.string().describe("The name of a page/content type in Optimizely Graph (e.g. 'CompetitorComparisonPage')"),
  force: z.boolean().optional().default(false).describe("If true, overwrite existing template"),
});

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

export async function createTemplate(input: CreateTemplateInput, graphKey: string) {
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

  // Delete existing if forcing
  if (existing && input.force) {
    await deleteTemplate(input.contentTypeName).catch(() => {});
  }

  // Clear the introspection cache so we get fresh data
  clearTypeCache();

  const typeInfo = await introspectContentType(graphKey, input.contentTypeName);
  if (!typeInfo) {
    return {
      success: false,
      error: `Content type '${input.contentTypeName}' not found in Optimizely Graph. Check the type name.`,
    };
  }

  // Build flat property definitions with sub-type introspection
  const userFields = (typeInfo.fields || []).filter((f) => isUserField(f.name));
  const properties: TemplateProperty[] = [];
  const contentReferences: string[] = [];

  for (const field of userFields) {
    const { prop, isContentRef } = await buildProperty(graphKey, field);
    if (prop) {
      properties.push(prop);
      if (isContentRef) {
        contentReferences.push(prop.key);
      }
    }
  }

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
