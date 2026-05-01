import type { CmsContentType, CmsContentTypeProperty, TemplateProperty } from "../types.js";
import { introspectContentType, clearTypeCache } from "./graph-api.js";

/**
 * Bump whenever the example / itemShape encoding changes in a way that would
 * mislead the agent if it copied a stale cached template. v2 switched
 * `example` from raw values to the wrapped CMS submission shape ({value:…},
 * {properties:{…}}, {value:[{properties:{…}}]}). v3 adds submissionExample
 * (one full-skeleton paste-and-fill object) — older caches don't have it,
 * so loadOrBuildTemplate rebuilds them on first use after deploy. Treats a
 * mismatch the same as drift — rebuild + overwrite.
 */
export const TEMPLATE_FORMAT_VERSION = 3;

// ---------------------------------------------------------------------------
// Wrap raw example values into the CMS submission shape so the agent can
// copy the example directly into propertiesJson without composing the
// wrapping rules. The CMS API expects:
//   - primitive  → {"value": <primitive>}
//   - component  → {"properties": {<key>: {"value": <primitive>}, …}}
//   - object[]   → {"value": [{"properties": {<key>: {"value": …}}}, …]}
//   - scalar[]   → {"value": [<scalar>, …]}
// contentId / contentId[] examples stay raw — they're already string IDs and
// the CMS accepts them as-is (no wrapping required for content references).
// ---------------------------------------------------------------------------

function wrapComponentObject(raw: Record<string, unknown>): { properties: Record<string, unknown> } {
  const properties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    properties[k] = { value: v };
  }
  return { properties };
}

