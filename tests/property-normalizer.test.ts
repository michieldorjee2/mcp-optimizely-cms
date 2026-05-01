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

describe("normalizeProperties — primitives (default: flat for /preview3/ create)", () => {
  it("flat string passes through flat", () => {
    const { properties } = normalizeProperties(
      { headline: "Hello" },
      [stringProp]
    );
    expect(properties.headline).toBe("Hello");
  });

  it("agent-wrapped {value: 'Hello'} is unwrapped to flat", () => {
    const { properties } = normalizeProperties(
      { headline: { value: "Hello" } },
      [stringProp]
    );
    expect(properties.headline).toBe("Hello");
  });

  it("double-wrapped {value: {value: 'x'}} unwraps to flat", () => {
    const { properties } = normalizeProperties(
      { headline: { value: { value: "Hello" } } },
      [stringProp]
    );
    expect(properties.headline).toBe("Hello");
  });

  it("URL primitive passes through flat", () => {
    const { properties } = normalizeProperties(
      { ctaUrl: "https://x.com" },
      [urlProp]
    );
    expect(properties.ctaUrl).toBe("https://x.com");
  });
});

describe("normalizeProperties — primitives with wrapPrimitivesAsValue (update_page / /v1/)", () => {
  it("flat string gets wrapped when wrapPrimitivesAsValue is true", () => {
    const { properties } = normalizeProperties(
      { headline: "Hello" },
      [stringProp],
      { wrapPrimitivesAsValue: true }
    );
    expect(properties.headline).toEqual({ value: "Hello" });
  });

  it("already-wrapped stays wrapped (no double-wrap)", () => {
    const { properties } = normalizeProperties(
      { headline: { value: "Hello" } },
      [stringProp],
      { wrapPrimitivesAsValue: true }
    );
    expect(properties.headline).toEqual({ value: "Hello" });
  });

  it("URL primitive wrapped when wrapPrimitivesAsValue is true", () => {
    const { properties } = normalizeProperties(
      { ctaUrl: "https://x.com" },
      [urlProp],
      { wrapPrimitivesAsValue: true }
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

describe("normalizeProperties — both PascalCase and camelCase primitives are flat by default (create_page surface)", () => {
  // Earlier the rule was per-key (PascalCase flat / camelCase wrapped).
  // Production logs proved that wrong: every camelCase primitive
  // (eyebrow, comparisonDescription, headline, …) hits the same .NET
  // StartObject error on /preview3/experimental/content. Now ALL
  // primitives are flat for create_page.
  const pageTitle: TemplateProperty = {
    key: "PageTitle", label: "Page Title", type: "string",
    required: true, description: "", example: "",
  };
  const eyebrow: TemplateProperty = {
    key: "eyebrow", label: "Eyebrow", type: "string",
    required: true, description: "", example: "",
  };

  it("PageTitle (PascalCase) and eyebrow (camelCase) are both flat", () => {
    const { properties } = normalizeProperties(
      { PageTitle: "Hi", eyebrow: "Hi" },
      [pageTitle, eyebrow]
    );
    expect(properties.PageTitle).toBe("Hi");
    expect(properties.eyebrow).toBe("Hi");
  });

  it("agent-wrapped values for either case are unwrapped to flat", () => {
    const { properties } = normalizeProperties(
      { PageTitle: { value: "Hi" }, eyebrow: { value: "Hi" } },
      [pageTitle, eyebrow]
    );
    expect(properties.PageTitle).toBe("Hi");
    expect(properties.eyebrow).toBe("Hi");
  });

  it("with wrapPrimitivesAsValue:true (update_page surface) both wrap", () => {
    const { properties } = normalizeProperties(
      { PageTitle: "Hi", eyebrow: "Hi" },
      [pageTitle, eyebrow],
      { wrapPrimitivesAsValue: true }
    );
    expect(properties.PageTitle).toEqual({ value: "Hi" });
    expect(properties.eyebrow).toEqual({ value: "Hi" });
  });
});

describe("normalizeProperties — unknowns + case", () => {
  it("recovers from case mismatch and warns", () => {
    const { properties, warnings } = normalizeProperties(
      { Headline: "Hi" },
      [stringProp]
    );
    expect(properties.headline).toBe("Hi");
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
