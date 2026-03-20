import { z } from "zod";
import { introspectContentType, buildTemplateField, isUserField } from "../services/graph-api.js";
import { saveTemplate, getTemplate, deleteTemplate } from "../services/template-store.js";
import type { Template, TemplateField } from "../types.js";

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
        fieldCount: existing.fields.length,
        createdAt: existing.createdAt,
      },
    };
  }

  // Delete existing if forcing
  if (existing && input.force) {
    await deleteTemplate(input.contentTypeName).catch(() => {});
  }

  const typeInfo = await introspectContentType(graphKey, input.contentTypeName);
  if (!typeInfo) {
    return {
      success: false,
      error: `Content type '${input.contentTypeName}' not found in Optimizely Graph. Check the type name.`,
    };
  }

  // Build rich field definitions with sub-type introspection
  const userFields = (typeInfo.fields || []).filter((f) => isUserField(f.name));
  const fields: TemplateField[] = [];

  for (const field of userFields) {
    const richField = await buildTemplateField(graphKey, field);
    fields.push(richField);
  }

  const template: Template = {
    name: input.contentTypeName,
    contentType: input.contentTypeName,
    fields,
    createdAt: new Date().toISOString(),
  };

  await saveTemplate(template);

  return {
    success: true,
    template: {
      name: template.name,
      contentType: template.contentType,
      fieldCount: template.fields.length,
      fields: template.fields,
      createdAt: template.createdAt,
    },
  };
}
