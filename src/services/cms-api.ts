import type { CmsContentBody, CmsContentResponse, CmsContentType } from "../types.js";
import { buildCmsApiError, CmsApiError } from "./errors.js";
import { withRetry } from "./retry.js";
import {
  ContentResponseSchema,
  ContentTypeSchema,
  ContentTypeListSchema,
  TokenResponseSchema,
  VersionListResponseSchema,
} from "./schemas.js";
import { kvCreds } from "./env.js";

const CMS_API_BASE = "https://api.cms.optimizely.com";
const CMS_API_VERSION = "preview3/experimental";
// The /preview3/experimental/ prefix doesn't expose the versions subresource
// or the publish transition endpoints — those live on the /v1/ surface.
const CMS_API_V1 = "v1";

// ---------------------------------------------------------------------------
// OAuth token cache
//
// Two layers:
//   1. Process-local Map (warm-instance fast path, free).
//   2. Upstash Redis (shared across cold starts) when configured.
//
// The Vercel docs say cold starts cost a few hundred ms; OAuth round-trip
// adds another 100-300ms, so caching across cold starts is meaningful.
// ---------------------------------------------------------------------------

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

let memoryToken: CachedToken | null = null;

const REDIS_TOKEN_KEY = (clientId: string) => `cms:token:${clientId}`;

async function readRedisToken(clientId: string): Promise<CachedToken | null> {
  const creds = kvCreds();
  if (!creds) return null;
  try {
    const { Redis } = await import("@upstash/redis");
    const redis = new Redis({ url: creds.url, token: creds.token });
    const raw = await redis.get<CachedToken | string>(REDIS_TOKEN_KEY(clientId));
    if (!raw) return null;
    return typeof raw === "string" ? (JSON.parse(raw) as CachedToken) : (raw as CachedToken);
  } catch {
    return null; // best-effort
  }
}

async function writeRedisToken(clientId: string, token: CachedToken): Promise<void> {
  const creds = kvCreds();
  if (!creds) return;
  try {
    const { Redis } = await import("@upstash/redis");
    const redis = new Redis({ url: creds.url, token: creds.token });
    const ttlSeconds = Math.max(60, Math.floor((token.expiresAt - Date.now()) / 1000));
    await redis.set(REDIS_TOKEN_KEY(clientId), JSON.stringify(token), { ex: ttlSeconds });
  } catch {
    // best-effort
  }
}

