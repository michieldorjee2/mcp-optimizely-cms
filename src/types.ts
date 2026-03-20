export interface TemplateFieldConstraints {
  /** For string fields: max character length (if known) */
  maxLength?: number;
  /** For string fields: min character length */
  minLength?: number;
  /** For array/list fields: min items */
  minItems?: number;
  /** For array/list fields: max items */
  maxItems?: number;
}

export interface TemplateSubField {
  name: string;
  type: string;
  required: boolean;
  description: string;
  /** For nested objects/arrays, sub-fields of the item type */
  subFields?: TemplateSubField[];
}

export interface TemplateField {
  name: string;
  /** The CMS field type: string, integer, boolean, dateTime, contentArea, contentReference, link, richText, array, object */
  type: string;
  required: boolean;
  description: string;
  /** For content area / content reference fields: allowed content types */
  allowedTypes?: string[];
  /** For array/list fields: the type of each item */
  itemType?: string;
  /** For object/block fields or array items that are objects: sub-field definitions */
  subFields?: TemplateSubField[];
  /** For link/url fields: available URL formats */
  urlFormats?: string[];
  /** Validation constraints */
  constraints?: TemplateFieldConstraints;
  /** The raw GraphQL kind (SCALAR, OBJECT, LIST, INTERFACE, etc.) */
  graphQLKind?: string;
  /** The raw GraphQL type name */
  graphQLTypeName?: string;
}

export interface Template {
  name: string;
  contentType: string;
  fields: TemplateField[];
  createdAt: string;
}

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
