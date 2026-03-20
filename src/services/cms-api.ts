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
