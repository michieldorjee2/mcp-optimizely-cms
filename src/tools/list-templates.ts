import { z } from "zod";
import { listTemplates as listTemplatesFromStore } from "../services/template-store.js";

export const listTemplatesSchema = z.object({
  filter: z
    .string()
    .optional()
    .describe(
      "Case-insensitive substring to match against template names (= content type names). Example: filter='Page' returns 'CompetitorComparisonPage', 'StandardPage', 'ArticlePage'. Omit to list all cached templates."
    ),
});

export type ListTemplatesInput = z.infer<typeof listTemplatesSchema>;

export async function listTemplatesHandler(input: ListTemplatesInput) {
  const templates = await listTemplatesFromStore();

  const filtered = input.filter
    ? templates.filter((t) => t.name.toLowerCase().includes(input.filter!.toLowerCase()))
    : templates;

  return {
    success: true,
    count: filtered.length,
    templates: filtered.map((t) => ({
      name: t.name,
      contentType: t.contentType,
      propertyCount: t.properties.length,
      properties: t.properties,
      contentReferences: t.contentReferences,
      createdAt: t.createdAt,
    })),
  };
}