export async function getCmsToken(clientId: string, clientSecret: string): Promise<string> {
  const now = Date.now();

  // 1. process-local
  if (memoryToken && now < memoryToken.expiresAt) return memoryToken.token;

  // 2. shared (Redis)
  const shared = await readRedisToken(clientId);
  if (shared && now < shared.expiresAt) {
    memoryToken = shared;
    return shared.token;
  }

  // 3. fetch fresh
  const params = new URLSearchParams();
  params.set("grant_type", "client_credentials");
  params.set("client_id", clientId);
  params.set("client_secret", clientSecret);

  const response = await fetch(`${CMS_API_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw buildCmsApiError({
      status: response.status,
      endpoint: "/oauth/token",
      method: "POST",
      bodyText: text,
    });
  }

  const parsed = TokenResponseSchema.parse(await response.json());
  const cached: CachedToken = {
    token: parsed.access_token,
    expiresAt: now + (parsed.expires_in - 30) * 1000,
  };
  memoryToken = cached;
  await writeRedisToken(clientId, cached);
  return cached.token;
}

async function cmsHeaders(clientId: string, clientSecret: string, extra?: Record<string, string>) {
  const token = await getCmsToken(clientId, clientSecret);
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "mcp-optimizely-cms/1.0.0",
    Accept: "application/json",
    ...extra,
  };
}

/**
 * Wrap a fetch + parse pipeline in retry + structured error construction.
 * On non-2xx, throws the right CmsApiError subclass; the body text is read
 * exactly once. On JSON parse failure, throws CmsApiError too.
 */
async function cmsFetch(args: {
  endpoint: string;
  method: string;
  init: RequestInit;
}): Promise<Response> {
  return withRetry(async () => {
    const response = await fetch(`${CMS_API_BASE}${args.endpoint}`, args.init);
    if (!response.ok) {
      const text = await response.text();
      throw buildCmsApiError({
        status: response.status,
        endpoint: args.endpoint,
        method: args.method,
        bodyText: text,
      });
    }
    return response;
  });
}

// ---------------------------------------------------------------------------
// Content (preview3/experimental) — used for create / read metadata / patch
// ---------------------------------------------------------------------------

export async function createContent(
  clientId: string,
  clientSecret: string,
  body: CmsContentBody
): Promise<CmsContentResponse> {
  const headers = await cmsHeaders(clientId, clientSecret);
  const response = await cmsFetch({
    endpoint: `/${CMS_API_VERSION}/content`,
    method: "POST",
    init: { method: "POST", headers, body: JSON.stringify(body) },
  });
  return ContentResponseSchema.parse(await response.json()) as CmsContentResponse;
}

export async function getContent(
  clientId: string,
  clientSecret: string,
  contentId: string
): Promise<{ data: CmsContentResponse; etag: string }> {
  const headers = await cmsHeaders(clientId, clientSecret);
  const response = await cmsFetch({
    endpoint: `/${CMS_API_VERSION}/content/${contentId}`,
    method: "GET",
    init: { method: "GET", headers },
  });
  const etag = response.headers.get("etag") || "";
  const data = ContentResponseSchema.parse(await response.json()) as CmsContentResponse;
  return { data, etag };
}

/**
 * Same as getContent but hits /v1/content/{key}. The /v1/ surface returns
 * the full metadata (including routeSegment in some tenants) while
 * /preview3/experimental/ returns a stripped-down metadata shape.
 */
export async function getContentV1(
  clientId: string,
  clientSecret: string,
  contentId: string
): Promise<{ data: CmsContentResponse; etag: string }> {
  const headers = await cmsHeaders(clientId, clientSecret);
  const response = await cmsFetch({
    endpoint: `/${CMS_API_V1}/content/${contentId}`,
    method: "GET",
    init: { method: "GET", headers },
  });
  const etag = response.headers.get("etag") || "";
  const data = ContentResponseSchema.parse(await response.json()) as CmsContentResponse;
  return { data, etag };
}

export async function updateContent(
  clientId: string,
  clientSecret: string,
  contentId: string,
  body: Record<string, unknown>,
  etag: string
): Promise<CmsContentResponse> {
  const headers = await cmsHeaders(clientId, clientSecret, {
    "Content-Type": "application/merge-patch+json",
    "If-Match": etag,
  });
  const response = await cmsFetch({
    endpoint: `/${CMS_API_VERSION}/content/${contentId}`,
    method: "PATCH",
    init: { method: "PATCH", headers, body: JSON.stringify(body) },
  });
  return ContentResponseSchema.parse(await response.json()) as CmsContentResponse;
}

// ---------------------------------------------------------------------------
// Versions (v1) — fork, edit, publish
// ---------------------------------------------------------------------------

export interface CmsVersionSummary {
  key: string;
  displayName?: string;
  // Preview3 returns string, v1 returns string[]. Consumers handle both
  // shapes — see services/schemas.ts comment for the surface split.
  contentType?: string | string[];
  locale?: string;
  status?: string;
  /** Some Optimizely tenants put routeSegment on the version, not the content. */
  routeSegment?: string;
  properties?: Record<string, unknown>;
  _metadata?: { version?: string };
  /** Some shapes expose version at top-level. */
  version?: string;
}

export async function listVersions(
  clientId: string,
  clientSecret: string,
  contentId: string,
  options?: { locales?: string[]; statuses?: string[] }
): Promise<CmsVersionSummary[]> {
  const headers = await cmsHeaders(clientId, clientSecret);
  const url = new URL(`${CMS_API_BASE}/${CMS_API_V1}/content/${contentId}/versions`);
  if (options?.locales?.length) url.searchParams.set("locales", options.locales.join(","));
  if (options?.statuses?.length) url.searchParams.set("statuses", options.statuses.join(","));
  const path = url.pathname + url.search;

  const response = await cmsFetch({
    endpoint: path,
    method: "GET",
    init: { method: "GET", headers },
  });

  const raw = await response.json();
  const parsed = VersionListResponseSchema.parse(raw);
  if (Array.isArray(parsed)) return parsed as CmsVersionSummary[];
  return parsed.items as CmsVersionSummary[];
}

/**
 * Pull a version id out of a Location header like
 *   /v1/content/{key}/versions/1253
 * or the full URL form. Returns undefined if no match.
 */
function versionIdFromLocation(location: string | null): string | undefined {
  if (!location) return undefined;
  const match = location.match(/\/versions\/([^/?#]+)/);
  return match?.[1];
}

export async function createVersion(
  clientId: string,
  clientSecret: string,
  contentId: string,
  body: {
    displayName?: string;
    locale?: string;
    routeSegment?: string;
    properties?: Record<string, unknown>;
  }
): Promise<CmsVersionSummary> {
  const headers = await cmsHeaders(clientId, clientSecret);
  const response = await cmsFetch({
    endpoint: `/${CMS_API_V1}/content/${contentId}/versions`,
    method: "POST",
    init: { method: "POST", headers, body: JSON.stringify(body) },
  });

  // Optimizely returns 201 Created with Location: /v1/content/{key}/versions/{id}
  // and may return no body. Read once as text and JSON-parse only if there's
  // content.
  const text = await response.text();
  const locationVersion = versionIdFromLocation(response.headers.get("location"));

  if (text.trim().length === 0) {
    if (!locationVersion) {
      throw new CmsApiError(
        "createVersion succeeded but the response had no body and no Location header.",
        {
          status: response.status,
          endpoint: `/${CMS_API_V1}/content/${contentId}/versions`,
          method: "POST",
          body: undefined,
        }
      );
    }
    return {
      key: contentId,
      _metadata: { version: locationVersion },
      displayName: body.displayName,
      locale: body.locale,
      routeSegment: body.routeSegment,
    };
  }

  let parsed: CmsVersionSummary;
  try {
    parsed = ContentResponseSchema.parse(JSON.parse(text)) as CmsVersionSummary;
  } catch (e) {
    throw new CmsApiError(
      `createVersion response body was not the expected shape: ${(e as Error).message}`,
      {
        status: response.status,
        endpoint: `/${CMS_API_V1}/content/${contentId}/versions`,
        method: "POST",
        body: text.slice(0, 500),
        cause: e,
      }
    );
  }
  if (!parsed._metadata?.version && !parsed.version && locationVersion) {
    parsed._metadata = { ...(parsed._metadata ?? {}), version: locationVersion };
  }
  return parsed;
}

export async function getVersion(
  clientId: string,
  clientSecret: string,
  contentId: string,
  versionId: string
): Promise<{ data: CmsVersionSummary; etag: string }> {
  const headers = await cmsHeaders(clientId, clientSecret);
  const response = await cmsFetch({
    endpoint: `/${CMS_API_V1}/content/${contentId}/versions/${versionId}`,
    method: "GET",
    init: { method: "GET", headers },
  });
  const etag = response.headers.get("etag") || "";
  const data = ContentResponseSchema.parse(await response.json()) as CmsVersionSummary;
  return { data, etag };
}

async function safeJsonOrEmpty(response: Response): Promise<CmsVersionSummary> {
  const text = await response.text();
  if (text.trim().length === 0) return {} as CmsVersionSummary;
  return ContentResponseSchema.parse(JSON.parse(text)) as CmsVersionSummary;
}

export async function patchVersion(
  clientId: string,
  clientSecret: string,
  contentId: string,
  versionId: string,
  body: Record<string, unknown>,
  etag: string
): Promise<CmsVersionSummary> {
  const headers = await cmsHeaders(clientId, clientSecret, {
    "Content-Type": "application/merge-patch+json",
    ...(etag ? { "If-Match": etag } : {}),
  });

  const response = await cmsFetch({
    endpoint: `/${CMS_API_V1}/content/${contentId}/versions/${versionId}`,
    method: "PATCH",
    init: { method: "PATCH", headers, body: JSON.stringify(body) },
  });

  return await safeJsonOrEmpty(response);
}

export async function publishVersion(
  clientId: string,
  clientSecret: string,
  contentId: string,
  versionId: string,
  etag?: string
): Promise<CmsVersionSummary> {
  const headers = await cmsHeaders(clientId, clientSecret, etag ? { "If-Match": etag } : {});
  const response = await cmsFetch({
    endpoint: `/${CMS_API_V1}/content/${contentId}/versions/${versionId}:publish`,
    method: "POST",
    init: { method: "POST", headers, body: JSON.stringify({}) },
  });

  const parsed = await safeJsonOrEmpty(response);
  if (!parsed.status) parsed.status = "published";
  return parsed;
}

// ---------------------------------------------------------------------------
// Content types (used by create_template + create_page validation)
// ---------------------------------------------------------------------------

export async function getContentType(
  clientId: string,
  clientSecret: string,
  key: string
): Promise<CmsContentType> {
  const headers = await cmsHeaders(clientId, clientSecret);
  const response = await cmsFetch({
    endpoint: `/preview3/contenttypes/${encodeURIComponent(key)}`,
    method: "GET",
    init: { method: "GET", headers },
  });
  return ContentTypeSchema.parse(await response.json()) as CmsContentType;
}

export async function listContentTypes(
  clientId: string,
  clientSecret: string
): Promise<unknown[]> {
  const headers = await cmsHeaders(clientId, clientSecret);
  const response = await cmsFetch({
    endpoint: `/preview3/contenttypes`,
    method: "GET",
    init: { method: "GET", headers },
  });
  const parsed = ContentTypeListSchema.parse(await response.json());
  return parsed.items;
}
