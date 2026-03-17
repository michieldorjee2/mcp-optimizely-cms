import { z } from "zod";
import { getContent, updateContent } from "../services/cms-api.js";

export const updatePageSchema = z.object({
  contentId: z.string().describe("The content ID of the page to update"),
  locale: z.string().optional().describe("Content locale to update"),
  displayName: z.string().optional().describe("New display name"),
  routeSegment: z.string().optional().describe("New URL route segment"),
  status: z.string().optional().describe("New status: 'draft' or 'published'"),
  properties: z.record(z.unknown()).default({}).describe("Key-value map of properties to update"),
});

export type UpdatePageInput = z.infer<typeof updatePageSchema>;

export async function updatePage(
  input: UpdatePageInput,
  clientId: string,
  clientSecret: string
) {
  const { data: existing, etag } = await getContent(clientId, clientSecret, input.contentId);

  const patchBody: Record<string, unknown> = {};

  if (input.displayName) patchBody.displayName = input.displayName;
  if (input.routeSegment) patchBody.routeSegment = input.routeSegment;
  if (input.locale) patchBody.locale = input.locale;
  if (input.status) {
    patchBody.status = input.status === "published" ? "Published" : "Draft";
  }
  if (Object.keys(input.properties).length > 0) {
    patchBody.properties = input.properties;
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
