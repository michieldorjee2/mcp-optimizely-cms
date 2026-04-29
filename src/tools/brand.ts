import { z } from "zod";

export const getLogoSchema = z.object({
  domain: z.string().describe("The domain of the brand (e.g. 'nike.com', 'apple.com')"),
  theme: z.enum(["light", "dark"]).optional().describe("Logo theme variant. Use 'dark' for logos on dark backgrounds, 'light' for light backgrounds."),
  type: z.enum(["icon", "logo", "symbol"]).optional().default("icon").describe("Logo type: 'icon' (square mark/social profile image), 'logo' (horizontal wordmark), or 'symbol' (abstract brand mark). Defaults to 'icon'."),
  fallback: z.enum(["brandfetch", "transparent", "lettermark", "404"]).optional().describe("Placeholder if logo is unavailable. 'lettermark' generates a letter-based placeholder, '404' returns a 404 error, 'transparent' returns a transparent image."),
  w: z.number().optional().describe("Width in pixels. Aspect ratio is always preserved."),
  h: z.number().optional().describe("Height in pixels. Aspect ratio is always preserved."),
});

export type GetLogoInput = z.infer<typeof getLogoSchema>;

export const getBrandSchema = z.object({
  domain: z.string().describe("The domain of the brand (e.g. 'nike.com', 'apple.com')"),
});

export type GetBrandInput = z.infer<typeof getBrandSchema>;

export function getLogo(input: GetLogoInput) {
  const apiKey = process.env.BRANDFETCH_LOGO_KEY;
  if (!apiKey) {
    return { error: "Missing BRANDFETCH_LOGO_KEY environment variable" };
  }

  // Uses the free Logo API (CDN) — no Brand API credits consumed.
  // These URLs are for use in <img> tags, not server-side fetching.
  const domain = encodeURIComponent(input.domain);
  const type = input.type || "icon";
  const c = encodeURIComponent(apiKey);

  // Build CDN path with optional segments
  function buildUrl(t: string, theme?: string, w?: number, h?: number, fallback?: string) {
    let path = `https://cdn.brandfetch.io/domain/${domain}`;
    if (w) path += `/w/${w}`;
    if (h) path += `/h/${h}`;
    if (theme) path += `/theme/${theme}`;
    if (fallback) path += `/fallback/${fallback}`;
    path += `/type/${t}`;
    return `${path}?c=${c}`;
  }

  const logoUrl = buildUrl(type, input.theme, input.w, input.h, input.fallback);

  // Also provide variants (all three types, same theme/size)
  const variants: Record<string, string> = {};
  for (const t of ["icon", "logo", "symbol"] as const) {
    variants[t] = buildUrl(t, input.theme, input.w, input.h, input.fallback);
  }

  return {
    domain: input.domain,
    logo_url: logoUrl,
    type,
    theme: input.theme || "default",
    usage: `<img src="${logoUrl}" alt="${input.domain} logo by Brandfetch" />`,
    variants,
  };
}

