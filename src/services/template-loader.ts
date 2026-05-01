import { getContentType } from "./cms-api.js";
import { buildPropertiesFromContentType, TEMPLATE_FORMAT_VERSION } from "./template-builder.js";
import { stableHash } from "./hash.js";
import { getTemplate, saveTemplate } from "./template-store.js";
import { log } from "./log.js";
import type { CmsContentType, Template } from "../types.js";

/**
 * Load a Template from the cache, building (and persisting) it if missing
 * and rebuilding on schema drift. Centralizes the introspect → cache → reuse
 * flow so every tool that needs a template (get_page, create_page,
 * update_page, create_template) shares one cache entry per content type.
 *
 * Behavior:
 *   - Cache hit + matching live hash → return cached, no rebuild.
 *   - Cache hit + drift              → rebuild + save + return.
 *   - Cache hit, drift check fails   → return cached (stale beats nothing).
 *   - Cache miss                     → build + save + return.
 *   - force=true                     → ignore cache, always rebuild.
 *
 * Persistence depends on the template store backend: Upstash Redis (set
 * CMS_KV_REST_API_URL + CMS_KV_REST_API_TOKEN, or the un-prefixed equivalents)
 * survives across Lambda invocations and threads. Without those env vars, the
 * in-memory fallback is per-process and the cache effectively never hits in
 * serverless deployments.
 */
export async function loadOrBuildTemplate(
  contentTypeName: string,
  graphKey: string | undefined,
  clientId: string,
  clientSecret: string,
  options: { force?: boolean } = {}
): Promise<Template | null> {
  const cached = options.force
    ? null
    : await getTemplate(contentTypeName).catch(() => null);

  // A cached template with a stale formatVersion is treated the same as a
  // schema-hash mismatch — rebuild + overwrite. This is what kicks the
  // wrapped-example refresh in once the new code ships, without needing a
  // manual force=true sweep across every cached type.
  const formatStale =
    cached !== null && (cached.formatVersion ?? 1) !== TEMPLATE_FORMAT_VERSION;

  if (cached?.schemaHash && graphKey && !formatStale) {
    try {
      const liveCt = await getContentType(clientId, clientSecret, contentTypeName);
      const liveHash = stableHash(liveCt.properties ?? {});
      if (liveHash === cached.schemaHash) {
        return cached;
      }
      log.warn("template_loader.drift_detected", {
        contentType: contentTypeName,
        cachedHash: cached.schemaHash,
        liveHash,
      });
      return await buildAndSave(contentTypeName, liveCt, graphKey);
    } catch (e) {
      log.warn("template_loader.drift_check_failed", {
        contentType: contentTypeName,
        error: { message: e instanceof Error ? e.message : String(e) },
      });
      return cached;
    }
  }

  if (formatStale && graphKey) {
    log.warn("template_loader.format_version_stale", {
      contentType: contentTypeName,
      cachedFormatVersion: cached?.formatVersion ?? 1,
      currentFormatVersion: TEMPLATE_FORMAT_VERSION,
    });
    try {
      const liveCt = await getContentType(clientId, clientSecret, contentTypeName);
      return await buildAndSave(contentTypeName, liveCt, graphKey);
    } catch (e) {
      log.warn("template_loader.format_refresh_failed", {
        contentType: contentTypeName,
        error: { message: e instanceof Error ? e.message : String(e) },
      });
      return cached;
    }
  }

  if (cached) return cached;

  if (!graphKey) return null;

  try {
    const liveCt = await getContentType(clientId, clientSecret, contentTypeName);
    return await buildAndSave(contentTypeName, liveCt, graphKey);
  } catch (e) {
    log.warn("template_loader.build_failed", {
      contentType: contentTypeName,
      error: { message: e instanceof Error ? e.message : String(e) },
    });
    return null;
  }
}

async function buildAndSave(
  contentTypeName: string,
  liveCt: CmsContentType,
  graphKey: string
): Promise<Template | null> {
  if (!liveCt.properties || Object.keys(liveCt.properties).length === 0) {
    return null;
  }
  const { properties, contentReferences, submissionExample } =
    await buildPropertiesFromContentType(liveCt, graphKey);
  const template: Template = {
    name: contentTypeName,
    contentType: contentTypeName,
    properties,
    contentReferences,
    submissionExample,
    createdAt: new Date().toISOString(),
    schemaHash: stableHash(liveCt.properties ?? {}),
    formatVersion: TEMPLATE_FORMAT_VERSION,
  };
  await saveTemplate(template);
  return template;
}
