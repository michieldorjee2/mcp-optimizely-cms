import { describe, it, expect } from "vitest";
import {
  CmsApiError,
  CmsAuthError,
  CmsNotFoundError,
  CmsValidationError,
  LocalValidationError,
  buildCmsApiError,
  errorToResponse,
  isRetryable,
} from "../src/services/errors.js";

describe("buildCmsApiError", () => {
  it("returns CmsAuthError for 401/403", () => {
    expect(
      buildCmsApiError({ status: 401, endpoint: "/x", method: "GET", bodyText: "{}" })
    ).toBeInstanceOf(CmsAuthError);
    expect(
      buildCmsApiError({ status: 403, endpoint: "/x", method: "GET", bodyText: "{}" })
    ).toBeInstanceOf(CmsAuthError);
  });

  it("returns CmsNotFoundError for 404", () => {
    expect(
      buildCmsApiError({ status: 404, endpoint: "/x", method: "GET", bodyText: "{}" })
    ).toBeInstanceOf(CmsNotFoundError);
  });

  it("returns CmsValidationError for 400/422", () => {
    expect(
      buildCmsApiError({ status: 400, endpoint: "/x", method: "POST", bodyText: "{}" })
    ).toBeInstanceOf(CmsValidationError);
    expect(
      buildCmsApiError({ status: 422, endpoint: "/x", method: "POST", bodyText: "{}" })
    ).toBeInstanceOf(CmsValidationError);
  });

  it("returns plain CmsApiError for other 4xx/5xx", () => {
    const e = buildCmsApiError({ status: 500, endpoint: "/x", method: "GET", bodyText: "{}" });
    expect(e).toBeInstanceOf(CmsApiError);
    expect(e).not.toBeInstanceOf(CmsAuthError);
    expect(e).not.toBeInstanceOf(CmsNotFoundError);
    expect(e).not.toBeInstanceOf(CmsValidationError);
  });

  it("parses the body as JSON when possible", () => {
    const e = buildCmsApiError({
      status: 400,
      endpoint: "/x",
      method: "POST",
      bodyText: '{"detail":"bad","errors":[{"field":"a","detail":"b"}]}',
    });
    expect(e.body).toEqual({
      detail: "bad",
      errors: [{ field: "a", detail: "b" }],
    });
    expect(e.fieldErrors()).toEqual([{ field: "a", detail: "b" }]);
  });

  it("falls back to text body when JSON parse fails", () => {
    const e = buildCmsApiError({ status: 500, endpoint: "/x", method: "GET", bodyText: "<html>" });
    expect(e.body).toBe("<html>");
  });
});

describe("isRetryable", () => {
  const at = (status: number) =>
    buildCmsApiError({ status, endpoint: "/x", method: "GET", bodyText: "{}" });

  it("retries on 408/429/5xx", () => {
    expect(isRetryable(at(408))).toBe(true);
    expect(isRetryable(at(429))).toBe(true);
    expect(isRetryable(at(500))).toBe(true);
    expect(isRetryable(at(502))).toBe(true);
    expect(isRetryable(at(503))).toBe(true);
  });

  it("does NOT retry on auth/notfound/validation", () => {
    expect(isRetryable(at(401))).toBe(false);
    expect(isRetryable(at(403))).toBe(false);
    expect(isRetryable(at(404))).toBe(false);
    expect(isRetryable(at(400))).toBe(false);
    expect(isRetryable(at(422))).toBe(false);
  });

  it("retries on TypeError (network)", () => {
    expect(isRetryable(new TypeError("fetch failed"))).toBe(true);
  });
});

describe("errorToResponse", () => {
  it("serializes CmsApiError with full structured fields", () => {
    const e = buildCmsApiError({
      status: 400,
      endpoint: "/v1/content/abc/versions",
      method: "POST",
      bodyText: '{"detail":"bad","errors":[{"field":"x","detail":"y"}]}',
    });
    const r = errorToResponse(e);
    expect(r.status).toBe(400);
    expect(r.endpoint).toBe("/v1/content/abc/versions");
    expect(r.method).toBe("POST");
    expect(r.fieldErrors).toEqual([{ field: "x", detail: "y" }]);
  });

  it("serializes LocalValidationError with errors array", () => {
    const e = new LocalValidationError([{ field: "x", detail: "missing" }]);
    const r = errorToResponse(e);
    expect(r.fieldErrors).toEqual([{ field: "x", detail: "missing" }]);
  });

  it("falls back to .message for generic Errors", () => {
    expect(errorToResponse(new Error("kaboom")).error).toBe("kaboom");
  });

  it("stringifies non-Error values", () => {
    expect(errorToResponse("kaboom").error).toBe("kaboom");
    expect(errorToResponse(42).error).toBe("42");
  });
});
