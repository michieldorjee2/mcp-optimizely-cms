import type { GraphIntrospectionField, GraphTypeInfo, TemplateField, TemplateSubField } from "../types.js";

const GRAPH_URL = "https://cg.optimizely.com/content/v2";

interface IntrospectionResult {
  data: {
    __type: GraphTypeInfo | null;
  };
}

/**
 * Introspect a content type from Optimizely Graph, returning its fields.
 */
export async function introspectContentType(
  graphKey: string,
  typeName: string
): Promise<GraphTypeInfo | null> {
  const query = `
    {
      __type(name: "${typeName}") {
        name
        kind
        fields {
          name
          type {
            name
            kind
            ofType {
              name
              kind
              ofType {
                name
                kind
                ofType {
                  name
                  kind
                }
              }
            }
          }
          description
        }
        possibleTypes {
          name
        }
      }
    }
  `;

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
  return result.data.__type;
}

/**
 * Introspect a sub-type (block, object, interface) to get its fields and possible types.
 */
export async function introspectSubType(
  graphKey: string,
  typeName: string
): Promise<GraphTypeInfo | null> {
  return introspectContentType(graphKey, typeName);
}

/**
 * Resolve the leaf type name from a potentially nested GraphQL type.
 */
function resolveTypeName(type: GraphIntrospectionField["type"]): string {
  return type.name || type.ofType?.name || type.ofType?.ofType?.name || type.ofType?.ofType?.ofType?.name || "unknown";
}

/**
 * Resolve the leaf kind from a potentially nested GraphQL type.
 */
function resolveLeafKind(type: GraphIntrospectionField["type"]): string {
  if (type.name) return type.kind;
  if (type.ofType?.name) return type.ofType.kind;
  if (type.ofType?.ofType?.name) return type.ofType.ofType.kind;
  if (type.ofType?.ofType?.ofType?.name) return type.ofType.ofType.ofType.kind;
  return type.kind;
}

/**
 * Check if a type is a LIST at the top level (possibly wrapped in NON_NULL).
 */
function isList(type: GraphIntrospectionField["type"]): boolean {
  if (type.kind === "LIST") return true;
  if (type.kind === "NON_NULL" && type.ofType?.kind === "LIST") return true;
  return false;
}

/**
 * Get the item type for a LIST field.
 */
function getListItemType(type: GraphIntrospectionField["type"]): { name: string; kind: string } {
  let listType = type;
  // Unwrap NON_NULL wrapper
  if (listType.kind === "NON_NULL" && listType.ofType) {
    listType = listType.ofType as GraphIntrospectionField["type"];
  }
  // Now we should be at LIST
  if (listType.kind === "LIST" && listType.ofType) {
    const itemType = listType.ofType;
    // Unwrap NON_NULL on item type
    if (itemType.kind === "NON_NULL" && itemType.ofType) {
      return { name: itemType.ofType.name || "unknown", kind: itemType.ofType.kind };
    }
    return { name: itemType.name || "unknown", kind: itemType.kind };
  }
  return { name: "unknown", kind: "UNKNOWN" };
}

/** Known scalar type mappings from GraphQL to CMS types */
const SCALAR_MAP: Record<string, string> = {
  String: "string",
  Int: "integer",
  Float: "number",
  Boolean: "boolean",
  Bool: "boolean",
  Date: "dateTime",
  DateTime: "dateTime",
};

/** Known object type mappings */
const OBJECT_MAP: Record<string, string> = {
  ContentUrl: "url",
  ContentReference: "contentReference",
  ContentAreaItemModel: "contentArea",
  LinkItemNode: "link",
};

/**
 * Map a GraphQL field to a rich CMS field type string.
 */
export function mapFieldType(field: GraphIntrospectionField): string {
  const type = field.type;
  const typeName = resolveTypeName(type);

  // Scalars
  if (SCALAR_MAP[typeName]) return SCALAR_MAP[typeName];

  // Known objects
  if (OBJECT_MAP[typeName]) return OBJECT_MAP[typeName];

  // Interfaces like _IContent \u2192 contentArea (inline content / content area items)
  if (typeName === "_IContent" || typeName === "IContent") return "contentArea";

  // Property blocks (e.g. ComparisonTableBlockProperty, ComparisonRowProperty)
  if (typeName.endsWith("Property") || typeName.endsWith("Block") || typeName.endsWith("Component")) {
    return "object";
  }

  return typeName.toLowerCase();
}

