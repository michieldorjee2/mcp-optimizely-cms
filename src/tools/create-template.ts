import { z } from "zod";
import { introspectContentType, mapGraphQLTypeToCmsType, isUserField } from "../services/graph-api.js";
import { saveTemplate, getTemplate } from "../services/template-store.js";
import type { Template, TemplateField } from "../types.js";

export const createTemplateSchema = z.object({
  contentTypeName: z.string().describe("The name of a page/content type in Optimizely Graph (e.g. 'CompetitorComparisonPage')"),
});

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

export async function createTemplate(input: CreateTemplateInput, graphKey: string) {
  const existing = await getTemplate(input.contentTypeName).catch(() => null);
  if (existing) {
    return {
      success: false,
      error: `Template '${input.contentTypeName}' already exists. Delete it first to recreate.`,
      existing,
    };
  }

  const typeInfo = await introspectContentType(graphKey, input.contentTypeName);
  if (!typeInfo) {
    return {
      success: false,
      error: `Content type '${input.contentTypeName}' not found in Optimizely Graph. Check the type name.`,
    };
  }

  const fields: TemplateField[] = typeInfo.fields
    .filter((f) => isUserField(f.name))
    .map((f) => ({
      name: f.name,
      type: mapGraphQLTypeToCmsType(f),
      required: f.type.kind === "NON_NULL",
      description: f.description || `Field: ${f.name}`,
    }));

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
