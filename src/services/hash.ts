import { createHash } from "node:crypto";

/**
 * Stable JSON stringify — keys are sorted recursively so the same logical
 * value always produces the same hash regardless of key order.
 *
 * Used by:
 *   - update_page no-op short-circuit (compare desired payload to last
 *     published version's payload).
 *   - create_page idempotency keys (cache result by hash of caller args).
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/** SHA-256 hex digest of a JSON-stable representation. */
export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}
