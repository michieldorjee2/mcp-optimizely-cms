import { z } from "zod";
import { getTemplate } from "../services/template-store.js";
import { loadOrBuildTemplate } from "../services/template-loader.js";

export const createTemplateSchema = z.object({
  contentTypeName: z
    .string()
    .describe(
      "Exact name of a content type in Optimizely CMS — case-sensitive. Examples: 'CompetitorComparisonPage', 'ArticlePage', 'StandardPage'. Find available types via list_page_templates (cached) or by inspecting the CMS UI's content models."
    ),
  force: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, overwrite any existing cached template for this content type. Default false (returns the existing one). Use force=true after the content type changes in the CMS UI to refresh the cached schema."
    ),
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

  const template = await loadOrBuildTemplate(
    input.contentTypeName,
    graphKey,
    clientId,
    clientSecret,
    { force: input.force }
  );

  if (!template) {
    return {
      success: false,
      error: `Content type '${input.contentTypeName}' has no properties or could not be introspected. Check the type name.`,
    };
  }

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
