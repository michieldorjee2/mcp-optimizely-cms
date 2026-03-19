import type { GraphIntrospectionField } from "../types";

const GRAPH_URL = "https://cg.optimizely.com/content/v2";

interface IntrospectionResult {
  data: {
    __type: {
      name: string;
      fields: GraphIntrospectionField[];
    } | null;
  };
}

export async function introspectContentType(
  graphKey: string,
  typeName: string
): Promise<{ name: string; fields: GraphIntrospectionField[] } | null> {
  const query = `
    {
      __type(name: "${typeName}") {
        name
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
              }
            }
          }
          description
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

export function mapGraphQLTypeToCmsType(field: GraphIntrospectionField): string {
  const type = field.type;
  const typeName =
    type.name ||
    type.ofType?.name ||
    type.ofType?.ofType?.name ||
    "unknown";

  const mapping: Record<string, string> = {
    String: "string",
    Int: "integer",
    Float: "number",
    Boolean: "boolean",
    Date: "dateTime",
    DateTime: "dateTime",
    ContentAreaItemModel: "contentArea",
    ContentReference: "contentReference",
    LinkItemNode: "link",
  };

  if (mapping[typeName]) return mapping[typeName];
  if (typeName.endsWith("Block") || typeName.endsWith("Component")) return "contentArea";
  if (type.kind === "LIST" || type.ofType?.kind === "LIST") return "array";

  return typeName.toLowerCase();
}

export function isUserField(fieldName: string): boolean {
  return !fieldName.startsWith("_");
}
