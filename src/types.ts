/**
 * A single property in the flat template.
 * Each entry maps directly to a key in the `properties` object passed to create_page.
 */
export interface TemplateProperty {
  /** The property key to use in create_page properties */
  key: string;
  /** Human-readable label */
  label: string;
  /** How to fill this in: "string", "boolean", "number", "url", "object[]", "contentId", "contentId[]" */
  type: string;
  /** Whether this field is required */
  required: boolean;
  /** Short description of what this field is for */
  description: string;
  /** Example value showing the exact JSON shape to pass */
  example: unknown;
  /** For object[] types: the keys each item object needs */
  itemShape?: Record<string, string>;
}

/**
 * A flat, LLM-friendly template for a content type.
 * The `properties` array is a simple list of "fill these in" fields,
 * each with an example value showing the exact shape the CMS API expects.
 */
export interface Template {
  name: string;
  contentType: string;
  /** Flat list of properties to fill in when calling create_page */
  properties: TemplateProperty[];
  /** Fields that require references to existing content (can't be created inline) */
  contentReferences: string[];
  createdAt: string;
}

// Keep old TemplateField as alias for backward compat in create-page validation
export type TemplateField = TemplateProperty;

export interface CmsContentBody {
  contentType: string[];
  displayName: string;
  locale: string;
  status?: string;
  container?: string;
  routeSegment?: string;
  properties?: Record<string, unknown>;
}

export interface CmsContentResponse {
  key: string;
  displayName: string;
  contentType: string[];
  locale: string;
  status: string;
  properties?: Record<string, unknown>;
  _metadata?: {
    version?: string;
  };
}

export interface CmsTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export interface GraphIntrospectionField {
  name: string;
  type: {
    name: string | null;
    kind: string;
    ofType?: {
      name: string | null;
      kind: string;
      ofType?: {
        name: string | null;
        kind: string;
        ofType?: {
          name: string | null;
          kind: string;
        };
      };
    };
  };
  description: string | null;
}

export interface GraphTypeInfo {
  name: string;
  kind: string;
  fields?: GraphIntrospectionField[];
  possibleTypes?: Array<{ name: string }>;
}
