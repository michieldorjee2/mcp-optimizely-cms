import { z } from "zod";
import { createContent } from "../services/cms-api.js";
import { getTemplate } from "../services/template-store.js";

export const createPageSchema = z.object({
  contentType: z.string().describe("The content type key (e.g. 'CompetitorComparisonPage')"),
  name: z.string().describe("Display name for the page"),
  locale: z.string().default("en").describe("Content locale (default: 'en')"),
  parentId: z.string().optional().describe("Parent container content ID"),
  status: z.string().default("draft").describe("Content status: 'draft' or 'published'"),
  routeSegment: z.string().optional().describe("URL route segment for the page"),
  properties: z.record(z.unknown()).default({}).describe("Key-value map of content properties"),
});

export type CreatePageInput = z.infer<typeof createPageSchema>;

export async function createPage(
  input: CreatePageInput,
  clientId: string,
  clientSecret: string
) {
  const template = await getTemplate(input.contentType).catch(() => null);

  if (template) {
    const requiredProps = template.properties.filter((p) => p.required).map((p) => p.key);
    const missing = requiredProps.filter((k) => !(k in input.properties));
    if (missing.length > 0) {
      return {
        success: false,
        error: `Missing required properties for ${input.contentType}: ${missing.join(", ")}`,
        template: template.properties,
      };
    }
  }

  const body = {
    contentType: input.contentType,
    displayName: input.name,
    locale: input.locale,
    status: input.status === "published" ? "Published" : "Draft",
    ...(input.parentId && { container: input.parentId }),
    ...(input.routeSegment && { routeSegment: input.routeSegment }),
    ...(Object.keys(input.properties).length > 0 && { properties: input.properties }),
  };

  const result = await createContent(clientId, clientSecret, body);
  return {
    success: true,
    contentId: result.key,
    displayName: result.displayName,
    contentType: result.contentType,
    status: result.status,
  };
}
