import type { GraphIntrospectionField, GraphTypeInfo, TemplateProperty } from "../types.js";

const GRAPH_URL = "https://cg.optimizely.com/content/v2";

interface IntrospectionResult {
  data: {
    __type: GraphTypeInfo | null;
  };
}

// Cache sub-type introspections within a single create_template call
const typeCache = new Map<string, GraphTypeInfo | null>();

export async function introspectContentType(
  graphKey: string,
  typeName: string
): Promise<GraphTypeInfo | null> {
  if (typeCache.has(typeName)) return typeCache.get(typeName)!;

  const query = `{
    __type(name: "${typeName}") {
      name kind
      fields { name description type { name kind ofType { name kind ofType { name kind ofType { name kind } } } } }
      possibleTypes { name }
    }
  }`;

  const response = await fetch(`${GRAPH_URL}?auth=${encodeURIComponent(graphKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Graph introspection failed (${response.status}): ${text}`);
  }

  const result = (await response.json()) as IntrospectionResult;
  typeCache.set(typeName, result.data.__type);
  return result.data.__type;
}

export function clearTypeCache() {
  typeCache.clear();
}

// ---------------------------------------------------------------------------
// Type resolution helpers
// ---------------------------------------------------------------------------

function resolveTypeName(type: GraphIntrospectionField["type"]): string {
  return type.name || type.ofType?.name || type.ofType?.ofType?.name || type.ofType?.ofType?.ofType?.name || "unknown";
}

function isList(type: GraphIntrospectionField["type"]): boolean {
  return type.kind === "LIST" || (type.kind === "NON_NULL" && type.ofType?.kind === "LIST");
}

function getListItemType(type: GraphIntrospectionField["type"]): { name: string; kind: string } {
  let t = type;
  if (t.kind === "NON_NULL" && t.ofType) t = t.ofType as typeof type;
  if (t.kind === "LIST" && t.ofType) {
    const item = t.ofType;
    if (item.kind === "NON_NULL" && item.ofType) return { name: item.ofType.name || "unknown", kind: item.ofType.kind };
    return { name: item.name || "unknown", kind: item.kind };
  }
  return { name: "unknown", kind: "UNKNOWN" };
}

function resolveLeafKind(type: GraphIntrospectionField["type"]): string {
  if (type.name) return type.kind;
  if (type.ofType?.name) return type.ofType.kind;
  if (type.ofType?.ofType?.name) return type.ofType.ofType.kind;
  return type.kind;
}

// ---------------------------------------------------------------------------
// Build flat TemplateProperty list
// ---------------------------------------------------------------------------

const SCALARS: Record<string, { type: string; example: unknown }> = {
  String:   { type: "string",  example: "" },
  Int:      { type: "number",  example: 0 },
  Float:    { type: "number",  example: 0.0 },
  Boolean:  { type: "boolean", example: false },
  Bool:     { type: "boolean", example: false },
  Date:     { type: "string",  example: "2026-01-01" },
  DateTime: { type: "string",  example: "2026-01-01T00:00:00Z" },
};

/**
 * Build the item shape dict (key → type string) for an object sub-type,
 * plus generate an example object.
 */
async function buildItemShape(graphKey: string, typeName: string): Promise<{ shape: Record<string, string>; example: Record<string, unknown> }> {
  const info = await introspectContentType(graphKey, typeName);
  const shape: Record<string, string> = {};
  const example: Record<string, unknown> = {};

  if (info?.fields) {
    for (const f of info.fields) {
      if (f.name.startsWith("_")) continue;
      const tn = resolveTypeName(f.type);
      const scalar = SCALARS[tn];
      if (scalar) {
        shape[f.name] = scalar.type;
        example[f.name] = scalar.example;
      } else if (tn === "ContentUrl") {
        shape[f.name] = "string (URL)";
        example[f.name] = "https://example.com";
      } else {
        // Nested object inside an object — flatten to string placeholder
        shape[f.name] = tn;
        example[f.name] = `<${tn}>`;
      }
    }
  }
  return { shape, example };
}

