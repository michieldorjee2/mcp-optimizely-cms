/**
 * Decode Optimizely CMS shape-related error messages into actionable hints.
 *
 * The /preview3/experimental/ surface returns errors from the .NET JSON
 * deserializer when a property's shape is wrong. The messages name the
 * field path but not the shape that was expected — e.g.
 *   "Cannot get the value of a token type 'StartObject' as a string."
 *   for properties.PageTitle
 * is the API's way of saying "PageTitle expected a primitive but got an
 * object — you over-wrapped it." Likewise:
 *   "Could not read value as a list. Expected array."
 *   for properties.intelStats
 * means "I expected an array but got an object — you probably passed
 * {value: [...]} where a flat array was expected, or the wrong type
 * entirely."
 *
 * This decoder reads the parsed error response, picks out the field path
 * and expected/actual token kinds, and returns hints that name what the
 * agent should change. Returned hints are surfaced alongside the raw error
 * in create_page / update_page responses so the agent doesn't have to
 * reverse-engineer the .NET error syntax.
 */

import type { TemplateProperty } from "../types.js";

export interface ShapeHint {
  /** Property key the hint is about. */
  field: string;
  /** Plain-English description of the suspected mismatch. */
  message: string;
  /** What the property's template type says about the expected shape. */
  expectedShape?: string;
  /** Compact representation of what was actually sent for this field. */
  sentShape?: string;
}

interface ParsedErrorResponse {
  error?: string;
  apiError?: unknown;
  fieldErrors?: Array<{ field?: string; detail?: string }>;
}

