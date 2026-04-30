import { z } from "zod";

/**
 * Runtime schemas for every Optimizely response shape we touch.
 *
 * The point isn't to mirror Optimizely's full type system — it's to:
 *   1. Catch breaking API changes loudly (instead of silent undefineds —
 *      this is the bug pattern that hid the routeSegment-on-version
 *      discovery for hours).
 *   2. Carry the schema next to the type, so a single source of truth.
 *
 * All schemas use .passthrough() so unknown fields don't fail validation —
 * Optimizely's responses include lots of metadata we don't care about.
 *
 * Use safeParse() at API boundaries (services/cms-api.ts) so the error
 * message includes the failing field path. parse() is fine in tools where
 * we want a typed value or a thrown error.
 */

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const TokenResponseSchema = z
  .object({
    access_token: z.string(),
    expires_in: z.number(),
    token_type: z.string().optional(),
  })
  .passthrough();

export type TokenResponse = z.infer<typeof TokenResponseSchema>;

// ---------------------------------------------------------------------------
// Content + version shapes (CMS REST API)
// ---------------------------------------------------------------------------

export const VersionMetadataSchema = z
  .object({
    version: z.string().optional(),
  })
  .passthrough();

/**
 * Used for both content reads and version reads. Optimizely returns slightly
 * different shapes from /preview3/experimental/content/{key} (metadata-only)
 * vs /v1/content/{key}/versions/{id} (full version data) — the schema is
 * permissive so both validate; calling code reads what it needs.
 */
export const ContentResponseSchema = z
  .object({
    key: z.string(),
    displayName: z.string().optional(),
    // CMS returns contentType as a string from /preview3/experimental/content
    // and as a string[] (type ancestry) from /v1/content. Accept both; consumers
    // (e.g. get-page.ts) already coerce to a single name.
    contentType: z.union([z.string(), z.array(z.string())]).optional(),
    locale: z.string().optional(),
    status: z.string().optional(),
    routeSegment: z.string().optional(),
    container: z.string().optional(),
    properties: z.record(z.unknown()).optional(),
    _metadata: VersionMetadataSchema.optional(),
    version: z.string().optional(),
  })
  .passthrough();

export type ContentResponse = z.infer<typeof ContentResponseSchema>;

export const VersionListResponseSchema = z.union([
  z.array(ContentResponseSchema),
  z.object({ items: z.array(ContentResponseSchema).default([]) }).passthrough(),
]);

// ---------------------------------------------------------------------------
// Content types
// ---------------------------------------------------------------------------

export const ContentTypePropertySchema = z
  .object({
    type: z.string(),
    format: z.string().nullable().optional(),
    contentType: z.string().nullable().optional(),
    displayName: z.string().optional(),
    description: z.string().optional(),
    localized: z.boolean().optional(),
    required: z.boolean().optional(),
    group: z.string().optional(),
    sortOrder: z.number().optional(),
    minLength: z.number().nullable().optional(),
    maxLength: z.number().nullable().optional(),
    pattern: z.string().nullable().optional(),
    minItems: z.number().nullable().optional(),
    maxItems: z.number().nullable().optional(),
    allowedTypes: z.array(z.string()).optional(),
    restrictedTypes: z.array(z.string()).optional(),
    items: z
      .object({
        type: z.string().optional(),
        contentType: z.string().optional(),
        allowedTypes: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    enum: z.array(z.object({ value: z.string(), displayName: z.string().optional() })).optional(),
  })
  .passthrough();

export const ContentTypeSchema = z
  .object({
    key: z.string(),
    displayName: z.string().optional(),
    description: z.string().optional(),
    baseType: z.string().optional(),
    properties: z.record(ContentTypePropertySchema).optional(),
  })
  .passthrough();

export const ContentTypeListSchema = z
  .object({ items: z.array(z.unknown()).default([]) })
  .passthrough();

// ---------------------------------------------------------------------------
// Graph (Content Cloud) responses
// ---------------------------------------------------------------------------

export const GraphContentMatchSchema = z
  .object({
    _metadata: z
      .object({
        key: z.string().optional(),
        displayName: z.string().optional(),
        types: z.array(z.string()).optional(),
        locale: z.string().optional(),
        url: z
          .object({
            default: z.string().nullable().optional(),
            hierarchical: z.string().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
        routeSegment: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const GraphContentResponseSchema = z
  .object({
    data: z
      .object({
        _Content: z
          .object({
            items: z.array(GraphContentMatchSchema).default([]),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    errors: z.array(z.object({ message: z.string() }).passthrough()).optional(),
  })
  .passthrough();

export const GraphIntrospectionResponseSchema = z
  .object({
    data: z
      .object({
        __type: z
          .object({
            name: z.string().optional(),
            kind: z.string().optional(),
            fields: z
              .array(
                z
                  .object({
                    name: z.string(),
                    description: z.string().nullable().optional(),
                    type: z.unknown(),
                  })
                  .passthrough()
              )
              .optional(),
            possibleTypes: z.array(z.object({ name: z.string() }).passthrough()).optional(),
          })
          .passthrough()
          .nullable(),
      })
      .passthrough(),
  })
  .passthrough();
