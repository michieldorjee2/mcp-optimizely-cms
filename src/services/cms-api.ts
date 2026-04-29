import type { CmsContentBody, CmsContentResponse, CmsTokenResponse, CmsContentType } from "../types.js";

const CMS_API_BASE = "https://api.cms.optimizely.com";
const CMS_API_VERSION = "preview3/experimental";

let cachedToken: { token: string; expiresAt: number } | null = null;

export async function getCmsToken(clientId: string, clientSecret: string): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }

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
    throw new Error(`CMS auth failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as CmsTokenResponse;
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 30) * 1000,
  };
  return cachedToken.token;
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

export async function createContent(
  clientId: string,
  clientSecret: string,
  body: CmsContentBody
): Promise<CmsContentResponse> {
  const headers = await cmsHeaders(clientId, clientSecret);
  const response = await fetch(`${CMS_API_BASE}/${CMS_API_VERSION}/content`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Create content failed (${response.status}): ${text}`);
  }

  return (await response.json()) as CmsContentResponse;
}

export async function getContent(
  clientId: string,
  clientSecret: string,
  contentId: string
): Promise<{ data: CmsContentResponse; etag: string }> {
  const headers = await cmsHeaders(clientId, clientSecret);
  const response = await fetch(`${CMS_API_BASE}/${CMS_API_VERSION}/content/${contentId}`, {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Get content failed (${response.status}): ${text}`);
  }

  const etag = response.headers.get("etag") || "";
  const data = (await response.json()) as CmsContentResponse;
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

  const response = await fetch(`${CMS_API_BASE}/${CMS_API_VERSION}/content/${contentId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Update content failed (${response.status}): ${text}`);
  }

  return (await response.json()) as CmsContentResponse;
}

// ---------------------------------------------------------------------------
// Version-aware update flow
// ---------------------------------------------------------------------------
// PATCH /content/{key} only updates content-level metadata (e.g. container,
// routeSegment). Per-version data — displayName, properties, locale — must
// be patched on a specific version, and status transitions go through the
// dedicated :publish / :ready / :draft endpoints.
//
// See: https://docs.developers.optimizely.com/content-management-system/v1.0.0-CMS-SaaS/docs/manage-content-using-the-rest-api
// ---------------------------------------------------------------------------

export interface CmsVersionSummary {
  key: string;
  displayName?: string;
  contentType?: string[];
  locale?: string;
  status?: string;
  _metadata?: { version?: string };
  // Some shapes expose version at top-level
  version?: string;
}

export async function listVersions(
  clientId: string,
  clientSecret: string,
  contentId: string,
  locale?: string
): Promise<CmsVersionSummary[]> {
  const headers = await cmsHeaders(clientId, clientSecret);
  const url = new URL(`${CMS_API_BASE}/${CMS_API_VERSION}/content/${contentId}/versions`);
  if (locale) url.searchParams.set("locale", locale);
  const response = await fetch(url.toString(), { method: "GET", headers });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`List versions failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { items?: CmsVersionSummary[] } | CmsVersionSummary[];
  if (Array.isArray(data)) return data;
  return data.items ?? [];
}

export async function createVersion(
  clientId: string,
  clientSecret: string,
  contentId: string,
  body: { displayName?: string; locale?: string; properties?: Record<string, unknown> }
): Promise<CmsVersionSummary> {
  const headers = await cmsHeaders(clientId, clientSecret);
  const response = await fetch(
    `${CMS_API_BASE}/${CMS_API_VERSION}/content/${contentId}/versions`,
    { method: "POST", headers, body: JSON.stringify(body) }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Create version failed (${response.status}): ${text}`);
  }

  return (await response.json()) as CmsVersionSummary;
}

export async function getVersion(
  clientId: string,
  clientSecret: string,
  contentId: string,
  versionId: string
): Promise<{ data: CmsVersionSummary; etag: string }> {
  const headers = await cmsHeaders(clientId, clientSecret);
  const response = await fetch(
    `${CMS_API_BASE}/${CMS_API_VERSION}/content/${contentId}/versions/${versionId}`,
    { method: "GET", headers }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Get version failed (${response.status}): ${text}`);
  }

  const etag = response.headers.get("etag") || "";
  const data = (await response.json()) as CmsVersionSummary;
  return { data, etag };
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

  const response = await fetch(
    `${CMS_API_BASE}/${CMS_API_VERSION}/content/${contentId}/versions/${versionId}`,
    { method: "PATCH", headers, body: JSON.stringify(body) }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Patch version failed (${response.status}): ${text}`);
  }

  return (await response.json()) as CmsVersionSummary;
}

export async function publishVersion(
  clientId: string,
  clientSecret: string,
  contentId: string,
  versionId: string,
  etag?: string
): Promise<CmsVersionSummary> {
  const headers = await cmsHeaders(clientId, clientSecret, etag ? { "If-Match": etag } : {});
  const response = await fetch(
    `${CMS_API_BASE}/${CMS_API_VERSION}/content/${contentId}/versions/${versionId}:publish`,
    { method: "POST", headers, body: JSON.stringify({}) }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Publish version failed (${response.status}): ${text}`);
  }

  return (await response.json()) as CmsVersionSummary;
}

export async function getContentType(
  clientId: string,
  clientSecret: string,
  key: string
): Promise<CmsContentType> {
  const headers = await cmsHeaders(clientId, clientSecret);
  const response = await fetch(`${CMS_API_BASE}/preview3/contenttypes/${encodeURIComponent(key)}`, {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Get content type failed (${response.status}): ${text}`);
  }

  return (await response.json()) as CmsContentType;
}

export async function listContentTypes(
  clientId: string,
  clientSecret: string
): Promise<unknown[]> {
  const headers = await cmsHeaders(clientId, clientSecret);
  const response = await fetch(`${CMS_API_BASE}/preview3/contenttypes`, {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`List content types failed (${response.status}): ${text}`);
  }

  const result = (await response.json()) as { items: unknown[] };
  return result.items;
}
