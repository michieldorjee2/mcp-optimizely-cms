import { z } from "zod";
import {
  updateContent,
  getContent,
  createVersion,
  publishVersion,
  type CmsVersionSummary,
} from "../services/cms-api.js";

export const updatePageSchema = z.object({
  contentId: z.string().describe("The content ID of the page to update"),
  locale: z.string().optional().describe("Content locale to update (e.g. 'en')"),
  displayName: z.string().optional().describe("New display name"),
  routeSegment: z.string().optional().describe("New URL route segment"),
  status: z
    .string()
    .default("published")
    .describe(
      "Status after edit. Defaults to 'published' (the edit goes live). Pass 'draft' to leave the new version unpublished."
    ),
  propertiesJson: z
    .string()
    .default("{}")
    .describe("JSON-encoded object of properties to update (e.g. '{\"title\": \"New Title\"}')"),
});

export type UpdatePageInput = z.infer<typeof updatePageSchema>;

function getVersionId(v: CmsVersionSummary | undefined | null): string | undefined {
  if (!v) return undefined;
  return v._metadata?.version ?? v.version;
}

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
    return {
      success: false,
      error: "Invalid JSON in propertiesJson. Must be a valid JSON object.",
    };
  }

  const wantsPublish = input.status.toLowerCase() === "published";
  const hasVersionEdits = Boolean(input.displayName) || Object.keys(properties).length > 0;

  // ---------------------------------------------------------------------
  // 1. Update content-level metadata (routeSegment) on the bare content
  //    endpoint. This is independent of versioning.
  // ---------------------------------------------------------------------
  if (input.routeSegment) {
    const { etag } = await getContent(clientId, clientSecret, input.contentId);
    await updateContent(
      clientId,
      clientSecret,
      input.contentId,
      { routeSegment: input.routeSegment },
      etag
    );
  }

  // If there's nothing to version-edit and no publish requested, we're done.
  if (!hasVersionEdits && !wantsPublish) {
    return {
      success: true,
      contentId: input.contentId,
      message: "Updated content metadata only (no version edits or publish requested).",
    };
  }

  // ---------------------------------------------------------------------
  // 2. Fork a new version from the latest published. POST /content/{key}/versions
  //    accepts displayName/locale/properties in the body, so create + edit
  //    happen in one call.
  // ---------------------------------------------------------------------
  const created = await createVersion(clientId, clientSecret, input.contentId, {
    ...(input.locale ? { locale: input.locale } : {}),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
  });

  const versionId = getVersionId(created);
  if (!versionId) {
    return {
      success: false,
      error:
        "Created a new version but could not determine its version id. The CMS API may have returned an unexpected shape.",
    };
  }

  // ---------------------------------------------------------------------
  // 3. Optionally publish. Status transitions don't go through PATCH —
  //    they use the dedicated :publish endpoint.
  // ---------------------------------------------------------------------
  let finalStatus = created.status ?? "draft";
  if (wantsPublish) {
    const published = await publishVersion(
      clientId,
      clientSecret,
      input.contentId,
      versionId
    );
    finalStatus = published.status ?? "published";
  }

  return {
    success: true,
    contentId: input.contentId,
    versionId,
    displayName: created.displayName,
    contentType: created.contentType,
    status: finalStatus,
    published: finalStatus.toLowerCase() === "published",
  };
}