function wrapExample(rawExample: unknown, type: string): unknown {
  // Content references stay raw — they're string IDs.
  if (type === "contentId" || type === "contentId[]") return rawExample;

  // Single component → {properties: {…}}
  if (type === "object" && rawExample && typeof rawExample === "object" && !Array.isArray(rawExample)) {
    return wrapComponentObject(rawExample as Record<string, unknown>);
  }

  // Array of components → {value: [{properties: {…}}, …]}
  if (type === "object[]" && Array.isArray(rawExample)) {
    return {
      value: rawExample.map((item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? wrapComponentObject(item as Record<string, unknown>)
          : item
      ),
    };
  }

  // Scalars + scalar arrays + URL types — single {value: …} wrapper.
  return { value: rawExample };
}

// ---------------------------------------------------------------------------
// CMS property type → flat template type mapping
// ---------------------------------------------------------------------------

const TYPE_MAP: Record<string, { type: string; example: unknown }> = {
  string:           { type: "string",  example: "" },
  url:              { type: "url",     example: "https://example.com" },
  boolean:          { type: "boolean", example: false },
  integer:          { type: "number",  example: 0 },
  float:            { type: "number",  example: 0.0 },
  dateTime:         { type: "string",  example: "2026-01-01T00:00:00Z" },
  richText:         { type: "string",  example: "" },
  link:             { type: "url",     example: "https://example.com" },
  contentReference: { type: "contentId", example: "<existing-content-id>" },
  content:          { type: "contentId", example: "<existing-content-id>" },
  json:             { type: "object",  example: {} },
};

const CONTENT_REF_TYPES = new Set(["contentReference", "content"]);

// ---------------------------------------------------------------------------
// Build item shape for component/array sub-types via Graph introspection
// ---------------------------------------------------------------------------

async function buildItemShapeFromGraph(
  graphKey: string,
  typeName: string
): Promise<{ shape: Record<string, string>; example: Record<string, unknown> }> {
  const SCALARS: Record<string, { type: string; example: unknown }> = {
    String:   { type: "string",  example: "" },
    Int:      { type: "number",  example: 0 },
    Float:    { type: "number",  example: 0.0 },
    Boolean:  { type: "boolean", example: false },
    Bool:     { type: "boolean", example: false },
    Date:     { type: "string",  example: "2026-01-01" },
    DateTime: { type: "string",  example: "2026-01-01T00:00:00Z" },
  };

  const info = await introspectContentType(graphKey, typeName);
  const shape: Record<string, string> = {};
  const example: Record<string, unknown> = {};

  if (info?.fields) {
    for (const f of info.fields) {
      if (f.name.startsWith("_")) continue;
      const tn = f.type.name || f.type.ofType?.name || f.type.ofType?.ofType?.name || "unknown";
      const scalar = SCALARS[tn];
      if (scalar) {
        shape[f.name] = scalar.type;
        example[f.name] = scalar.example;
      } else if (tn === "ContentUrl") {
        shape[f.name] = "string (URL)";
        example[f.name] = "https://example.com";
      } else {
        shape[f.name] = tn;
        example[f.name] = `<${tn}>`;
      }
    }
  }
  return { shape, example };
}

// ---------------------------------------------------------------------------
// Build description with validation hints baked in
// ---------------------------------------------------------------------------

function buildDescription(
  label: string,
  cmsProp: CmsContentTypeProperty,
  extraHints: string[] = []
): string {
  const parts: string[] = [label];

  if (cmsProp.description) parts[0] = cmsProp.description;
  if (cmsProp.required) parts.push("Required.");
  if (cmsProp.minLength != null) parts.push(`Min length: ${cmsProp.minLength}.`);
  if (cmsProp.maxLength != null) parts.push(`Max length: ${cmsProp.maxLength}.`);
  if (cmsProp.minItems != null) parts.push(`Min ${cmsProp.minItems} items.`);
  if (cmsProp.maxItems != null) parts.push(`Max ${cmsProp.maxItems} items.`);
  if (cmsProp.pattern) parts.push(`Pattern: ${cmsProp.pattern}.`);
  if (cmsProp.enum && cmsProp.enum.length > 0) {
    parts.push(`Allowed values: ${cmsProp.enum.map((e) => e.value).join(", ")}.`);
  }
  if (cmsProp.allowedTypes && cmsProp.allowedTypes.length > 0) {
    parts.push(`Allowed types: ${cmsProp.allowedTypes.join(", ")}.`);
  }

  parts.push(...extraHints);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Convert a single CMS property definition into a TemplateProperty
// ---------------------------------------------------------------------------

export async function buildPropertyFromCms(
  key: string,
  cmsProp: CmsContentTypeProperty,
  graphKey: string
): Promise<{ prop: TemplateProperty; isContentRef: boolean }> {
  const label = cmsProp.displayName || key.replace(/([A-Z])/g, " $1").trim();
  const required = cmsProp.required ?? false;

  // --- Array types ---
  if (cmsProp.type === "array" && cmsProp.items) {
    const itemType = cmsProp.items.type || "string";
    const isContentArray = CONTENT_REF_TYPES.has(itemType);

    if (isContentArray) {
      const allowed = cmsProp.allowedTypes?.length
        ? cmsProp.allowedTypes
        : cmsProp.items!.allowedTypes?.length
          ? cmsProp.items!.allowedTypes
          : undefined;
      return {
        prop: {
          key, label, type: "contentId[]", required,
          description: buildDescription(label, cmsProp, ["Pass an array of existing content IDs."]),
          example: ["<content-id-1>", "<content-id-2>"],
          ...(cmsProp.minItems != null && { minItems: cmsProp.minItems }),
          ...(cmsProp.maxItems != null && { maxItems: cmsProp.maxItems }),
          ...(allowed && { allowedTypes: allowed }),
        },
        isContentRef: true,
      };
    }

    // Array of components — get sub-type shape from Graph
    if (itemType === "component" && cmsProp.items.contentType) {
      clearTypeCache();
      const { shape, example: rawExample } = await buildItemShapeFromGraph(graphKey, cmsProp.items.contentType);
      const shapeDesc = Object.entries(shape).map(([k, v]) => `${k} (${v})`).join(", ");
      return {
        prop: {
          key, label, type: "object[]", required,
          description: buildDescription(label, cmsProp, [
            `Each item has: ${shapeDesc}.`,
            "Submit each item wrapped as {properties: {<field>: {value: <primitive>}, …}} inside the outer {value: [...]}.",
          ]),
          example: wrapExample([rawExample], "object[]"),
          itemShape: shape,
          ...(cmsProp.minItems != null && { minItems: cmsProp.minItems }),
          ...(cmsProp.maxItems != null && { maxItems: cmsProp.maxItems }),
        },
        isContentRef: false,
      };
    }

    // Array of scalars
    const mapped = TYPE_MAP[itemType] || { type: "string", example: "" };
    return {
      prop: {
        key, label, type: `${mapped.type}[]`, required,
        description: buildDescription(label, cmsProp),
        example: wrapExample([mapped.example], `${mapped.type}[]`),
        ...(cmsProp.minItems != null && { minItems: cmsProp.minItems }),
        ...(cmsProp.maxItems != null && { maxItems: cmsProp.maxItems }),
      },
      isContentRef: false,
    };
  }

  // --- Component (single object) ---
  if (cmsProp.type === "component" && cmsProp.contentType) {
    clearTypeCache();
    const { shape, example: rawExample } = await buildItemShapeFromGraph(graphKey, cmsProp.contentType);
    const shapeDesc = Object.entries(shape).map(([k, v]) => `${k} (${v})`).join(", ");
    return {
      prop: {
        key, label, type: "object", required,
        description: buildDescription(label, cmsProp, [
          `Shape: ${shapeDesc}.`,
          "Submit as {properties: {<field>: {value: <primitive>}, …}}.",
        ]),
        example: wrapExample(rawExample, "object"),
        itemShape: shape,
      },
      isContentRef: false,
    };
  }

  // --- Content references ---
  if (CONTENT_REF_TYPES.has(cmsProp.type)) {
    return {
      prop: {
        key, label, type: "contentId", required,
        description: buildDescription(label, cmsProp, ["Pass the content ID of an existing item."]),
        example: "<existing-content-id>",
        ...(cmsProp.allowedTypes && cmsProp.allowedTypes.length > 0 && { allowedTypes: cmsProp.allowedTypes }),
      },
      isContentRef: true,
    };
  }

  // --- Simple scalar types ---
  const mapped = TYPE_MAP[cmsProp.type] || { type: "string", example: "" };
  const isUrlType = mapped.type === "url";
  const extraHints = isUrlType
    ? ["Must be a full URL starting with http:// or https://. Anchor fragments like '#form' and bare paths are rejected."]
    : [];
  const prop: TemplateProperty = {
    key, label, type: mapped.type, required,
    description: buildDescription(label, cmsProp, extraHints),
    example: wrapExample(mapped.example, mapped.type),
  };

  if (cmsProp.minLength != null) prop.minLength = cmsProp.minLength;
  if (cmsProp.maxLength != null) prop.maxLength = cmsProp.maxLength;
  if (cmsProp.pattern) prop.pattern = cmsProp.pattern;
  if (cmsProp.enum && cmsProp.enum.length > 0) {
    prop.enumValues = cmsProp.enum.map((e) => e.value);
  }

  return { prop, isContentRef: false };
}

// ---------------------------------------------------------------------------
// Build the full property list for a content type (used by create_template
// and get_page).
// ---------------------------------------------------------------------------

export async function buildPropertiesFromContentType(
  contentType: CmsContentType,
  graphKey: string
): Promise<{
  properties: TemplateProperty[];
  contentReferences: string[];
  submissionExample: Record<string, unknown>;
}> {
  const properties: TemplateProperty[] = [];
  const contentReferences: string[] = [];

  if (!contentType.properties) {
    return { properties, contentReferences, submissionExample: {} };
  }

  for (const [key, cmsProp] of Object.entries(contentType.properties)) {
    const { prop, isContentRef } = await buildPropertyFromCms(key, cmsProp, graphKey);
    properties.push(prop);
    if (isContentRef) {
      contentReferences.push(prop.key);
    }
  }

  // submissionExample: include every required field plus a small handful of
  // optional ones, so the agent sees the wrapping convention demonstrated
  // across types (string, url, object[]) without bloating to all 50+
  // fields. Optional fields cap at 3 to keep the example skim-able.
  const submissionExample = buildSubmissionExample(properties);

  return { properties, contentReferences, submissionExample };
}

function buildSubmissionExample(props: TemplateProperty[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const optionalSamples: TemplateProperty[] = [];

  for (const p of props) {
    if (p.required) {
      out[p.key] = p.example;
    } else if (optionalSamples.length < 3) {
      optionalSamples.push(p);
    }
  }
  for (const p of optionalSamples) {
    out[p.key] = p.example;
  }
  return out;
}
