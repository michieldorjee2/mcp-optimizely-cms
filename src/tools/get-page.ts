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
import { errorToResponse } from "../services/errors.js";

export const getPageSchema = z.object({
  contentId: z
    .string()
    .optional()
    .describe(
      "Content ID (32-char hex). Direct lookup — fastest path, no Graph call. Use this when you already know the id (e.g. just created the page, or saved from a previous response). One of contentId / slug / search is required."
    ),
  slug: z
    .string()
    .optional()
    .describe(
      "URL slug or route segment (e.g. '/amazon---aem' or 'amazon---aem'). Resolved via the Optimizely Graph against url.default with eq / endsWith / wildcard match. The slug is the path after the domain — lowercase, hyphenated. If you only have a friendly term like 'amazon', use search instead."
    ),
  search: z
    .string()
    .optional()
    .describe(
      "Free-text substring match across page display names and URLs (case-insensitive). Use this when you don't know the exact slug — e.g. search='Amazon' finds /amazon. If multiple pages match (e.g. 'Amazon - AEM', 'Amazon - Sitecore'), the tool picks the best one and surfaces the others as `alternatives` in the response — so the response shape stays the same as a single-result lookup."
    ),
  locale: z
    .string()
    .optional()
    .describe(
      "Locale to read (e.g. 'en'). Defaults to the latest available locale across versions."
    ),
  includeSchema: z
    .boolean()
    .default(true)
    .describe(
      "If true (default), include the property schema (key, type, required, validation constraints) alongside the current values, so update_page can be planned in one round-trip. Set false if you only need the current values."
    ),
  verbose: z
    .boolean()
    .default(false)
    .describe(
      "If true, include redundant schema fields (example values, English descriptions, labels, itemShape) for human inspection. Default false keeps the response compact since the current property values already demonstrate the expected shape — saves ~30% tokens on large pages."
    ),
});

export type GetPageInput = z.infer<typeof getPageSchema>;

function getVersionId(v: CmsVersionSummary | undefined | null): string | undefined {
  if (!v) return undefined;
  return v._metadata?.version ?? v.version;
}

// Replaced by services/errors.ts → errorToResponse(). cms-api throws typed
// errors that carry status/endpoint/method/parsed-body directly.

/**
 * Pick the best primary match out of a list, given the search term or slug.
 * Heuristic, in priority order:
 *   1. URL or slug exactly equals the input
 *   2. displayName lowercased equals the input lowercased
 *   3. URL or slug starts with the input (more specific = closer)
 *   4. Shortest URL wins (least-qualified is usually the "main" page)
 *   5. Fall back to the first item (Graph's relevance order).
 */
function pickPrimary(
  matches: [GraphContentMatch, ...GraphContentMatch[]],
  needle: string
): GraphContentMatch {
  if (matches.length === 1) return matches[0];

  const term = needle.replace(/^\//, "").toLowerCase();
  const slashy = `/${term}`;

  // 1. exact URL or routeSegment match
  const exact = matches.find(
    (m) =>
      m.url?.toLowerCase() === slashy ||
      m.url?.toLowerCase() === `${slashy}/` ||
      m.routeSegment?.toLowerCase() === term
  );
  if (exact) return exact;

  // 2. exact displayName match
  const nameMatch = matches.find(
    (m) => m.displayName && m.displayName.toLowerCase() === needle.toLowerCase()
  );
  if (nameMatch) return nameMatch;

  // 3. URL starts with the term
  const startsWith = matches.find(
    (m) =>
      m.url?.toLowerCase().startsWith(slashy) ||
      m.routeSegment?.toLowerCase().startsWith(term)
  );
  if (startsWith) return startsWith;

  // 4. Shortest URL (most "general" page). The non-empty input guarantees
  // the sort produces at least one element.
  const sortedByLen = [...matches].sort(
    (a, b) => (a.url?.length ?? Infinity) - (b.url?.length ?? Infinity)
  );
  return sortedByLen[0] ?? matches[0];
}

/**
 * Resolve the input to a single contentId, plus any alternatives if the
 * search produced multiple candidates. The caller always gets a primary
 * page back (when something matches) — alternatives are surfaced separately
 * so consumers that don't handle ambiguity gracefully still see a normal
 * "single result" response shape.
 */
async function resolveContentId(
  input: GetPageInput,
  graphKey: string | undefined
): Promise<
  | { kind: "single"; contentId: string; match?: GraphContentMatch; alternatives?: GraphContentMatch[] }
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

  let matches: GraphContentMatch[] | undefined;
  let needle: string | undefined;

  if (input.slug) {
    matches = await findContentByRoute(graphKey, input.slug);
    needle = input.slug;
  } else if (input.search) {
    matches = await searchContent(graphKey, input.search);
    needle = input.search;
  } else {
    return { kind: "none", reason: "Provide one of: contentId, slug, or search." };
  }

  if (!matches || matches.length === 0 || !needle) {
    return { kind: "none", reason: `No pages match '${needle ?? ""}'.` };
  }

  const primary = pickPrimary(matches as [GraphContentMatch, ...GraphContentMatch[]], needle);
  const alternatives = matches.filter((m) => m.key !== primary.key);
  return {
    kind: "single",
    contentId: primary.key,
    match: primary,
    ...(alternatives.length > 0 ? { alternatives } : {}),
  };
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
    const parsed = errorToResponse(e);
    return {
      success: false,
      stage: "resolve",
      error: parsed.error,
      apiError: parsed.apiError,
      hint:
        "Lookup via the Optimizely Graph failed. You can retry with a contentId directly to skip the search step.",
    };
  }

  if (resolution.kind === "none") {
    return { success: false, stage: "resolve", error: resolution.reason };
  }

  const contentId = resolution.contentId;
  const alternatives = resolution.alternatives;

  // ---------------------------------------------------------------------
  // 2. Fetch content-level metadata (routeSegment, container, etc.)
  // ---------------------------------------------------------------------
  let contentMeta;
  try {
    contentMeta = (await getContent(clientId, clientSecret, contentId)).data;
  } catch (e) {
    const parsed = errorToResponse(e);
    return {
      success: false,
      stage: "get-content",
      error: parsed.error,
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
    const parsed = errorToResponse(e);
    return {
      success: false,
      stage: "list-versions",
      error: parsed.error,
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
    const parsed = errorToResponse(e);
    return {
      success: false,
      stage: "get-version",
      error: parsed.error,
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
    routeSegment: contentMeta.routeSegment ?? resolution.match?.routeSegment ?? version.routeSegment,
    url: resolution.match?.url,
    properties: version.properties ?? {},
    ...(schema ? { schema } : {}),
    versionsAvailable: versions.length,
    matchedVia: input.contentId ? "contentId" : input.slug ? "slug" : input.search ? "search" : undefined,
    // When slug/search hit multiple candidates, the tool now picks a
    // primary (best heuristic match) and surfaces the others here so the
    // caller can re-pick by contentId if our pick was wrong.
    ...(alternatives && alternatives.length > 0 ? { alternatives } : {}),
  };
}
