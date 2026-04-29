import { z } from "zod";
import {
  updateContent,
  getContent,
  listVersions,
  getVersion,
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
      "New display name. Defaults to the existing version's display name (Optimizely requires one on every version)."
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
  // Parse property overrides
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
  // 1. Update content-level metadata (routeSegment) on the bare content
  //    endpoint. This lives on the content wrapper, not on a version.
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
  // 2. Find the latest published version. Version-level data — displayName,
  //    locale, properties — does NOT live on the content wrapper. We need
  //    to fetch a specific version to get them.
  // ---------------------------------------------------------------------
  let versionList: CmsVersionSummary[];
  try {
    versionList = await listVersions(clientId, clientSecret, input.contentId, {
      ...(input.locale ? { locales: [input.locale] } : {}),
      statuses: ["published"],
    });
  } catch (e) {
    const parsed = parseApiError(e);
    return {
      success: false,
      stage: "list-versions",
      error: parsed.message,
      apiError: parsed.apiError,
    };
  }

  // Fall back to all versions if no published one was found.
  if (versionList.length === 0) {
    try {
      versionList = await listVersions(clientId, clientSecret, input.contentId, {
        ...(input.locale ? { locales: [input.locale] } : {}),
      });
    } catch (e) {
      const parsed = parseApiError(e);
      return {
        success: false,
        stage: "list-versions",
        error: parsed.message,
        apiError: parsed.apiError,
      };
    }
  }

  if (versionList.length === 0) {
    return {
      success: false,
      stage: "list-versions",
      error: `No versions found for content ${input.contentId}. Cannot update.`,
    };
  }

  const baseSummary = versionList[0];
  const baseVersionId = getVersionId(baseSummary);
  if (!baseVersionId) {
    return {
      success: false,
      stage: "list-versions",
      error: "Could not determine version id of the latest version.",
      response: baseSummary,
    };
  }

  // ---------------------------------------------------------------------
  // 3. Fetch the full base version (displayName + properties).
  // ---------------------------------------------------------------------
  let base;
  try {
    base = (await getVersion(clientId, clientSecret, input.contentId, baseVersionId)).data;
  } catch (e) {
    const parsed = parseApiError(e);
    return {
      success: false,
      stage: "get-version",
      error: parsed.message,
      apiError: parsed.apiError,
    };
  }

  // ---------------------------------------------------------------------
  // 4. Build the new version body: full base properties + caller overrides.
  // ---------------------------------------------------------------------
  const mergedProperties: Record<string, unknown> = {
    ...(base.properties ?? {}),
    ...overrides,
  };

  const displayName = input.displayName ?? base.displayName;
  const locale = input.locale ?? base.locale;

  if (!displayName) {
    return {
      success: false,
      stage: "create-version",
      error:
        "Could not determine displayName for the new version. The base version did not include one and the caller did not provide one.",
      base,
    };
  }

  // ---------------------------------------------------------------------
  // 5. Create the new version.
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
      currentProperties: base.properties,
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
  // 6. Optionally publish.
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
    baseVersionId,
    versionId,
    displayName: created.displayName ?? displayName,
    contentType: created.contentType,
    status: finalStatus,
    published: finalStatus.toLowerCase() === "published",
    updatedFields: Object.keys(overrides),
  };
}
