import { z } from "zod";
import { getContent, updateContent } from "../services/cms-api.js";

export const updatePageSchema = z.object({
  contentId: z.string().describe("The content ID of the page to update"),
  locale: z.string().optional().describe("Content locale to update"),
  displayName: z.string().optional().describe("New display name"),
  routeSegment: z.string().optional().describe("New URL route segment"),
  status: z.string().optional().describe("New status: 'draft' or 'published'"),
  propertiesJson: z.string().default("{}").describe("JSON-encoded object of properties to update (e.g. '{\"title\": \"New Title\"}')" ),
});

export type UpdatePageInput = z.infer<typeof updatePageSchema>;

export async function updatePage(
  input: UpdatePageInput,
  clientId: string,
  clientSecret: string
) {
  // Parse properties from JSON string
  let properties: Record<string, unknown> = {};
  try {
    properties = JSON.parse(input.propertiesJson || "{}");
  } catch {
    return { success: false, error: "Invalid JSON in propertiesJson. Must be a valid JSON object." };
  }

  const { data: existing, etag } = await getContent(clientId, clientSecret, input.contentId);

  const patchBody: Record<string, unknown> = {};

  if (input.displayName) patchBody.displayName = input.displayName;
  if (input.routeSegment) patchBody.routeSegment = input.routeSegment;
  if (input.locale) patchBody.locale = input.locale;
  if (input.status) {
    patchBody.status = input.status;
  }
  if (Object.keys(properties).length > 0) {
    patchBody.properties = properties;
  }

  const result = await updateContent(clientId, clientSecret, input.contentId, patchBody, etag);
  return {
    success: true,
    contentId: result.key,
    displayName: result.displayName,
    contentType: result.contentType,
    status: result.status,
  };
}
