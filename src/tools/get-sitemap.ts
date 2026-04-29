import { z } from "zod";

export const getSitemapSchema = z.object({
  url: z.string().describe("The URL of the XML sitemap or sitemap index (e.g. https://example.com/sitemap.xml)"),
  follow_index: z.boolean().optional().default(true).describe("If the URL is a sitemap index, fetch all child sitemaps. Defaults to true. Set to false to only inspect the index itself."),
  max_sitemaps: z.number().optional().default(50).describe("Maximum number of child sitemaps to fetch when following a sitemap index. Defaults to 50, max 200."),
});

export type GetSitemapInput = z.infer<typeof getSitemapSchema>;

// ── Lightweight XML helpers ──────────────────────────────────────────────────

function extractElements(xml: string, tag: string): string[] {
  const results: string[] = [];
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let idx = 0;
  while (true) {
    const start = xml.indexOf(open, idx);
    if (start === -1) break;
    const end = xml.indexOf(close, start);
    if (end === -1) break;
    results.push(xml.slice(start, end + close.length));
    idx = end + close.length;
  }
  return results;
}

function textContent(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
  return match ? match[1].trim() : undefined;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface SitemapAnalysis {
  url: string;
  is_sitemap_index: boolean;
  total_urls: number;
  child_sitemaps?: { loc: string; lastmod?: string }[];
  child_sitemaps_fetched?: number;
  child_sitemaps_total?: number;
  hreflang: {
    urls_with_hreflang: number;
    languages: string[];
    default_language?: string;
  };
  urls_by_language: Record<string, number>;
  estimated_unique_content_pages: number;
  top_path_segments: Record<string, number>;
  lastmod_summary: {
    newest?: string;
    oldest?: string;
    total_with_lastmod: number;
  };
  freshness: {
    updated_last_30d: number;
    updated_last_90d: number;
    updated_last_365d: number;
    updated_last_2y: number;
    note: string;
  };
  changefreq_distribution: Record<string, number>;
  priority_distribution: Record<string, number>;
  sample_urls: string[];
  errors: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Map from hreflang href → lang for the current <url> entry.
// Returns a Map<locUrl, lang> so we can look up which language the <loc> belongs to.
function parseHreflangLinks(entry: string): Map<string, string> {
  const map = new Map<string, string>();
  // Match xhtml:link elements with hreflang and href in either order
  const re = /xhtml:link[^>]*(?:hreflang=["']([^"']+)["'][^>]*href=["']([^"']+)["']|href=["']([^"']+)["'][^>]*hreflang=["']([^"']+)["'])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(entry)) !== null) {
    const lang = m[1] || m[4];
    const href = m[2] || m[3];
    if (lang && href && lang !== "x-default") {
      map.set(href.replace(/\/$/, ""), lang);
    }
  }
  return map;
}

function daysAgo(dateStr: string, now: Date): number {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return Infinity;
    return Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
  } catch {
    return Infinity;
  }
}

// ── Fetch helper ─────────────────────────────────────────────────────────────

async function fetchXml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "OptimizelyMCP-SitemapAnalyzer/1.0",
      Accept: "application/xml, text/xml, */*",
    },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return res.text();
}

// ── Core analysis ────────────────────────────────────────────────────────────

