import { describe, it, expect } from "vitest";
import { normalizeProperties } from "../src/services/property-normalizer.js";
import type { TemplateProperty } from "../src/types.js";

const stringProp: TemplateProperty = {
  key: "headline",
  label: "Headline",
  type: "string",
  required: true,
  description: "",
  example: { value: "" },
};

const urlProp: TemplateProperty = {
  key: "ctaUrl",
  label: "CTA URL",
  type: "url",
  required: false,
  description: "",
  example: { value: "https://example.com" },
};

const componentArrayProp: TemplateProperty = {
  key: "intelStats",
  label: "Stats",
  type: "object[]",
  required: false,
  description: "",
  example: { value: [{ properties: { Value: { value: "" }, Label: { value: "" } } }] },
  itemShape: { Value: "string", Label: "string" },
};

const stringArrayProp: TemplateProperty = {
  key: "tags",
  label: "Tags",
  type: "string[]",
  required: false,
  description: "",
  example: { value: [""] },
};

const contentRefProp: TemplateProperty = {
  key: "hero",
  label: "Hero",
  type: "contentId",
  required: false,
  description: "",
  example: "<existing-content-id>",
};

const contentRefArrayProp: TemplateProperty = {
  key: "related",
  label: "Related",
  type: "contentId[]",
  required: false,
  description: "",
  example: ["<id-1>"],
};

const componentProp: TemplateProperty = {
  key: "cta",
  label: "Cta",
  type: "object",
  required: false,
  description: "",
  example: { properties: { Label: { value: "" }, Url: { value: "https://example.com" } } },
  itemShape: { Label: "string", Url: "string" },
};

describe("normalizeProperties — primitives", () => {
  it("wraps a flat string in {value: …}", () => {
    const { properties } = normalizeProperties(
      { headline: "Hello" },
      [stringProp]
    );
    expect(properties.headline).toEqual({ value: "Hello" });
  });

  it("leaves an already-wrapped string alone", () => {
    const { properties } = normalizeProperties(
      { headline: { value: "Hello" } },
      [stringProp]
    );
    expect(properties.headline).toEqual({ value: "Hello" });
  });

  it("strips a double-wrap {value: {value: 'x'}} → {value: 'x'}", () => {
    const { properties } = normalizeProperties(
      { headline: { value: { value: "Hello" } } },
      [stringProp]
    );
    expect(properties.headline).toEqual({ value: "Hello" });
  });

  it("wraps a flat URL", () => {
    const { properties } = normalizeProperties(
      { ctaUrl: "https://x.com" },
      [urlProp]
    );
    expect(properties.ctaUrl).toEqual({ value: "https://x.com" });
  });
});

describe("normalizeProperties — content references", () => {
  it("leaves contentId raw (string)", () => {
    const { properties } = normalizeProperties(
      { hero: "abc123" },
      [contentRefProp]
    );
    expect(properties.hero).toBe("abc123");
  });

  it("unwraps an accidentally-wrapped contentId", () => {
    const { properties } = normalizeProperties(
      { hero: { value: "abc123" } },
      [contentRefProp]
    );
    expect(properties.hero).toBe("abc123");
  });

  it("leaves contentId[] as a flat array of strings", () => {
    const { properties } = normalizeProperties(
      { related: ["a", "b"] },
      [contentRefArrayProp]
    );
    expect(properties.related).toEqual(["a", "b"]);
  });

  it("coerces a single contentId string to a one-element array", () => {
    const { properties } = normalizeProperties(
      { related: "a" },
      [contentRefArrayProp]
    );
    expect(properties.related).toEqual(["a"]);
  });
});

describe("normalizeProperties — scalar arrays", () => {
  it("wraps a flat string[] in {value: [...]}", () => {
    const { properties } = normalizeProperties(
      { tags: ["a", "b"] },
      [stringArrayProp]
    );
    expect(properties.tags).toEqual({ value: ["a", "b"] });
  });

  it("accepts {value: [...]} unchanged", () => {
    const { properties } = normalizeProperties(
      { tags: { value: ["a", "b"] } },
      [stringArrayProp]
    );
    expect(properties.tags).toEqual({ value: ["a", "b"] });
  });
});

describe("normalizeProperties — component arrays (object[])", () => {
  it("wraps flat array of flat-prop items into {value: [{properties: {Value: {value: …}}}]}", () => {
    const { properties } = normalizeProperties(
      { intelStats: [{ Value: "494", Label: "employees" }] },
      [componentArrayProp]
    );
    expect(properties.intelStats).toEqual({
      value: [
        { properties: { Value: { value: "494" }, Label: { value: "employees" } } },
      ],
    });
  });

  it("accepts items already shaped as {properties: {…}}", () => {
    const { properties } = normalizeProperties(
      {
        intelStats: [
          { properties: { Value: { value: "494" }, Label: { value: "employees" } } },
        ],
      },
      [componentArrayProp]
    );
    expect(properties.intelStats).toEqual({
      value: [
        { properties: { Value: { value: "494" }, Label: { value: "employees" } } },
      ],
    });
  });

  it("accepts {value: [...]} flat items at the outer layer", () => {
    const { properties } = normalizeProperties(
      { intelStats: { value: [{ Value: "494", Label: "employees" }] } },
      [componentArrayProp]
    );
    expect(properties.intelStats).toEqual({
      value: [
        { properties: { Value: { value: "494" }, Label: { value: "employees" } } },
      ],
    });
  });

  it("accepts mixed inner shapes — some wrapped, some flat", () => {
    const { properties } = normalizeProperties(
      {
        intelStats: [
          { Value: "494", Label: { value: "employees" } },
        ],
      },
      [componentArrayProp]
    );
    expect(properties.intelStats).toEqual({
      value: [
        { properties: { Value: { value: "494" }, Label: { value: "employees" } } },
      ],
    });
  });
});

describe("normalizeProperties — single component (object)", () => {
  it("wraps a flat-field object as {properties: {…}}", () => {
    const { properties } = normalizeProperties(
      { cta: { Label: "Buy", Url: "https://x.com" } },
      [componentProp]
    );
    expect(properties.cta).toEqual({
      properties: {
        Label: { value: "Buy" },
        Url: { value: "https://x.com" },
      },
    });
  });

  it("accepts an already-shaped {properties: {…}} object", () => {
    const { properties } = normalizeProperties(
      {
        cta: {
          properties: { Label: { value: "Buy" }, Url: { value: "https://x.com" } },
        },
      },
      [componentProp]
    );
    expect(properties.cta).toEqual({
      properties: {
        Label: { value: "Buy" },
        Url: { value: "https://x.com" },
      },
    });
  });
});

describe("normalizeProperties — unknowns + case", () => {
  it("recovers from case mismatch and warns", () => {
    const { properties, warnings } = normalizeProperties(
      { Headline: "Hi" },
      [stringProp]
    );
    expect(properties.headline).toEqual({ value: "Hi" });
    expect(warnings.find((w) => w.key === "Headline")).toBeDefined();
  });

  it("passes through unknown keys with a warning", () => {
    const { properties, warnings } = normalizeProperties(
      { mystery: "huh" },
      [stringProp]
    );
    expect(properties.mystery).toBe("huh");
    expect(warnings.some((w) => w.key === "mystery")).toBe(true);
  });
});
