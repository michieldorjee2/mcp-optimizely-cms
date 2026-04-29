import { z } from "zod";
import {
  updateContent,
  getContent,
  getContentV1,
  listVersions,
  getVersion,
  createVersion,
  publishVersion,
  type CmsVersionSummary,
} from "../services/cms-api.js";

export const updatePageSchema = z.object({
  contentId: z
    .string()
    .describe(
      "Content ID of the page to update — 32-char hex. Get this from create_page's response, get_page (by slug or search), or saved from a previous call. Required."
    ),
  locale: z
    .string()
    .optional()
    .describe(
      "Content locale to target (e.g. 'en', 'fr'). Defaults to the locale of the existing version. Only pass this if the page has multiple locales and you want a non-default one."
    ),
  displayName: z
    .string()
    .optional()
    .describe(
      "New display name. If omitted, the existing displayName is preserved (Optimizely requires one on every version, so this tool auto-fills it from the latest published version). Pass a value here only when you want to rename the page."
    ),
  routeSegment: z
    .string()
    .optional()
    .describe(
      "New URL slug. If omitted, the existing slug is preserved — important because Optimizely auto-derives the slug from displayName on publish, which would silently change the URL (e.g. 'Amazon - AEM' becomes '/amazon---aem'). This tool re-pins the slug after the version is created/published, so omitting routeSegment is safe."
    ),
  status: z
    .string()
    .default("published")
    .describe(
      "Status after edit. 'published' (default) creates a new version and publishes it in one call. 'draft' creates the version but leaves it unpublished — useful for staging changes."
    ),
  propertiesJson: z
    .string()
    .default("{}")
    .describe(
      "JSON-encoded object of property values to change. Only the keys you include are updated; everything else carries over from the existing version (deep merge). Use the same wrapped shape as create_page — primitive values as {\"value\": ...}, components as nested {\"properties\": {...}}. Run get_page first to see the current property shape and copy the structure. Example: '{\"headline\": {\"value\": \"New title\"}}'."
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
  // 1. Fetch content-level metadata. We need its current `routeSegment`
  //    so we can re-pin it after the version flow — Optimizely auto-
  //    derives the slug from displayName on publish if it's not held in
  //    place. This is the actual "update_page silently changed the URL"
  //    bug.
  //
  // Use /v1/content/{key} for the read because /preview3/experimental/
  // returns a stripped metadata shape that doesn't include routeSegment.
  // Fall back to the preview3 endpoint only if /v1/ refuses, so existing
  // tenants still work.
  // ---------------------------------------------------------------------
  let existingMeta;
  try {
    existingMeta = (await getContentV1(clientId, clientSecret, input.contentId)).data;
  } catch {
    try {
      existingMeta = (await getContent(clientId, clientSecret, input.contentId)).data;
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
  }

  // The slug we want the live URL to have when this call finishes.
  // Will be augmented below from the base version if it isn't on the
  // content metadata (some Optimizely tenants put routeSegment on the
  // version, not the content wrapper).
  let desiredRouteSegment: string | undefined =
    input.routeSegment ?? existingMeta.routeSegment;

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

  // If we still don't have a routeSegment from content metadata, try the
  // base version — some tenants put routeSegment per-version.
  if (!desiredRouteSegment && base.routeSegment) {
    desiredRouteSegment = base.routeSegment;
  }

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
      // Pass routeSegment in the version body too — Optimizely auto-derives
      // the slug from displayName when it isn't explicitly provided, so
      // sending it here is the first line of defense against the drift.
      // The post-create PATCH below is the second line.
      ...(desiredRouteSegment ? { routeSegment: desiredRouteSegment } : {}),
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

  // ---------------------------------------------------------------------
  // 7. Re-pin the routeSegment.
  //
  // Optimizely auto-derives the slug from displayName when a new version
  // is created/published, which silently changes the URL (e.g.
  // "Amazon - AEM" → "amazon---aem"). To prevent this, fetch the current
  // content metadata and PATCH the routeSegment back to the value we
  // want — either the caller's explicit override, or the existing value
  // from before this call started.
  //
  // This runs whether or not we published, because creating a draft
  // version can also leak the auto-derived slug onto the content wrapper.
  // It's a best-effort step: a failure here doesn't fail the whole update.
  // ---------------------------------------------------------------------
  // Idempotent re-pin: PATCH unconditionally if we have a desired slug.
  // We can't reliably read the current slug back via /preview3/ so we
  // can't compare-and-skip — but the PATCH is idempotent (same value →
  // no-op write at the storage layer) and avoids a second GET.
  let finalRouteSegment = desiredRouteSegment;
  let routeSegmentRepinned = false;
  let routeSegmentRepinError: string | undefined;
  if (desiredRouteSegment) {
    try {
      const { etag } = await getContent(clientId, clientSecret, input.contentId);
      await updateContent(
        clientId,
        clientSecret,
        input.contentId,
        { routeSegment: desiredRouteSegment },
        etag
      );
      routeSegmentRepinned = true;
      finalRouteSegment = desiredRouteSegment;
    } catch (e) {
      routeSegmentRepinError = e instanceof Error ? e.message : String(e);
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
    routeSegment: finalRouteSegment,
    routeSegmentRepinned,
    ...(routeSegmentRepinError ? { routeSegmentRepinError } : {}),
    // Diagnostic: where did we resolve routeSegment from? Helps debug when
    // the slug still drifts despite the re-pin.
    _routeSegmentDebug: {
      fromInput: input.routeSegment,
      fromContentMeta: existingMeta.routeSegment,
      fromBaseVersion: base.routeSegment,
      fromCreatedVersion: created.routeSegment,
      desired: desiredRouteSegment,
    },
    updatedFields: Object.keys(overrides),
  };
}
