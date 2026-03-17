export interface TemplateField {
  name: string;
  type: string;
  required: boolean;
  description: string;
  allowedTypes?: string[];
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
      };
    };
  };
  description: string | null;
}
