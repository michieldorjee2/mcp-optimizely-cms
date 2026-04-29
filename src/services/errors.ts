/**
 * Typed error hierarchy for the Optimizely MCP server.
 *
 * Every API helper throws one of these instead of a stringified Error so
 * tools can `instanceof`-check, pull structured fields, and serialize
 * cleanly into MCP responses — no more regex parsing of error messages.
 */

export interface ApiErrorBody {
  status?: number;
  detail?: string;
  errors?: Array<{ field?: string; detail?: string }>;
  type?: string;
  title?: string;
  traceId?: string;
  code?: string;
  [key: string]: unknown;
}

interface CmsApiErrorOptions {
  status: number;
  endpoint: string;
  method: string;
  body: ApiErrorBody | string | undefined;
  cause?: unknown;
}

/** Thrown when an Optimizely API call returns a non-2xx response. */
export class CmsApiError extends Error {
  readonly status: number;
  readonly endpoint: string;
  readonly method: string;
  readonly body: ApiErrorBody | string | undefined;

  constructor(message: string, opts: CmsApiErrorOptions) {
    super(message, { cause: opts.cause });
    this.name = "CmsApiError";
    this.status = opts.status;
    this.endpoint = opts.endpoint;
    this.method = opts.method;
    this.body = opts.body;
  }

  /** Attempt to pull the API's structured errors[] array if present. */
  fieldErrors(): Array<{ field?: string; detail?: string }> {
    if (typeof this.body === "object" && this.body && Array.isArray(this.body.errors)) {
      return this.body.errors;
    }
    return [];
  }

  /** Serializable shape suitable for MCP tool responses. */
  toResponse() {
    return {
      error: this.message,
      status: this.status,
      endpoint: this.endpoint,
      method: this.method,
      apiError: this.body,
      fieldErrors: this.fieldErrors(),
    };
  }
}

/** Specialized 401/403 — the OAuth token is missing or rejected. */
export class CmsAuthError extends CmsApiError {
  constructor(opts: CmsApiErrorOptions) {
    super("Optimizely auth failed — check OPTIMIZELY_CMS_CLIENT_ID / SECRET.", opts);
    this.name = "CmsAuthError";
  }
}

/** Specialized 404 — content / version / type not found. */
export class CmsNotFoundError extends CmsApiError {
  constructor(opts: CmsApiErrorOptions) {
    super(`Optimizely returned 404 for ${opts.method} ${opts.endpoint}.`, opts);
    this.name = "CmsNotFoundError";
  }
}

/** Specialized 4xx with validation errors — bad input shape. */
export class CmsValidationError extends CmsApiError {
  constructor(opts: CmsApiErrorOptions) {
    const detail =
      typeof opts.body === "object" && opts.body && "detail" in opts.body
        ? String(opts.body.detail)
        : "Validation failed.";
    super(detail, opts);
    this.name = "CmsValidationError";
  }
}

/**
 * Local validation error — the property shape the caller passed didn't pass
 * our pre-flight checks (against the cached template). Doesn't hit the API.
 */
export class LocalValidationError extends Error {
  readonly errors: Array<{ field: string; detail: string }>;

  constructor(errors: Array<{ field: string; detail: string }>) {
    super(`Local validation failed: ${errors.map((e) => `${e.field}: ${e.detail}`).join("; ")}`);
    this.name = "LocalValidationError";
    this.errors = errors;
  }
}

/**
 * Build the right error subclass given an HTTP response. Reads the body
 * once (the caller passes the awaited text) and tries to parse JSON.
 */
export function buildCmsApiError(args: {
  status: number;
  endpoint: string;
  method: string;
  bodyText: string;
  cause?: unknown;
}): CmsApiError {
  let parsed: ApiErrorBody | string = args.bodyText;
  try {
    parsed = JSON.parse(args.bodyText) as ApiErrorBody;
  } catch {
    // Keep as text.
  }

  const opts: CmsApiErrorOptions = {
    status: args.status,
    endpoint: args.endpoint,
    method: args.method,
    body: parsed,
    cause: args.cause,
  };

  if (args.status === 401 || args.status === 403) return new CmsAuthError(opts);
  if (args.status === 404) return new CmsNotFoundError(opts);
  if (args.status === 400 || args.status === 422) return new CmsValidationError(opts);

  return new CmsApiError(
    `Optimizely ${args.method} ${args.endpoint} failed (${args.status}).`,
    opts
  );
}

/**
 * Take any thrown value and return a structured shape suitable for an MCP
 * tool response — never throws itself. Replaces the regex-based parsing in
 * each tool with a single typed path.
 */
export function errorToResponse(e: unknown): {
  error: string;
  status?: number;
  endpoint?: string;
  method?: string;
  apiError?: unknown;
  fieldErrors?: Array<{ field?: string; detail?: string }>;
} {
  if (e instanceof CmsApiError) return e.toResponse();
  if (e instanceof LocalValidationError) {
    return { error: e.message, fieldErrors: e.errors };
  }
  if (e instanceof Error) return { error: e.message };
  return { error: String(e) };
}

/** True if the error is one we should retry. */
export function isRetryable(e: unknown): boolean {
  if (e instanceof CmsAuthError) return false; // never retry 401/403
  if (e instanceof CmsNotFoundError) return false; // 404 is permanent
  if (e instanceof CmsValidationError) return false; // bad input — won't fix itself
  if (e instanceof CmsApiError) {
    // 408 timeout, 429 rate limit, 5xx server errors are retryable.
    return e.status === 408 || e.status === 429 || (e.status >= 500 && e.status <= 599);
  }
  // Network errors (TypeError on fetch) are retryable.
  if (e instanceof TypeError) return true;
  return false;
}
