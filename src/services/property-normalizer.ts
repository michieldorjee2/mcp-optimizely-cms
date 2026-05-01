/**
 * Coerce caller-provided property values into the canonical CMS submission
 * shape, using the cached template to know each property's type.
 *
 * Why this exists: Optimizely's submission format is fiddly. Primitives wrap
 * as {value: …}, components as {properties: {…}}, component arrays as
 * {value: [{properties: {…}}, …]}, scalar arrays as {value: […]}, and
 * content references stay raw. Agents — even capable ones — get this wrong
 * on the first try, then over-correct in the wrong direction (e.g. "just
 * make everything flat") because the API errors are cryptic .NET
 * deserialization messages that don't name the shape they wanted.
 *
 * The fix: accept any reasonable shape (flat OR wrapped, with or without
 * intermediate {properties:…} layers) and normalize to the one shape the
 * CMS accepts. The template tells us the type of every key, so the
 * wrapping rule is deterministic — no guessing.
 *
 * Properties not in the template pass through untouched (we can't normalize
 * what we don't know about, and unknown keys may be intentional).
 */

import type { TemplateProperty } from "../types.js";

export interface NormalizationWarning {
  /** Property key the warning is about. */
  key: string;
  /** Short human-readable description of what was changed or what looks off. */
  message: string;
}

