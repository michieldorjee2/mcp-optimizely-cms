import { describe, it, expect } from "vitest";
import {
  ContentResponseSchema,
  ContentTypeSchema,
  GraphContentResponseSchema,
  TokenResponseSchema,
  VersionListResponseSchema,
} from "../src/services/schemas.js";

describe("TokenResponseSchema", () => {
  it("accepts the minimal token shape", () => {
    expect(
      TokenResponseSchema.parse({ access_token: "x", expires_in: 3600 })
    ).toMatchObject({ access_token: "x", expires_in: 3600 });
  });

  it("rejects when access_token is missing", () => {
    expect(() => TokenResponseSchema.parse({ expires_in: 1 })).toThrow();
  });
});

describe("ContentResponseSchema", () => {
  it("accepts a full content response", () => {
    const data = ContentResponseSchema.parse({
      key: "abc",
      displayName: "Foo",
      contentType: ["FooPage", "_Page"],
      locale: "en",
      status: "published",
      routeSegment: "foo",
      properties: { title: { value: "x" } },
      _metadata: { version: "12" },
    });
    expect(data.key).toBe("abc");
    expect(data._metadata?.version).toBe("12");
  });

  it("accepts a stripped metadata-only response", () => {
    expect(ContentResponseSchema.parse({ key: "abc" })).toMatchObject({ key: "abc" });
  });

  it("preserves unknown fields via passthrough", () => {
    const data = ContentResponseSchema.parse({ key: "abc", weirdNewField: 123 });
    expect((data as Record<string, unknown>).weirdNewField).toBe(123);
  });
});

describe("VersionListResponseSchema", () => {
  it("accepts a bare array", () => {
    expect(VersionListResponseSchema.parse([{ key: "a" }, { key: "b" }])).toHaveLength(2);
  });

  it("accepts the wrapped {items: [...]} shape", () => {
    const out = VersionListResponseSchema.parse({ items: [{ key: "a" }] });
    expect(Array.isArray(out) ? out : out.items).toHaveLength(1);
  });
});

describe("ContentTypeSchema", () => {
  it("parses property definitions with validation constraints", () => {
    const ct = ContentTypeSchema.parse({
      key: "X",
      properties: {
        title: { type: "string", required: true, maxLength: 100 },
        body: { type: "richText" },
        tags: { type: "array", items: { type: "string" }, minItems: 1 },
      },
    });
    expect(ct.properties?.title?.required).toBe(true);
    expect(ct.properties?.title?.maxLength).toBe(100);
  });
});

describe("GraphContentResponseSchema", () => {
  it("parses a non-error Graph response", () => {
    const out = GraphContentResponseSchema.parse({
      data: {
        _Content: {
          items: [{ _metadata: { key: "a", displayName: "A" } }],
        },
      },
    });
    expect(out.data?._Content?.items).toHaveLength(1);
  });

  it("parses an error response", () => {
    const out = GraphContentResponseSchema.parse({
      errors: [{ message: "boom" }],
    });
    expect(out.errors?.[0]?.message).toBe("boom");
  });
});