interface FieldErrorPair {
  field: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// Extract field-error pairs from the parsed CMS error
// ---------------------------------------------------------------------------

/**
 * The CMS returns a few different shapes:
 *   1. RFC 7807 with errors: { detail, errors: [{field, detail}] }
 *   2. Spring-style: { errors: { "properties.PageTitle": ["Cannot get..."] } }
 *   3. Top-level detail string with no per-field array
 * Pull them all into a flat (field, detail) list.
 */
function collectFieldErrors(parsed: ParsedErrorResponse): FieldErrorPair[] {
  const out: FieldErrorPair[] = [];

  if (Array.isArray(parsed.fieldErrors)) {
    for (const fe of parsed.fieldErrors) {
      if (fe.field && fe.detail) out.push({ field: fe.field, detail: fe.detail });
    }
  }

  // Sometimes the api returns errors as a map { fieldPath: [messages] }
  if (parsed.apiError && typeof parsed.apiError === "object") {
    const apiErrObj = parsed.apiError as Record<string, unknown>;
    const errorsField = apiErrObj.errors;
    if (errorsField && typeof errorsField === "object" && !Array.isArray(errorsField)) {
      for (const [field, messages] of Object.entries(errorsField as Record<string, unknown>)) {
        if (Array.isArray(messages)) {
          for (const m of messages) {
            if (typeof m === "string") out.push({ field, detail: m });
          }
        } else if (typeof messages === "string") {
          out.push({ field, detail: messages });
        }
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Recognize the .NET deserializer messages
// ---------------------------------------------------------------------------

interface ParsedDetail {
  /** The token kind the CMS got (StartObject, StartArray, String, Number, ...). */
  actualToken?: string;
  /** The CLR type or structural type it wanted (string, list, etc.). */
  expectedType?: string;
  /** Coarse category for the mismatch. */
  category: "primitive_wanted" | "array_wanted" | "object_wanted" | "unknown";
}

function parseDetail(detail: string): ParsedDetail {
  // "Cannot get the value of a token type 'StartObject' as a string."
  // → got StartObject, wanted primitive (string)
  const cantGetAs = detail.match(
    /Cannot get the value of a token type '([^']+)' as a (string|number|integer|float|boolean|long|short|double)/i
  );
  if (cantGetAs) {
    return {
      actualToken: cantGetAs[1],
      expectedType: cantGetAs[2],
      category: "primitive_wanted",
    };
  }

  // "Could not read value as a list. Expected array." (or ".Expected JSON array.")
  if (/expected.*array/i.test(detail) || /could not read value as a list/i.test(detail)) {
    return { category: "array_wanted" };
  }

  // "Expected object" / "Could not read value as object"
  if (/expected.*object/i.test(detail) || /could not read value as object/i.test(detail)) {
    return { category: "object_wanted" };
  }

  return { category: "unknown" };
}

// ---------------------------------------------------------------------------
// Field-path → top-level template property
// ---------------------------------------------------------------------------

/**
 * Given an error path like "properties.intelStats" or "$.properties.PageTitle"
 * or "properties.intelStats[0].properties.Value", return the top-level
 * property key (e.g. "intelStats", "PageTitle").
 */
function topLevelPropertyKey(path: string): string | undefined {
  const cleaned = path.replace(/^\$\.?/, "");
  const match = cleaned.match(/^properties\.([A-Za-z0-9_]+)/);
  return match?.[1];
}

// ---------------------------------------------------------------------------
// Compact representation of what was actually sent
// ---------------------------------------------------------------------------

function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[…${value.length} item${value.length === 1 ? "" : "s"}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length <= 3) return `{${keys.join(", ")}}`;
    return `{${keys.slice(0, 3).join(", ")}, …${keys.length - 3} more}`;
  }
  return typeof value;
}

function expectedShapeFor(prop: TemplateProperty | undefined): string | undefined {
  if (!prop) return undefined;
  switch (prop.type) {
    case "object[]":
      return "{value: [{properties: {<field>: {value: <primitive>}, …}}, …]}";
    case "object":
      return "{properties: {<field>: {value: <primitive>}, …}}";
    case "contentId":
      return "<32-char hex string>";
    case "contentId[]":
      return "[<32-char hex string>, …]";
    default:
      if (prop.type.endsWith("[]")) return "{value: [<primitive>, …]}";
      // Plain primitives: FLAT for the create endpoint. The earlier
      // PascalCase-only carve-out turned out to be too narrow — the
      // /preview3/experimental/content surface rejects {value: <primitive>}
      // for ALL primitive fields, not just system ones.
      return `<${prop.type}> (flat — primitives are not wrapped on create_page)`;
  }
}

// ---------------------------------------------------------------------------
// Main decoder
// ---------------------------------------------------------------------------

export function decodeShapeError(
  parsed: ParsedErrorResponse,
  sentProperties: Record<string, unknown>,
  templateProps: TemplateProperty[]
): ShapeHint[] {
  const hints: ShapeHint[] = [];
  const propByKey = new Map(templateProps.map((p) => [p.key, p]));
  const fieldErrors = collectFieldErrors(parsed);

  // Also consider the top-level error message — many CMS responses don't
  // populate fieldErrors and only return a single detail string.
  const candidates: FieldErrorPair[] = [...fieldErrors];
  if (candidates.length === 0 && parsed.error) {
    candidates.push({ field: "", detail: parsed.error });
  }

  const seen = new Set<string>();

  for (const { field, detail } of candidates) {
    const parsedDetail = parseDetail(detail);
    if (parsedDetail.category === "unknown") continue;

    const key = topLevelPropertyKey(field) ?? extractKeyFromDetail(detail);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);

    const prop = propByKey.get(key);
    const expected = expectedShapeFor(prop);
    const sent = describeShape(sentProperties[key]);

    let message: string;
    if (parsedDetail.category === "primitive_wanted") {
      message =
        `Optimizely expected a primitive ${parsedDetail.expectedType ?? "value"} for '${key}' but got an object. ` +
        `Most common cause: you passed an extra wrapper layer. ` +
        (prop ? `For type=${prop.type}, send ${expected}. ` : "Try unwrapping one layer of {value: …}. ") +
        `Sent: ${sent}.`;
    } else if (parsedDetail.category === "array_wanted") {
      message =
        `Optimizely expected an array for '${key}' but got an object. ` +
        (prop?.type === "object[]"
          ? `For an object[] field, send the array directly under {value: [...]} — make sure each item is {properties: {<field>: {value: …}, …}}. `
          : "Make sure the value is a JSON array, not wrapped in an object. ") +
        `Sent: ${sent}.`;
    } else {
      message =
        `Optimizely expected an object for '${key}' but got something else. ` +
        (expected ? `Expected: ${expected}. ` : "") +
        `Sent: ${sent}.`;
    }

    hints.push({
      field: key,
      message,
      ...(expected ? { expectedShape: expected } : {}),
      sentShape: sent,
    });
  }

  return hints;
}

/**
 * Last-ditch field extractor when the field path isn't on the error pair
 * but is mentioned in the message body — e.g. "for properties.PageTitle".
 */
function extractKeyFromDetail(detail: string): string | undefined {
  const m = detail.match(/properties\.([A-Za-z0-9_]+)/);
  return m?.[1];
}