export interface NormalizationResult {
  /** Normalized properties, ready to be sent as the `properties` field. */
  properties: Record<string, unknown>;
  /**
   * Notes on shape coercions or unrecognized inputs. Surfaced in the tool
   * response so the agent can learn the canonical shape — but the call
   * still proceeds with the normalized payload.
   */
  warnings: NormalizationWarning[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * If v looks like {value: X} or {properties: X} with no other keys, return X.
 * Otherwise return v unchanged. Used to peel one layer of accidental wrap
 * before re-wrapping in the right shape.
 */
function unwrapOnce(v: unknown): unknown {
  if (!isPlainObject(v)) return v;
  const keys = Object.keys(v);
  if (keys.length === 1 && (keys[0] === "value" || keys[0] === "properties")) {
    return v[keys[0]];
  }
  return v;
}

/** Repeatedly unwrap {value: …} / {properties: …} layers down to the inner value. */
function unwrapDeep(v: unknown): unknown {
  let cur = v;
  let next = unwrapOnce(cur);
  while (next !== cur) {
    cur = next;
    next = unwrapOnce(cur);
  }
  return cur;
}

function isPrimitive(v: unknown): v is string | number | boolean | null {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

/**
 * Optimizely's CMS REST API has a quirk that took a real production
 * incident to pin down: PascalCase property keys (PageTitle,
 * MetaDescription, MetaKeywords, MetaTitle, …) are system/metadata
 * fields inherited from base content types like `_Page`. They live in
 * the `properties` map alongside custom fields, but the WRITE endpoint
 * rejects them when wrapped in {value: …} with the message
 *   "Cannot get the value of a token type 'StartObject' as a string."
 *
 * Custom user-defined properties are camelCase by convention
 * (comparisonHeadline, intelStats, …) and DO require the {value: …}
 * wrap. The first-letter-case test cleanly distinguishes the two
 * without instrumenting the upstream contenttype response.
 *
 * The READ endpoint returns these flat fields wrapped, which is what
 * led the agent to assume the same shape works for writes — it
 * doesn't, only for these particular keys.
 */
function isFlatSystemKey(key: string): boolean {
  if (!key) return false;
  const first = key[0];
  return !!first && first === first.toUpperCase() && first !== first.toLowerCase();
}

// ---------------------------------------------------------------------------
// Per-property normalization
// ---------------------------------------------------------------------------

/**
 * Component item: either a raw {field1: v1, field2: v2, …} object, or
 * already-shaped {properties: {field1: {value: v1}, …}}, or a half-shape.
 * Accept all and emit {properties: {field1: {value: v1}, …}}.
 */
function normalizeComponentItem(item: unknown, key: string, warnings: NormalizationWarning[]): unknown {
  if (!isPlainObject(item)) {
    warnings.push({
      key,
      message: `Component item is not an object — left as-is. Got ${typeof item}.`,
    });
    return item;
  }

  // Peel an outer {properties: {…}} if present so we operate on the inner field map.
  let inner: Record<string, unknown> = item;
  const keys = Object.keys(item);
  if (keys.length === 1 && keys[0] === "properties" && isPlainObject(item.properties)) {
    inner = item.properties;
  }

  const wrappedProps: Record<string, unknown> = {};
  for (const [fieldKey, fieldVal] of Object.entries(inner)) {
    // Each field inside a component is itself either a primitive (needs
    // {value: …}) or already wrapped. We don't have per-field types for
    // sub-components in the template, so use a heuristic: if it looks
    // already wrapped {value: X}, keep it; otherwise wrap.
    if (isPlainObject(fieldVal)) {
      const subKeys = Object.keys(fieldVal);
      if (subKeys.length === 1 && subKeys[0] === "value") {
        wrappedProps[fieldKey] = fieldVal;
        continue;
      }
    }
    if (Array.isArray(fieldVal) || isPrimitive(fieldVal)) {
      wrappedProps[fieldKey] = { value: fieldVal };
    } else {
      // Unknown shape — pass through raw. CMS may accept (e.g. nested
      // components inside a component) or reject loudly.
      wrappedProps[fieldKey] = fieldVal;
    }
  }

  return { properties: wrappedProps };
}

function normalizeValue(
  value: unknown,
  prop: TemplateProperty,
  warnings: NormalizationWarning[]
): unknown {
  // ---- contentId / contentId[] : raw string IDs, no wrapping ----
  if (prop.type === "contentId") {
    const inner = unwrapDeep(value);
    if (typeof inner !== "string") {
      warnings.push({
        key: prop.key,
        message: `Expected a contentId string for '${prop.key}', got ${Array.isArray(inner) ? "array" : typeof inner}.`,
      });
    }
    return inner;
  }

  if (prop.type === "contentId[]") {
    let inner = unwrapDeep(value);
    if (!Array.isArray(inner)) {
      // Maybe the agent passed {value: ["id"]} — already unwrapped above.
      // Or a single string instead of array — wrap it.
      if (typeof inner === "string") inner = [inner];
      else {
        warnings.push({
          key: prop.key,
          message: `Expected an array of contentId strings for '${prop.key}'.`,
        });
        return value;
      }
    }
    return inner;
  }

  // ---- object[] : array of components ----
  if (prop.type === "object[]") {
    // Accept either flat array or {value: [...]} or {value: {value: [...]}}
    const peeled = unwrapDeep(value);
    if (!Array.isArray(peeled)) {
      warnings.push({
        key: prop.key,
        message: `Expected an array for '${prop.key}' (object[]). Left as-is — CMS will likely reject.`,
      });
      return value;
    }
    return {
      value: peeled.map((item) => normalizeComponentItem(item, prop.key, warnings)),
    };
  }

  // ---- object : single component ----
  if (prop.type === "object") {
    const peeled = unwrapOnce(value);
    return normalizeComponentItem(peeled, prop.key, warnings);
  }

  // ---- scalar arrays (string[], url[], number[], etc.) ----
  if (prop.type.endsWith("[]")) {
    let peeled = unwrapDeep(value);
    if (!Array.isArray(peeled)) {
      // Tolerate a single primitive — wrap it in a one-element array.
      if (isPrimitive(peeled)) {
        peeled = [peeled];
      } else {
        warnings.push({
          key: prop.key,
          message: `Expected an array for '${prop.key}' (${prop.type}). Left as-is — CMS will likely reject.`,
        });
        return value;
      }
    }
    return { value: peeled };
  }

  // ---- primitive scalars (string, url, boolean, number, etc.) ----
  // Strip any number of accidental wrappers down to the inner primitive.
  // Then either re-wrap as {value: …} (for custom user-defined fields)
  // or pass through flat (for PascalCase system/metadata fields like
  // PageTitle / MetaDescription that the CMS write endpoint rejects when
  // wrapped — see isFlatSystemKey for the reasoning).
  const inner = unwrapDeep(value);
  if (isFlatSystemKey(prop.key)) {
    return inner;
  }
  return { value: inner };
}

/**
 * Normalize an entire `properties` object using the template. Unknown keys
 * (not in the template) are passed through untouched and a warning is added.
 */
export function normalizeProperties(
  raw: Record<string, unknown>,
  templateProps: TemplateProperty[]
): NormalizationResult {
  const propByKey = new Map(templateProps.map((p) => [p.key, p]));
  const lowercaseLookup = new Map(
    templateProps.map((p) => [p.key.toLowerCase(), p.key])
  );
  const normalized: Record<string, unknown> = {};
  const warnings: NormalizationWarning[] = [];

  for (const [key, value] of Object.entries(raw)) {
    let prop = propByKey.get(key);

    // Case-insensitive fallback: agents sometimes capitalize differently
    // (PageTitle vs pageTitle). Recover silently but warn.
    if (!prop) {
      const realKey = lowercaseLookup.get(key.toLowerCase());
      if (realKey && realKey !== key) {
        prop = propByKey.get(realKey);
        warnings.push({
          key,
          message: `'${key}' did not match any template property exactly. Using '${realKey}' (case-insensitive match).`,
        });
        normalized[realKey] = normalizeValue(value, prop!, warnings);
        continue;
      }
    }

    if (!prop) {
      warnings.push({
        key,
        message: `'${key}' is not a known property on this content type. Passed through to the CMS as-is.`,
      });
      normalized[key] = value;
      continue;
    }

    normalized[prop.key] = normalizeValue(value, prop, warnings);
  }

  return { properties: normalized, warnings };
}
