import { describe, it, expect } from "vitest";
import { stableStringify, stableHash } from "../src/services/hash.js";

describe("stableStringify", () => {
  it("produces identical output regardless of key insertion order", () => {
    const a = { z: 1, a: 2, m: 3 };
    const b = { a: 2, m: 3, z: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("stabilises nested objects too", () => {
    const a = { outer: { z: 1, a: 2 } };
    const b = { outer: { a: 2, z: 1 } };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("preserves array order (arrays are ordered, objects aren't)", () => {
    expect(stableStringify([1, 2, 3])).toBe("[1,2,3]");
    expect(stableStringify([3, 2, 1])).toBe("[3,2,1]");
  });

  it("handles primitives", () => {
    expect(stableStringify("foo")).toBe('"foo"');
    expect(stableStringify(42)).toBe("42");
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(true)).toBe("true");
  });

  it("escapes string keys correctly", () => {
    expect(stableStringify({ 'key"with"quotes': 1 })).toBe('{"key\\"with\\"quotes":1}');
  });
});

describe("stableHash", () => {
  it("produces identical hashes for logically-equal objects", () => {
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
  });

  it("produces different hashes for different content", () => {
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
  });

  it("returns a 64-character hex string (sha256)", () => {
    const h = stableHash({ x: "y" });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