/**
 * Convert GraphTypeInfo fields into TemplateSubField[] for nested object types.
 */
function buildSubFields(typeInfo: GraphTypeInfo): TemplateSubField[] {
  if (!typeInfo.fields) return [];
  return typeInfo.fields
    .filter((f) => !f.name.startsWith("_"))
    .map((f) => {
      const subField: TemplateSubField = {
        name: f.name,
        type: mapFieldType(f),
        required: f.type.kind === "NON_NULL",
        description: f.description || `Field: ${f.name}`,
      };
      return subField;
    });
}

/**
 * Build a rich TemplateField from a GraphQL introspection field,
 * introspecting sub-types as needed.
 */
export async function buildTemplateField(
  graphKey: string,
  field: GraphIntrospectionField
): Promise<TemplateField> {
  const type = field.type;
  const typeName = resolveTypeName(type);
  const topKind = type.kind;
  const leafKind = resolveLeafKind(type);
  const fieldType = mapFieldType(field);
  const list = isList(type);

  const result: TemplateField = {
    name: field.name,
    type: list ? "array" : fieldType,
    required: topKind === "NON_NULL",
    description: field.description || `Field: ${field.name}`,
    graphQLKind: topKind,
    graphQLTypeName: typeName,
  };

  // Handle LIST fields
  if (list) {
    const itemType = getListItemType(type);
    result.itemType = SCALAR_MAP[itemType.name] || OBJECT_MAP[itemType.name] || itemType.name;

    // If item type is an OBJECT, introspect its sub-fields
    if (itemType.kind === "OBJECT" && !SCALAR_MAP[itemType.name] && !["ContentUrl"].includes(itemType.name)) {
      const subTypeInfo = await introspectSubType(graphKey, itemType.name);
      if (subTypeInfo?.fields) {
        result.subFields = buildSubFields(subTypeInfo);
      }
    }

    // If item type is an INTERFACE (_IContent), get allowed types
    if (itemType.kind === "INTERFACE") {
      const interfaceInfo = await introspectSubType(graphKey, itemType.name);
      if (interfaceInfo?.possibleTypes) {
        result.allowedTypes = interfaceInfo.possibleTypes.map((t) => t.name);
      }
      result.itemType = "contentArea";
    }
  }

  // Handle single INTERFACE fields (_IContent) \u2014 content area / inline block
  if (!list && (leafKind === "INTERFACE") && (typeName === "_IContent" || typeName === "IContent")) {
    const interfaceInfo = await introspectSubType(graphKey, typeName);
    if (interfaceInfo?.possibleTypes) {
      result.allowedTypes = interfaceInfo.possibleTypes.map((t) => t.name);
    }
  }

  // Handle OBJECT fields that are block/property types \u2014 introspect sub-fields
  if (!list && leafKind === "OBJECT" && !SCALAR_MAP[typeName]) {
    if (typeName === "ContentUrl") {
      result.type = "url";
      result.urlFormats = ["default", "hierarchical", "internal", "graph", "base"];
    } else if (typeName === "ContentReference") {
      result.type = "contentReference";
      // Introspect to show sub-fields
      const subTypeInfo = await introspectSubType(graphKey, typeName);
      if (subTypeInfo?.fields) {
        result.subFields = buildSubFields(subTypeInfo);
      }
    } else {
      // Custom object/block type \u2014 introspect sub-fields
      result.type = "object";
      const subTypeInfo = await introspectSubType(graphKey, typeName);
      if (subTypeInfo?.fields) {
        result.subFields = buildSubFields(subTypeInfo);
      }
    }
  }

  return result;
}

/**
 * Filter out internal/system fields.
 */
export function isUserField(fieldName: string): boolean {
  return !fieldName.startsWith("_");
}
