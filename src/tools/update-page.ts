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
  locale: z
    .string()
    .optional()
    .describe("Content locale to update (e.g. 'en'). Defaults to the existing content's locale."),
  displayName: z
    .string()
    .optional()
    .describe(
      "New display name. Defaults to the existing content's display name (Optimizely requires one on every version)."
    ),
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
 * into a structured shape so the caller can see the API's `errors[]` array
 * directly instead of digging through a string.
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
  let overrides: Record<string, unknown> = {};
  try {
    overrides = JSON.parse(input.propertiesJson || "{}");
  } catch {
    return {
      success: false,
      error: "Invalid JSON in propertiesJson. Must be a valid JSON object.",
    };
  }

  const wantsPublish = input.status.toLowerCase() === "published";

  // ---------------------------------------------------------------------
  // 1. Fetch the current content. We use this as the base for the new
  //    version — POST /v1/content/{key}/versions does NOT fork or inherit
  //    properties; it requires every required field in the body. So we
  //    clone the current properties and merge the caller's overrides on
  //    top.
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

  // ---------------------------------------------------------------------
  // 3. Merge caller overrides into the existing property set, so the
  //    new version has every required field (the rest unchanged).
  // ---------------------------------------------------------------------
  const mergedProperties: Record<string, unknown> = {
    ...(existing.properties ?? {}),
    ...overrides,
  };

  const displayName = input.displayName ?? existing.displayName;
  const locale = input.locale ?? existing.locale;

  // ---------------------------------------------------------------------
  // 4. Create the new version with the full merged property set.
  // ---------------------------------------------------------------------
  let created: CmsVersionSummary;
  try {
    created = await createVersion(clientId, clientSecret, input.contentId, {
      displayName,
      ...(locale ? { locale } : {}),
      properties: mergedProperties,
    });
  } catch (e) {
    const parsed = parseApiError(e);
    return {
      success: false,
      stage: "create-version",
      error: parsed.message,
      apiError: parsed.apiError,
      hint:
        "The CMS rejected the new version. Most common cause: one of the " +
        "properties you provided has the wrong shape. Compare your override " +
        "to the matching field in `currentProperties` below to see the format " +
        "Optimizely expects.",
      attemptedOverrides: overrides,
      currentProperties: existing.properties,
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
  // 5. Optionally publish.
  // ---------------------------------------------------------------------
  let finalStatus = created.status ?? "draft";
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
        hint:
          "The version was created and edited but failed to publish. It is " +
          "available as a draft in the CMS.",
      };
    }
  }

  return {
    success: true,
    contentId: input.contentId,
    versionId,
    displayName: created.displayName,
    contentType: created.contentType,
    status: finalStatus,
    published: finalStatus.toLowerCase() === "published",
    updatedFields: Object.keys(overrides),
  };
}
