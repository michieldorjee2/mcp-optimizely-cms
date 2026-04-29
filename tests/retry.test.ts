import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../src/services/retry.js";
import { buildCmsApiError } from "../src/services/errors.js";

describe("withRetry", () => {
  it("returns the value on first-attempt success", async () => {
    const op = vi.fn().mockResolvedValue("ok");
    expect(await withRetry(op, { baseMs: 1 })).toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries retryable errors then succeeds", async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(buildCmsApiError({ status: 503, endpoint: "/x", method: "GET", bodyText: "{}" }))
      .mockRejectedValueOnce(buildCmsApiError({ status: 503, endpoint: "/x", method: "GET", bodyText: "{}" }))
      .mockResolvedValue("ok");
    expect(await withRetry(op, { baseMs: 1, attempts: 3 })).toBe("ok");
    expect(op).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry non-retryable errors", async () => {
    const err = buildCmsApiError({ status: 400, endpoint: "/x", method: "POST", bodyText: "{}" });
    const op = vi.fn().mockRejectedValue(err);
    await expect(withRetry(op, { baseMs: 1, attempts: 5 })).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("gives up after the configured attempt count", async () => {
    const err = buildCmsApiError({ status: 503, endpoint: "/x", method: "GET", bodyText: "{}" });
    const op = vi.fn().mockRejectedValue(err);
    await expect(withRetry(op, { baseMs: 1, attempts: 3 })).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(3);
  });

  it("invokes onRetry on each retry", async () => {
    const onRetry = vi.fn();
    const err = buildCmsApiError({ status: 503, endpoint: "/x", method: "GET", bodyText: "{}" });
    const op = vi.fn().mockRejectedValueOnce(err).mockResolvedValue("ok");
    await withRetry(op, { baseMs: 1, attempts: 3, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(err, 1, expect.any(Number));
  });
});
