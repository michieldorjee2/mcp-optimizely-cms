import { z } from "zod";
import {
  updateContent,
  getContent,
  listVersions,
  createVersion,
  getVersion,
  patchVersion,
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
    .optional()
    .describe(
      "Set to 'published' to publish the edited version. Omit to leave changes as a draft."
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

function isDraft(status: string | undefined): boolean {
  if (!status) return true;
  return status.toLowerCase() !== "published";
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

  // ---------------------------------------------------------------------
  // 1. Update content-level metadata (routeSegment) on the bare content
  //    endpoint. PATCH /content/{key} only touches metadata — that's all
  //    that lives there.
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

  // ---------------------------------------------------------------------
  // 2. Find an editable draft version, or create one from scratch.
  //    A given locale can have only one published version; drafts are
  //    where edits land before publish.
  // ---------------------------------------------------------------------
  const versions = await listVersions(
    clientId,
    clientSecret,
    input.contentId,
    input.locale
  );

  const localeVersions = input.locale
    ? versions.filter((v) => !v.locale || v.locale === input.locale)
    : versions;

  let editable = localeVersions.find((v) => isDraft(v.status));

  if (!editable) {
    // No draft exists — create one. Optimizely will fork from the latest
    // published version of this locale.
    editable = await createVersion(clientId, clientSecret, input.contentId, {
      ...(input.locale ? { locale: input.locale } : {}),
    });
  }

  const versionId = getVersionId(editable);
  if (!versionId) {
    return {
      success: false,
      error:
        "Could not determine version id for the editable draft. The CMS API may have returned an unexpected shape.",
    };
  }

  // ---------------------------------------------------------------------
  // 3. PATCH the version with displayName + properties (if any).
  // ---------------------------------------------------------------------
  const versionPatch: Record<string, unknown> = {};
  if (input.displayName) versionPatch.displayName = input.displayName;
  if (Object.keys(properties).length > 0) versionPatch.properties = properties;

  let patched: CmsVersionSummary = editable;
  if (Object.keys(versionPatch).length > 0) {
    const { etag } = await getVersion(clientId, clientSecret, input.contentId, versionId);
    patched = await patchVersion(
      clientId,
      clientSecret,
      input.contentId,
      versionId,
      versionPatch,
      etag
    );
  }

  // ---------------------------------------------------------------------
  // 4. Optionally publish the version. Status transitions don't go
  //    through PATCH — they have a dedicated :publish endpoint.
  // ---------------------------------------------------------------------
  let finalStatus = patched.status;
  if (input.status && input.status.toLowerCase() === "published") {
    const { etag: publishEtag } = await getVersion(
      clientId,
      clientSecret,
      input.contentId,
      versionId
    );
    const published = await publishVersion(
      clientId,
      clientSecret,
      input.contentId,
      versionId,
      publishEtag
    );
    finalStatus = published.status ?? "published";
  }

  return {
    success: true,
    contentId: input.contentId,
    versionId,
    displayName: patched.displayName,
    contentType: patched.contentType,
    status: finalStatus,
    published: finalStatus?.toLowerCase() === "published",
  };
}
