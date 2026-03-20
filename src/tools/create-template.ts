import { z } from "zod";
import { getContentType } from "../services/cms-api.js";
import { introspectContentType, clearTypeCache } from "../services/graph-api.js";
import { saveTemplate, getTemplate, deleteTemplate } from "../services/template-store.js";
import type { Template, TemplateProperty, CmsContentTypeProperty } from "../types.js";

export const createTemplateSchema = z.object({
  contentTypeName: z.string().describe("The name of a page/content type in Optimizely CMS (e.g. 'CompetitorComparisonPage')"),
  force: z.boolean().optional().default(false).describe("If true, overwrite existing template"),
});

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

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

async function buildPropertyFromCms(
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
      return {
        prop: {
          key, label, type: "contentId[]", required,
          description: buildDescription(label, cmsProp, ["Pass an array of existing content IDs."]),
          example: ["<content-id-1>", "<content-id-2>"],
          ...(cmsProp.minItems != null && { minItems: cmsProp.minItems }),
          ...(cmsProp.maxItems != null && { maxItems: cmsProp.maxItems }),
          ...(cmsProp.allowedTypes && cmsProp.allowedTypes.length > 0 && { allowedTypes: cmsProp.allowedTypes }),
        },
        isContentRef: true,
      };
    }

    // Array of components — get sub-type shape from Graph
    if (itemType === "component" && cmsProp.items.contentType) {
      clearTypeCache();
      const { shape, example } = await buildItemShapeFromGraph(graphKey, cmsProp.items.contentType);
      const shapeDesc = Object.entries(shape).map(([k, v]) => `${k} (${v})`).join(", ");
      return {
        prop: {
          key, label, type: "object[]", required,
          description: buildDescription(label, cmsProp, [`Each item has: ${shapeDesc}.`]),
          example: [example],
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
        example: [mapped.example],
        ...(cmsProp.minItems != null && { minItems: cmsProp.minItems }),
        ...(cmsProp.maxItems != null && { maxItems: cmsProp.maxItems }),
      },
      isContentRef: false,
    };
  }

  // --- Component (single object) ---
  if (cmsProp.type === "component" && cmsProp.contentType) {
    clearTypeCache();
    const { shape, example } = await buildItemShapeFromGraph(graphKey, cmsProp.contentType);
    const shapeDesc = Object.entries(shape).map(([k, v]) => `${k} (${v})`).join(", ");
    return {
      prop: {
        key, label, type: "object", required,
        description: buildDescription(label, cmsProp, [`Shape: ${shapeDesc}.`]),
        example,
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
  const prop: TemplateProperty = {
    key, label, type: mapped.type, required,
    description: buildDescription(label, cmsProp),
    example: mapped.example,
  };

  // Add string validation constraints
  if (cmsProp.minLength != null) prop.minLength = cmsProp.minLength;
  if (cmsProp.maxLength != null) prop.maxLength = cmsProp.maxLength;
  if (cmsProp.pattern) prop.pattern = cmsProp.pattern;
  if (cmsProp.enum && cmsProp.enum.length > 0) {
    prop.enumValues = cmsProp.enum.map((e) => e.value);
  }

  return { prop, isContentRef: false };
}

// ---------------------------------------------------------------------------
// Main create_template handler
// ---------------------------------------------------------------------------

export async function createTemplate(
  input: CreateTemplateInput,
  graphKey: string,
  clientId: string,
  clientSecret: string
) {
  const existing = await getTemplate(input.contentTypeName).catch(() => null);
  if (existing && !input.force) {
    return {
      success: false,
      error: `Template '${input.contentTypeName}' already exists. Use force=true to overwrite.`,
      existing: {
        name: existing.name,
        propertyCount: existing.properties.length,
        createdAt: existing.createdAt,
      },
    };
  }

  if (existing && input.force) {
    await deleteTemplate(input.contentTypeName).catch(() => {});
  }

  // Fetch content type definition from CMS REST API (has accurate validation rules)
  const contentType = await getContentType(clientId, clientSecret, input.contentTypeName);
  if (!contentType.properties || Object.keys(contentType.properties).length === 0) {
    return {
      success: false,
      error: `Content type '${input.contentTypeName}' has no properties. Check the type name.`,
    };
  }

  // Build flat property definitions using CMS data + Graph for sub-type shapes
  const properties: TemplateProperty[] = [];
  const contentReferences: string[] = [];

  for (const [key, cmsProp] of Object.entries(contentType.properties)) {
    const { prop, isContentRef } = await buildPropertyFromCms(key, cmsProp, graphKey);
    properties.push(prop);
    if (isContentRef) {
      contentReferences.push(prop.key);
    }
  }

  const template: Template = {
    name: input.contentTypeName,
    contentType: input.contentTypeName,
    properties,
    contentReferences,
    createdAt: new Date().toISOString(),
  };

  await saveTemplate(template);

  return {
    success: true,
    template: {
      name: template.name,
      contentType: template.contentType,
      propertyCount: template.properties.length,
      properties: template.properties,
      contentReferences: template.contentReferences,
      createdAt: template.createdAt,
    },
  };
}
