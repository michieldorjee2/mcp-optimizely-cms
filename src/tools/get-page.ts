import { z } from "zod";
import {
  getContent,
  getContentType,
  listVersions,
  getVersion,
  type CmsVersionSummary,
} from "../services/cms-api.js";
import {
  findContentByRoute,
  searchContent,
  type GraphContentMatch,
} from "../services/graph-api.js";
import { buildPropertiesFromContentType } from "../services/template-builder.js";

export const getPageSchema = z.object({
  contentId: z
    .string()
    .optional()
    .describe(
      "Content ID (32-char hex). If provided, looks up directly without searching."
    ),
  slug: z
    .string()
    .optional()
    .describe(
      "Page slug or URL route segment (e.g. '/amazon' or 'amazon'). Resolved via the Optimizely Graph."
    ),
  search: z
    .string()
    .optional()
    .describe(
      "Free-text search across page display names, route segments, and URLs. Returns multiple matches if more than one page matches."
    ),
  locale: z
    .string()
    .optional()
    .describe("Locale to fetch (e.g. 'en'). Defaults to the latest available locale."),
  includeSchema: z
    .boolean()
    .default(true)
    .describe(
      "If true, include the property schema (types, validation rules) alongside current values, so update_page calls can be built without extra round-trips. Default: true."
    ),
  verbose: z
    .boolean()
    .default(false)
    .describe(
      "If true, include redundant schema fields (example values, English descriptions, labels, itemShape) for human inspection. Default: false — the lean schema keeps key/type/required + structured validation only, since the current property values already show the expected shape."
    ),
});

export type GetPageInput = z.infer<typeof getPageSchema>;

function getVersionId(v: CmsVersionSummary | undefined | null): string | undefined {
  if (!v) return undefined;
  return v._metadata?.version ?? v.version;
}