function analyzeUrlEntries(urlElements: string[], analysis: SitemapAnalysis, now: Date) {
  for (const entry of urlElements) {
    const loc = textContent(entry, "loc");
    if (!loc) continue;

    analysis.total_urls++;

    // Sample up to 10 URLs
    if (analysis.sample_urls.length < 10) {
      analysis.sample_urls.push(loc);
    }

    // Path segment bucketing (first meaningful segment)
    try {
      const pathname = new URL(loc).pathname;
      const segment = pathname.split("/").filter(Boolean)[0] || "/";
      analysis.top_path_segments[segment] =
        (analysis.top_path_segments[segment] || 0) + 1;
    } catch {
      // ignore malformed URLs
    }

    // lastmod
    const lastmod = textContent(entry, "lastmod");
    if (lastmod) {
      analysis.lastmod_summary.total_with_lastmod++;
      if (!analysis.lastmod_summary.newest || lastmod > analysis.lastmod_summary.newest) {
        analysis.lastmod_summary.newest = lastmod;
      }
      if (!analysis.lastmod_summary.oldest || lastmod < analysis.lastmod_summary.oldest) {
        analysis.lastmod_summary.oldest = lastmod;
      }
      // Freshness buckets
      const age = daysAgo(lastmod, now);
      if (age <= 30) analysis.freshness.updated_last_30d++;
      if (age <= 90) analysis.freshness.updated_last_90d++;
      if (age <= 365) analysis.freshness.updated_last_365d++;
      if (age <= 730) analysis.freshness.updated_last_2y++;
    }

    // changefreq
    const changefreq = textContent(entry, "changefreq");
    if (changefreq) {
      analysis.changefreq_distribution[changefreq] =
        (analysis.changefreq_distribution[changefreq] || 0) + 1;
    }

    // priority
    const priority = textContent(entry, "priority");
    if (priority) {
      analysis.priority_distribution[priority] =
        (analysis.priority_distribution[priority] || 0) + 1;
    }

    // hreflang — collect languages and determine this URL's language
    const hreflangMap = parseHreflangLinks(entry);
    if (hreflangMap.size > 0) {
      analysis.hreflang.urls_with_hreflang++;
      const allLangs = new Set<string>(hreflangMap.values());
      for (const lang of allLangs) {
        if (!analysis.hreflang.languages.includes(lang)) {
          analysis.hreflang.languages.push(lang);
        }
      }
      // Check for x-default
      if (/hreflang=["']x-default["']/i.test(entry)) {
        analysis.hreflang.default_language = "x-default";
        if (!analysis.hreflang.languages.includes("x-default")) {
          analysis.hreflang.languages.push("x-default");
        }
      }
      // Determine this URL's language:
      // 1. Check if <loc> is listed in the hreflang hrefs (self-referencing)
      // 2. If not, the <loc>'s language is the one missing from the alternates
      const normalizedLoc = loc.replace(/\/$/, "");
      let locLang = hreflangMap.get(normalizedLoc);
      if (!locLang) {
        // The loc's own language isn't in the alternates (common pattern).
        // Find which known language is NOT in the alternates for this entry.
        const knownLangs = analysis.hreflang.languages.filter(l => l !== "x-default");
        const altLangs = new Set(hreflangMap.values());
        const missing = knownLangs.filter(l => !altLangs.has(l));
        if (missing.length === 1) {
          locLang = missing[0];
        }
      }
      if (locLang) {
        analysis.urls_by_language[locLang] =
          (analysis.urls_by_language[locLang] || 0) + 1;
      }
    }
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────

export async function getSitemap(input: GetSitemapInput) {
  const { url, follow_index: followIndex, max_sitemaps } = input;
  const maxSitemaps = Math.min(max_sitemaps ?? 50, 200);
  const now = new Date();

  const analysis: SitemapAnalysis = {
    url,
    is_sitemap_index: false,
    total_urls: 0,
    hreflang: { urls_with_hreflang: 0, languages: [] },
    urls_by_language: {},
    estimated_unique_content_pages: 0,
    top_path_segments: {},
    lastmod_summary: { total_with_lastmod: 0 },
    freshness: {
      updated_last_30d: 0,
      updated_last_90d: 0,
      updated_last_365d: 0,
      updated_last_2y: 0,
      note: "Research shows ~50% of AI citations go to content updated in the last 90 days, and ~60% to content from the last 2 years (sources: Ahrefs 17M citation study, Seer Interactive).",
    },
    changefreq_distribution: {},
    priority_distribution: {},
    sample_urls: [],
    errors: [],
  };

  let xml: string;
  try {
    xml = await fetchXml(url);
  } catch (err) {
    return {
      error: `Failed to fetch sitemap: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Detect sitemap index
  const isSitemapIndex = xml.includes("<sitemapindex");
  analysis.is_sitemap_index = isSitemapIndex;

  if (isSitemapIndex) {
    const sitemapEntries = extractElements(xml, "sitemap");
    const childSitemaps = sitemapEntries
      .map((entry) => ({
        loc: textContent(entry, "loc") || "",
        lastmod: textContent(entry, "lastmod"),
      }))
      .filter((s) => s.loc);

    analysis.child_sitemaps = childSitemaps;
    analysis.child_sitemaps_total = childSitemaps.length;

    if (followIndex !== false) {
      const toFetch = childSitemaps.slice(0, maxSitemaps);
      analysis.child_sitemaps_fetched = toFetch.length;

      // Fetch child sitemaps in parallel (batches of 10)
      for (let i = 0; i < toFetch.length; i += 10) {
        const batch = toFetch.slice(i, i + 10);
        const results = await Promise.allSettled(
          batch.map((s) => fetchXml(s.loc))
        );
        for (let j = 0; j < results.length; j++) {
          const result = results[j];
          if (result.status === "fulfilled") {
            const childUrls = extractElements(result.value, "url");
            analyzeUrlEntries(childUrls, analysis, now);
          } else {
            analysis.errors.push(
              `Failed to fetch ${batch[j].loc}: ${result.reason}`
            );
          }
        }
      }
    }
  } else {
    // Regular sitemap
    const urlEntries = extractElements(xml, "url");
    analyzeUrlEntries(urlEntries, analysis, now);
  }

  // Sort top_path_segments by count descending, keep top 20
  const sortedSegments = Object.entries(analysis.top_path_segments)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);
  analysis.top_path_segments = Object.fromEntries(sortedSegments);

  // Estimate unique content pages
  const hasHreflang = analysis.hreflang.urls_with_hreflang > 0;
  const langCounts = Object.entries(analysis.urls_by_language);

  if (!hasHreflang || langCounts.length <= 1) {
    // No hreflang or single language — all URLs are unique content
    analysis.estimated_unique_content_pages = analysis.total_urls;
  } else {
    // Multiple languages via hreflang — the largest language group approximates
    // unique content; others are translations of the same pages.
    const sorted = langCounts.sort((a, b) => b[1] - a[1]);
    analysis.estimated_unique_content_pages = sorted[0][1];
  }

  // Sort urls_by_language descending
  analysis.urls_by_language = Object.fromEntries(
    Object.entries(analysis.urls_by_language).sort((a, b) => b[1] - a[1])
  );

  // Clean up empty/irrelevant fields for cleaner output
  const result: Record<string, unknown> = { ...analysis };
  if (!hasHreflang) delete result.hreflang;
  if (langCounts.length <= 1) delete result.urls_by_language;
  if (analysis.lastmod_summary.total_with_lastmod === 0) delete result.freshness;
  if (Object.keys(analysis.changefreq_distribution).length === 0)
    delete result.changefreq_distribution;
  if (Object.keys(analysis.priority_distribution).length === 0)
    delete result.priority_distribution;
  if (analysis.errors.length === 0) delete result.errors;
  if (!analysis.is_sitemap_index) {
    delete result.child_sitemaps;
    delete result.child_sitemaps_fetched;
    delete result.child_sitemaps_total;
  }

  return result;
}
