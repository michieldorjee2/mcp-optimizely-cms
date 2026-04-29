import { z } from "zod";
import { createContent } from "../services/cms-api.js";
import { getTemplate } from "../services/template-store.js";
import { createTemplate } from "./create-template.js";
import { hasRedis } from "../services/env.js";
import { stableHash } from "../services/hash.js";
import { log } from "../services/log.js";
import type { Template, TemplateProperty } from "../types.js";

const DEFAULT_PARENT_ID = "3fbbcee66f954d089df0f4e62b75ca3c";

export const createPageSchema = z.object({
  contentType: z
    .string()
    .describe(
      "The content type key — the name of the content model in Optimizely. Examples: 'CompetitorComparisonPage', 'ArticlePage', 'StandardPage'. Find available types via list_page_templates."
    ),
  name: z
    .string()
    .describe(
      "Display name shown in the CMS UI and used as the default for the URL slug if routeSegment isn't passed. Example: 'Amazon vs Adobe Experience Manager'."
    ),
  locale: z
    .string()
    .default("en")
    .describe(
      "Content locale code. Common values: 'en', 'fr', 'de', 'es'. Defaults to 'en'."
    ),
  parentId: z
    .string()
    .default(DEFAULT_PARENT_ID)
    .describe(
      "Content ID (32-char hex) of the parent container — the folder/section the page lives under. Defaults to the site root container. To place under a different container, fetch its id with get_page."
    ),
  status: z
    .string()
    .default("published")
    .describe(
      "Initial status. 'published' (default) makes the page live immediately. 'draft' creates it without publishing — useful for staging before going live."
    ),
  routeSegment: z
    .string()
    .describe(
      "URL slug — the last path segment of the page URL. Lowercase, hyphenated, no spaces or special characters. Example: 'amazon-vs-aem'. If you skip this, Optimizely auto-derives an unfriendly slug from the display name."
    ),
  propertiesJson: z
    .string()
    .describe(
      "JSON-encoded object of property values. Each top-level key matches a field on the content type. Optimizely wraps primitive values in {\"value\": ...} and components/arrays-of-components in nested {\"value\": [...]} or {\"properties\": {...}} structures — call create_template or get_page on a similar page to see the exact expected shape. Example: '{\"headline\": {\"value\": \"Hello\"}, \"body\": {\"value\": \"World\"}}'."
    ),
  idempotencyKey: z
    .string()
    .optional()
    .describe(
      "Optional unique key to make this create_page call replay-safe. If you retry with the same key (within 24h), the same contentId is returned without creating a duplicate page. Recommended for any retryable workflow — e.g. an agent loop that may re-invoke after a network blip. Use any stable string: a UUID, a content hash, or the page's intended slug + locale."
    ),
});

export type CreatePageInput = z.infer<typeof createPageSchema>;

// ---------------------------------------------------------------------------
// Deep validation — checks required, enums, array bounds, string lengths
// ---------------------------------------------------------------------------

interface ValidationError {
  key: string;
  message: string;
}