function parseApiError(e: unknown): { status?: number; apiError?: unknown; message: string } {
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

/**
 * Resolve the input to a single contentId. Returns either a single id, or a
 * list of candidate matches that the caller can pick from.
 */
async function resolveContentId(
  input: GetPageInput,
  graphKey: string | undefined
): Promise<
  | { kind: "single"; contentId: string; match?: GraphContentMatch }
  | { kind: "multiple"; matches: GraphContentMatch[] }
  | { kind: "none"; reason: string }
> {
  if (input.contentId) {
    return { kind: "single", contentId: input.contentId };
  }

  if (!graphKey) {
    return {
      kind: "none",
      reason:
        "slug/search lookup requires the Optimizely Graph API key (OPTIMIZELY_GRAPH_KEY env var) to be configured.",
    };
  }

  if (input.slug) {
    const matches = await findContentByRoute(graphKey, input.slug);
    if (matches.length === 0) return { kind: "none", reason: `No page found with slug '${input.slug}'.` };
    if (matches.length === 1) return { kind: "single", contentId: matches[0].key, match: matches[0] };
    // Multiple matches — prefer exact route match if there is one
    const stripped = input.slug.startsWith("/") ? input.slug : `/${input.slug}`;
    const exact = matches.find((m) => m.url === stripped || m.routeSegment === stripped.replace(/^\//, ""));
    if (exact) return { kind: "single", contentId: exact.key, match: exact };
    return { kind: "multiple", matches };
  }

  if (input.search) {
    const matches = await searchContent(graphKey, input.search);
    if (matches.length === 0) return { kind: "none", reason: `No pages match '${input.search}'.` };
    if (matches.length === 1) return { kind: "single", contentId: matches[0].key, match: matches[0] };
    return { kind: "multiple", matches };
  }

  return { kind: "none", reason: "Provide one of: contentId, slug, or search." };
}

export async function getPage(
  input: GetPageInput,
  clientId: string,
  clientSecret: string,
  graphKey: string | undefined
) {
  // ---------------------------------------------------------------------
  // 1. Resolve to a single contentId. If multiple matches, return them
  //    so the caller can re-run with a more specific input.
  // ---------------------------------------------------------------------
  let resolution;
  try {
    resolution = await resolveContentId(input, graphKey);
  } catch (e) {
    const parsed = parseApiError(e);
    return {
      success: false,
      stage: "resolve",
      error: parsed.message,
      apiError: parsed.apiError,
      hint:
        "Lookup via the Optimizely Graph failed. You can retry with a contentId directly to skip the search step.",
    };
  }

  if (resolution.kind === "none") {
    return { success: false, stage: "resolve", error: resolution.reason };
  }

  if (resolution.kind === "multiple") {
    return {
      success: true,
      ambiguous: true,
      message:
        "Multiple pages matched. Re-run with contentId or a more specific slug/search to pick one.",
      matches: resolution.matches,
    };
  }

  const contentId = resolution.contentId;

  // ---------------------------------------------------------------------
  // 2. Fetch content-level metadata (routeSegment, container, etc.)
  // ---------------------------------------------------------------------
  let contentMeta;
  try {
    contentMeta = (await getContent(clientId, clientSecret, contentId)).data;
  } catch (e) {
    const parsed = parseApiError(e);
    return {
      success: false,
      stage: "get-content",
      error: parsed.message,
      apiError: parsed.apiError,
      hint: "Could not fetch the content. Check that contentId is correct.",
    };
  }

  // ---------------------------------------------------------------------
  // 3. Find the latest published version (or any version if none are
  //    published). Version-level data — displayName, properties — lives
  //    on a version, not on the content wrapper.
  // ---------------------------------------------------------------------
  let versions: CmsVersionSummary[] = [];
  try {
    versions = await listVersions(clientId, clientSecret, contentId, {
      ...(input.locale ? { locales: [input.locale] } : {}),
      statuses: ["published"],
    });
    if (versions.length === 0) {
      versions = await listVersions(clientId, clientSecret, contentId, {
        ...(input.locale ? { locales: [input.locale] } : {}),
      });
    }
  } catch (e) {
    const parsed = parseApiError(e);
    return {
      success: false,
      stage: "list-versions",
      error: parsed.message,
      apiError: parsed.apiError,
    };
  }

  if (versions.length === 0) {
    return {
      success: false,
      stage: "list-versions",
      error: `No versions found for content ${contentId}.`,
    };
  }

  const versionSummary = versions[0];
  const versionId = getVersionId(versionSummary);
  if (!versionId) {
    return {
      success: false,
      stage: "list-versions",
      error: "Could not determine version id of the latest version.",
      response: versionSummary,
    };
  }

  let version;
  try {
    version = (await getVersion(clientId, clientSecret, contentId, versionId)).data;
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
  // 4. Build the property schema for this content type so the agent can
  //    plan an update without extra calls. Mirrors create_template's
  //    output shape.
  // ---------------------------------------------------------------------
  const contentTypeName = Array.isArray(version.contentType)
    ? version.contentType[version.contentType.length - 1]
    : (version.contentType as unknown as string | undefined);

  let schema: { properties: unknown[]; contentReferences: string[] } | undefined;
  if (input.includeSchema && graphKey && contentTypeName) {
    try {
      const ct = await getContentType(clientId, clientSecret, contentTypeName);
      const built = await buildPropertiesFromContentType(ct, graphKey);

      // Lean view: drop the fields that duplicate information already
      // visible in the current property values (example, itemShape) or in
      // structured fields right next to them (label, description). The
      // agent can read the actual shape from `properties` and the validation
      // rules from `required` / `min*` / `max*` / `pattern` / `enumValues`.
      const properties = input.verbose
        ? built.properties
        : built.properties.map((p) => {
            const { label: _label, description: _desc, example: _ex, itemShape: _is, ...rest } = p;
            return rest;
          });

      schema = {
        properties,
        contentReferences: built.contentReferences,
      };
    } catch {
      // Best-effort: if schema lookup fails (e.g. unknown type), skip it
      // rather than failing the whole call.
    }
  }

  return {
    success: true,
    contentId,
    versionId,
    contentType: contentTypeName,
    displayName: version.displayName,
    locale: version.locale,
    status: version.status,
    routeSegment: contentMeta.routeSegment ?? resolution.match?.routeSegment,
    url: resolution.match?.url,
    properties: version.properties ?? {},
    ...(schema ? { schema } : {}),
    versionsAvailable: versions.length,
    matchedVia: input.contentId ? "contentId" : input.slug ? "slug" : input.search ? "search" : undefined,
  };
}