/**
 * Convert a single GraphQL field into a flat TemplateProperty.
 * Returns null for fields that should be skipped (pure content references
 * that need separate content IDs are tracked separately).
 */
export async function buildProperty(
  graphKey: string,
  field: GraphIntrospectionField
): Promise<{ prop: TemplateProperty | null; isContentRef: boolean }> {
  const type = field.type;
  const typeName = resolveTypeName(type);
  const topKind = type.kind;
  const leafKind = resolveLeafKind(type);
  const list = isList(type);
  const required = topKind === "NON_NULL";
  const label = field.name.replace(/([A-Z])/g, " $1").trim();
  const desc = field.description || label;

  // ── Scalars ──
  const scalar = SCALARS[typeName];
  if (scalar && !list) {
    return {
      prop: { key: field.name, label, type: scalar.type, required, description: desc, example: scalar.example },
      isContentRef: false,
    };
  }

  // ── URL fields (ContentUrl) ──
  if (typeName === "ContentUrl" && !list) {
    return {
      prop: { key: field.name, label, type: "url", required, description: `${desc}. Pass as a URL string.`, example: "https://example.com/page" },
      isContentRef: false,
    };
  }

  // ── Single content area / inline block (_IContent interface) ──
  if (!list && leafKind === "INTERFACE" && (typeName === "_IContent" || typeName === "IContent")) {
    return {
      prop: { key: field.name, label, type: "contentId", required, description: `${desc}. Pass the content ID of an existing block/component.`, example: "<existing-content-id>" },
      isContentRef: true,
    };
  }

  // ── Single content reference ──
  if (!list && typeName === "ContentReference") {
    return {
      prop: { key: field.name, label, type: "contentId", required, description: `${desc}. Pass the content ID of an existing item.`, example: "<existing-content-id>" },
      isContentRef: true,
    };
  }

  // ── LIST of scalars ──
  if (list) {
    const item = getListItemType(type);
    const itemScalar = SCALARS[item.name];

    if (itemScalar) {
      return {
        prop: { key: field.name, label, type: `${itemScalar.type}[]`, required, description: desc, example: [itemScalar.example] },
        isContentRef: false,
      };
    }

    // ── LIST of content refs / content area items ──
    if (item.kind === "INTERFACE" || item.name === "ContentReference") {
      return {
        prop: { key: field.name, label, type: "contentId[]", required, description: `${desc}. Pass an array of existing content IDs.`, example: ["<content-id-1>", "<content-id-2>"] },
        isContentRef: true,
      };
    }

    // ── LIST of objects (property blocks) ──
    if (item.kind === "OBJECT" && !SCALARS[item.name] && item.name !== "ContentUrl") {
      const { shape, example } = await buildItemShape(graphKey, item.name);
      return {
        prop: { key: field.name, label, type: "object[]", required, description: `${desc}. Each item has: ${Object.entries(shape).map(([k, v]) => `${k} (${v})`).join(", ")}.`, example: [example], itemShape: shape },
        isContentRef: false,
      };
    }

    // ── LIST of URLs ──
    if (item.name === "ContentUrl") {
      return {
        prop: { key: field.name, label, type: "url[]", required, description: desc, example: ["https://example.com"] },
        isContentRef: false,
      };
    }
  }

  // ── Unknown object types ──
  if (!list && leafKind === "OBJECT") {
    const { shape, example } = await buildItemShape(graphKey, typeName);
    if (Object.keys(shape).length > 0) {
      return {
        prop: { key: field.name, label, type: "object", required, description: `${desc}. Shape: ${Object.entries(shape).map(([k, v]) => `${k} (${v})`).join(", ")}.`, example },
        isContentRef: false,
      };
    }
  }

  // Fallback
  return {
    prop: { key: field.name, label, type: "string", required, description: desc, example: "" },
    isContentRef: false,
  };
}

export function isUserField(fieldName: string): boolean {
  return !fieldName.startsWith("_");
}
