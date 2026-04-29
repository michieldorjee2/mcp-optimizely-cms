import { z } from "zod";
import {
  updateContent,
  getContent,
  createVersion,
  patchVersion,
  getVersion,
  publishVersion,
  type CmsVersionSummary,
} from "../services/cms-api.js";

export const updatePageSchema = z.object({
  contentId: z.string().describe("The content ID of the page to update"),
  locale: z.string().optional().describe("Content locale to update (e.g. 'en'). Defaults to the existing content's locale."),
  displayName: z.string().optional().describe("New display name. Defaults to the existing content's display name (Optimizely requires one on every version)."),
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
    .describe(
      "JSON-encoded object of properties to update. Only the properties you include are changed — untouched properties keep their current values. Example: '{\"title\": \"New Title\"}'"
    ),
});

export type UpdatePageInput = z.infer<typeof updatePageSchema>;

function getVersionId(v: CmsVersionSummary | undefined | null): string | undefined {
  if (!v) return undefined;
  return v._metadata?.version ?? v.version;
}

/**
 * The cms-api helpers throw `Error("... failed (NNN): {json}")`. Re-parse that
 * into a structured shape so the caller (and the user) can see the API's
 * `errors[]` array directly instead of digging through a string.
 */
function parseApiError(e: unknown): {
  status?: number;
  apiError?: unknown;
  message: string;
} {
  const message = e instanceof Error ? e.message : String(e);
  const match = message.match(/\((\d+)\):\s*(\{[\s\S]+\})\s*$/);
  if (match) {
    const status = Number(match[1]);
    try {
      return { status, apiError: JSON.parse(match[2]), message };
    } catch {
      return { status, apiError: match[2], message };
    }
  }
  return { message };
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
  const hasPropertyEdits = Object.keys(properties).length > 0;
  const hasVersionEdits = Boolean(input.displayName) || hasPropertyEdits;

  // ---------------------------------------------------------------------
  // 1. Fetch the current content. We need its displayName + locale to fork
  //    a new version (Optimizely requires displayName, and we want the
  //    locale to match if the caller didn't specify one).
  // ---------------------------------------------------------------------
  let existing;
  try {
    existing = (await getContent(clientId, clientSecret, input.contentId)).data;
  } catch (e) {
    const parsed = parseApiError(e);
    return {
      success: false,
      stage: "get-content",
      error: parsed.message,
      apiError: parsed.apiError,
      hint: "Could not fetch the existing content. Check that contentId is correct.",
    };
  }

  // ---------------------------------------------------------------------
  // 2. Update content-level metadata (routeSegment) if provided.
  //    Independent of versioning.
  // ---------------------------------------------------------------------
  if (input.routeSegment) {
    try {
      const { etag } = await getContent(clientId, clientSecret, input.contentId);
      await updateContent(
        clientId,
        clientSecret,
        input.contentId,
        { routeSegment: input.routeSegment },
        etag
      );
    } catch (e) {
      const parsed = parseApiError(e);
      return {
        success: false,
        stage: "update-route-segment",
        error: parsed.message,
        apiError: parsed.apiError,
      };
    }
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
  // 3. Fork a new version from the latest published. We send ONLY
  //    displayName + locale here — no properties — so the new version
  //    inherits all existing properties unchanged. We'll merge-patch in
  //    the changes next, which is safer for partial updates: if one
  //    property has a bad shape, only that property errors, not the
  //    whole batch.
  // ---------------------------------------------------------------------
  const displayName = input.displayName ?? existing.displayName;
  const locale = input.locale ?? existing.locale;

  let created: CmsVersionSummary;
  try {
    created = await createVersion(clientId, clientSecret, input.contentId, {
      displayName,
      ...(locale ? { locale } : {}),
    });
  } catch (e) {
    const parsed = parseApiError(e);
    return {
      success: false,
      stage: "create-version",
      error: parsed.message,
      apiError: parsed.apiError,
      sentBody: { displayName, locale },
    };
  }

  const versionId = getVersionId(created);
  if (!versionId) {
    return {
      success: false,
      stage: "create-version",
      error:
        "Created a new version but could not determine its version id. The CMS API may have returned an unexpected shape.",
      response: created,
    };
  }

  // ---------------------------------------------------------------------
  // 4. PATCH the new version with the property changes (if any). Using
  //    application/merge-patch+json so unmentioned properties are left
  //    intact.
  // ---------------------------------------------------------------------
  let patched: CmsVersionSummary = created;
  if (hasPropertyEdits) {
    try {
      const { etag } = await getVersion(clientId, clientSecret, input.contentId, versionId);
      patched = await patchVersion(
        clientId,
        clientSecret,
        input.contentId,
        versionId,
        { properties },
        etag
      );
    } catch (e) {
      const parsed = parseApiError(e);
      return {
        success: false,
        stage: "patch-version",
        contentId: input.contentId,
        versionId,
        error: parsed.message,
        apiError: parsed.apiError,
        hint:
          "The new draft version was created, but PATCHing the property changes failed. " +
          "Common causes: a property value has the wrong shape (e.g. a 'component' field needs to be an object, an array property expects { value: [...] }), or the property name is wrong. " +
          "Check the existing properties below for the expected shape.",
        currentProperties: existing.properties,
      };
    }
  }

  // ---------------------------------------------------------------------
  // 5. Optionally publish.
  // ---------------------------------------------------------------------
  let finalStatus = patched.status ?? "draft";
  if (wantsPublish) {
    try {
      const published = await publishVersion(
        clientId,
        clientSecret,
        input.contentId,
        versionId
      );
      finalStatus = published.status ?? "published";
    } catch (e) {
      const parsed = parseApiError(e);
      return {
        success: false,
        stage: "publish",
        contentId: input.contentId,
        versionId,
        error: parsed.message,
        apiError: parsed.apiError,
        hint: "The version was created and edited but failed to publish. It is available as a draft in the CMS.",
      };
    }
  }

  return {
    success: true,
    contentId: input.contentId,
    versionId,
    displayName: patched.displayName,
    contentType: patched.contentType,
    status: finalStatus,
    published: finalStatus.toLowerCase() === "published",
  };
}