export async function getBrand(input: GetBrandInput) {
  const apiKey = process.env.BRANDFETCH_KEY;
  if (!apiKey) {
    return { error: "Missing BRANDFETCH_KEY environment variable" };
  }

  const res = await fetch(`https://api.brandfetch.io/v2/brands/${encodeURIComponent(input.domain)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    if (res.status === 404) return { error: `Brand not found for domain: ${input.domain}` };
    if (res.status === 429) return { error: "Brandfetch API quota exceeded" };
    return { error: `Brandfetch API error: HTTP ${res.status}` };
  }

  const brand = await res.json() as BrandResponse;

  // Return a clean summary
  return {
    name: brand.name,
    domain: brand.domain,
    claimed: brand.claimed,
    description: brand.description,
    longDescription: brand.longDescription,
    qualityScore: brand.qualityScore,
    logos: (brand.logos || []).map((l: BrandLogo) => ({
      type: l.type,
      theme: l.theme,
      formats: (l.formats || []).map((f: LogoFormat) => ({
        src: f.src,
        format: f.format,
        width: f.width,
        height: f.height,
      })),
    })),
    colors: brand.colors,
    fonts: brand.fonts,
    images: (brand.images || []).map((img: BrandImage) => ({
      type: img.type,
      formats: (img.formats || []).map((f: LogoFormat) => ({
        src: f.src,
        format: f.format,
        width: f.width,
        height: f.height,
      })),
    })),
    links: brand.links,
    company: brand.company,
  };
}

export const getLogoSvgSchema = z.object({
  domain: z.string().describe("The domain of the brand (e.g. 'nike.com', 'apple.com')"),
  theme: z.enum(["light", "dark"]).optional().describe("Logo theme variant."),
  type: z.enum(["icon", "logo", "symbol"]).optional().default("icon").describe("Logo type: 'icon', 'logo', or 'symbol'. Defaults to 'icon'."),
});

export type GetLogoSvgInput = z.infer<typeof getLogoSvgSchema>;

export async function getLogoSvg(input: GetLogoSvgInput) {
  const apiKey = process.env.BRANDFETCH_KEY;
  if (!apiKey) {
    return { error: "Missing BRANDFETCH_KEY environment variable" };
  }

  const targetType = input.type || "icon";
  const targetTheme = input.theme;

  // Fetch brand data to get authenticated CDN URLs
  const res = await fetch(`https://api.brandfetch.io/v2/brands/${encodeURIComponent(input.domain)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    if (res.status === 404) return { error: `Brand not found for domain: ${input.domain}` };
    if (res.status === 429) return { error: "Brandfetch API quota exceeded" };
    return { error: `Brandfetch API error: HTTP ${res.status}` };
  }

  const brand = await res.json() as BrandResponse;

  // Find matching logos by type, prefer matching theme
  const matchingLogos = (brand.logos || []).filter(
    (l: BrandLogo) => l.type === targetType
  );
  const themedLogos = targetTheme
    ? matchingLogos.filter((l: BrandLogo) => l.theme === targetTheme)
    : matchingLogos;
  const logos = themedLogos.length > 0 ? themedLogos : matchingLogos;

  // Try to find and fetch native SVG
  for (const logo of logos) {
    const svg = (logo.formats || []).find((f: LogoFormat) => f.format === "svg");
    if (svg?.src) {
      try {
        const svgRes = await fetch(svg.src);
        if (svgRes.ok) {
          const svgText = await svgRes.text();
          return {
            domain: input.domain,
            type: targetType,
            theme: logo.theme || "default",
            svg: svgText,
          };
        }
      } catch {
        // continue trying other logos
      }
    }
  }

  // No SVG for the requested type — report what's available
  const available = (brand.logos || []).map((l: BrandLogo) => ({
    type: l.type,
    theme: l.theme,
    formats: (l.formats || []).map((f: LogoFormat) => f.format),
    has_svg: (l.formats || []).some((f: LogoFormat) => f.format === "svg"),
  }));

  const svgTypes = available.filter(a => a.has_svg).map(a => `${a.type} (${a.theme})`);

  return {
    error: `No SVG available for type '${targetType}'${targetTheme ? ` theme '${targetTheme}'` : ""}`,
    svg_available_for: svgTypes.length > 0 ? svgTypes : "none",
    all_logos: available,
  };
}

// ── Types (subset of Brandfetch response) ────────────────────────────────────

interface LogoFormat {
  src: string;
  format: string;
  theme?: string;
  width?: number;
  height?: number;
}

interface BrandLogo {
  type: string;
  theme?: string;
  formats?: LogoFormat[];
}

interface BrandImage {
  type: string;
  formats?: LogoFormat[];
}

interface BrandResponse {
  name: string;
  domain: string;
  claimed?: boolean;
  description?: string;
  longDescription?: string;
  qualityScore?: number;
  logos?: BrandLogo[];
  colors?: unknown[];
  fonts?: unknown[];
  images?: BrandImage[];
  links?: unknown[];
  company?: unknown;
}
