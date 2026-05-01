import { describe, it, expect } from "vitest";
import { decodeShapeError } from "../src/services/shape-error-decoder.js";
import type { TemplateProperty } from "../src/types.js";

const stringProp: TemplateProperty = {
  key: "headline",
  label: "Headline",
  type: "string",
  required: true,
  description: "",
  example: { value: "" },
};

const systemMetaProp: TemplateProperty = {
  key: "PageTitle",
  label: "Page Title",
  type: "string",
  required: true,
  description: "",
  example: "",
};

const arrayProp: TemplateProperty = {
  key: "intelStats",
  label: "Stats",
  type: "object[]",
  required: false,
  description: "",
  example: { value: [{ properties: {} }] },
};

describe("decodeShapeError", () => {
  it("turns the .NET StartObject-as-string error into a primitive_wanted hint with flat expected shape (camelCase)", () => {
    const hints = decodeShapeError(
      {
        error: "Validation failed.",
        fieldErrors: [
          {
            field: "properties.headline",
            detail: "Cannot get the value of a token type 'StartObject' as a string.",
          },
        ],
      },
      { headline: { value: "Hi" } },
      [stringProp]
    );
    expect(hints).toHaveLength(1);
    expect(hints[0].field).toBe("headline");
    expect(hints[0].message).toMatch(/primitive/i);
    expect(hints[0].expectedShape).toMatch(/flat/);
  });

  it("for PageTitle (PascalCase) the expected shape is also flat", () => {
    const hints = decodeShapeError(
      {
        error: "Validation failed.",
        fieldErrors: [
          {
            field: "properties.PageTitle",
            detail: "Cannot get the value of a token type 'StartObject' as a string.",
          },
        ],
      },
      { PageTitle: { value: "Hi" } },
      [systemMetaProp]
    );
    expect(hints).toHaveLength(1);
    expect(hints[0].field).toBe("PageTitle");
    expect(hints[0].expectedShape).toMatch(/flat/);
  });

  it("turns the array-expected error into an array_wanted hint", () => {
    const hints = decodeShapeError(
      {
        error: "Validation failed.",
        fieldErrors: [
          {
            field: "properties.intelStats",
            detail: "Could not read value as a list. Expected array.",
          },
        ],
      },
      { intelStats: { value: { value: [] } } },
      [arrayProp]
    );
    expect(hints).toHaveLength(1);
    expect(hints[0].field).toBe("intelStats");
    expect(hints[0].message).toMatch(/array/i);
  });

  it("recovers the field name from the message body when the error has no field path", () => {
    const hints = decodeShapeError(
      {
        error:
          "Cannot get the value of a token type 'StartObject' as a string. for properties.PageTitle",
      },
      { PageTitle: { value: { value: "x" } } },
      [stringProp]
    );
    expect(hints).toHaveLength(1);
    expect(hints[0].field).toBe("PageTitle");
  });

  it("decodes Spring-style errors-by-field maps", () => {
    const hints = decodeShapeError(
      {
        error: "Bad request",
        apiError: {
          errors: {
            "properties.PageTitle": [
              "Cannot get the value of a token type 'StartObject' as a string.",
            ],
          },
        },
      },
      { PageTitle: { something: "wrapped" } },
      [stringProp]
    );
    expect(hints).toHaveLength(1);
    expect(hints[0].field).toBe("PageTitle");
  });

  it("returns no hints for unrelated errors", () => {
    const hints = decodeShapeError(
      {
        error: "Unauthorized",
        fieldErrors: [{ field: "auth", detail: "token expired" }],
      },
      {},
      [stringProp]
    );
    expect(hints).toHaveLength(0);
  });

  it("dedupes hints per top-level field", () => {
    const hints = decodeShapeError(
      {
        fieldErrors: [
          {
            field: "properties.PageTitle",
            detail: "Cannot get the value of a token type 'StartObject' as a string.",
          },
          {
            field: "properties.PageTitle",
            detail: "Cannot get the value of a token type 'StartObject' as a string.",
          },
        ],
      },
      { PageTitle: { value: {} } },
      [stringProp]
    );
    expect(hints).toHaveLength(1);
  });
});