function validateProperties(
  properties: Record<string, unknown>,
  templateProps: TemplateProperty[]
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const prop of templateProps) {
    const value = properties[prop.key];

    // Required check
    if (prop.required && (value === undefined || value === null)) {
      errors.push({ key: prop.key, message: `Required property '${prop.key}' is missing.` });
      continue; // skip further checks if missing
    }

    // Skip further validation if not provided and not required
    if (value === undefined || value === null) continue;

    // Enum validation
    if (prop.enumValues && prop.enumValues.length > 0) {
      const strVal = String(value);
      if (!prop.enumValues.includes(strVal)) {
        errors.push({
          key: prop.key,
          message: `'${prop.key}' value '${strVal}' is not allowed. Must be one of: ${prop.enumValues.join(", ")}`,
        });
      }
    }

    // Array constraints
    if (Array.isArray(value)) {
      if (prop.minItems != null && value.length < prop.minItems) {
        errors.push({
          key: prop.key,
          message: `'${prop.key}' has ${value.length} items but requires at least ${prop.minItems}.`,
        });
      }
      if (prop.maxItems != null && value.length > prop.maxItems) {
        errors.push({
          key: prop.key,
          message: `'${prop.key}' has ${value.length} items but allows at most ${prop.maxItems}.`,
        });
      }
    }

    // String constraints
    if (typeof value === "string") {
      if (prop.minLength != null && value.length < prop.minLength) {
        errors.push({
          key: prop.key,
          message: `'${prop.key}' is ${value.length} chars but requires at least ${prop.minLength}.`,
        });
      }
      if (prop.maxLength != null && value.length > prop.maxLength) {
        errors.push({
          key: prop.key,
          message: `'${prop.key}' is ${value.length} chars but allows at most ${prop.maxLength}.`,
        });
      }
      if (prop.pattern) {
        try {
          const re = new RegExp(prop.pattern);
          if (!re.test(value)) {
            errors.push({
              key: prop.key,
              message: `'${prop.key}' does not match required pattern: ${prop.pattern}`,
            });
          }
        } catch { /* skip invalid regex */ }
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Idempotency helpers — store the contentId of a successful create_page
// keyed by (idempotencyKey, hash-of-args) so retries return the same id
// instead of creating duplicates. 24h TTL.
// ---------------------------------------------------------------------------

interface IdempotentResult {
  contentId: string;
  displayName?: string;
  contentType?: string[];
  status?: string;
  ts: string;
}

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

function idempotencyCacheKey(callerKey: string, argsHash: string): string {
  return `create_page:idem:${callerKey}:${argsHash}`;
}

async function readIdempotent(callerKey: string, argsHash: string): Promise<IdempotentResult | null> {
  if (!hasRedis()) return null;
  try {
    const { Redis } = await import("@upstash/redis");
    const redis = new Redis({
      url: process.env.KV_REST_API_URL!,
      token: process.env.KV_REST_API_TOKEN!,
    });
    const raw = await redis.get<IdempotentResult | string>(idempotencyCacheKey(callerKey, argsHash));
    if (!raw) return null;
    return typeof raw === "string" ? (JSON.parse(raw) as IdempotentResult) : (raw as IdempotentResult);
  } catch (e) {
    log.warn("create_page.idempotency_read_failed", {
      error: { message: e instanceof Error ? e.message : String(e) },
    });
    return null;
  }
}

async function writeIdempotent(
  callerKey: string,
  argsHash: string,
  result: IdempotentResult
): Promise<void> {
  if (!hasRedis()) return;
  try {
    const { Redis } = await import("@upstash/redis");
    const redis = new Redis({
      url: process.env.KV_REST_API_URL!,
      token: process.env.KV_REST_API_TOKEN!,
    });
    await redis.set(idempotencyCacheKey(callerKey, argsHash), JSON.stringify(result), {
      ex: IDEMPOTENCY_TTL_SECONDS,
    });
  } catch (e) {
    log.warn("create_page.idempotency_write_failed", {
      error: { message: e instanceof Error ? e.message : String(e) },
    });
  }
}

// ---------------------------------------------------------------------------
// Main create_page handler
// ---------------------------------------------------------------------------

export async function createPage(
  input: CreatePageInput,
  clientId: string,
  clientSecret: string,
  graphKey?: string
) {
  // Parse properties from JSON string
  let properties: Record<string, unknown> = {};
  try {
    properties = JSON.parse(input.propertiesJson || "{}");
  } catch {
    return { success: false, error: "Invalid JSON in propertiesJson. Must be a valid JSON object." };
  }

  // Idempotency check: if the caller passed an idempotencyKey AND the same
  // (key, args-hash) pair was used recently, return the cached contentId
  // instead of creating a duplicate page.
  const argsHashForIdempotency = stableHash({
    contentType: input.contentType,
    name: input.name,
    locale: input.locale,
    parentId: input.parentId,
    status: input.status,
    routeSegment: input.routeSegment,
    properties,
  });
  if (input.idempotencyKey) {
    const cached = await readIdempotent(input.idempotencyKey, argsHashForIdempotency);
    if (cached) {
      return {
        success: true,
        idempotent: true,
        contentId: cached.contentId,
        displayName: cached.displayName,
        contentType: cached.contentType,
        status: cached.status,
        message: `Returned cached result for idempotencyKey '${input.idempotencyKey}' (created at ${cached.ts}).`,
      };
    }
  }

  // Try to load existing template, or auto-create one from CMS content type API
  let template: Template | null = await getTemplate(input.contentType).catch(() => null);

  if (!template && graphKey) {
    try {
      const result = await createTemplate(
        { contentTypeName: input.contentType, force: false },
        graphKey,
        clientId,
        clientSecret
      );
      if (result.success) {
        template = await getTemplate(input.contentType).catch(() => null);
      }
    } catch {
      // If auto-introspection fails, proceed without template
    }
  }

  // Validate against template
  if (template) {
    const errors = validateProperties(properties, template.properties);
    if (errors.length > 0) {
      return {
        success: false,
        error: `Validation failed for ${input.contentType}: ${errors.map((e) => e.message).join("; ")}`,
        validationErrors: errors,
        template: template.properties,
      };
    }
  }

  const body = {
    contentType: input.contentType,
    displayName: input.name,
    locale: input.locale,
    status: input.status || "published",
    container: input.parentId || DEFAULT_PARENT_ID,
    routeSegment: input.routeSegment,
    ...(Object.keys(properties).length > 0 && { properties }),
  };

  const result = await createContent(clientId, clientSecret, body);

  // Stash the successful result for idempotent replay.
  if (input.idempotencyKey) {
    await writeIdempotent(input.idempotencyKey, argsHashForIdempotency, {
      contentId: result.key,
      displayName: result.displayName,
      contentType: result.contentType,
      status: result.status,
      ts: new Date().toISOString(),
    });
  }

  return {
    success: true,
    contentId: result.key,
    displayName: result.displayName,
    contentType: result.contentType,
    status: result.status,
    ...(template ? { templateUsed: true } : {}),
  };
}
