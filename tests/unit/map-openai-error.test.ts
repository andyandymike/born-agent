import { describe, expect, it } from "vitest";

import { mapOpenAIError } from "../../src/providers/openai/map-openai-error.js";

describe("mapOpenAIError", () => {
  it("classifies authentication without copying SDK secrets or messages", () => {
    const secret = "sk-secret-in-error-value";
    const error = mapOpenAIError({
      cause: { headers: { authorization: `Bearer ${secret}` } },
      code: "invalid_api_key",
      headers: { authorization: `Bearer ${secret}` },
      message: `bad key ${secret}`,
      requestID: "req_auth",
      stack: `stack ${secret}`,
      status: 401,
    });
    expect(error).toMatchObject({
      category: "auth",
      code: "authentication_failed",
      providerRequestId: "req_auth",
      retryable: false,
      status: 401,
    });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain("headers");
    expect(JSON.stringify(error)).not.toContain("stack");
  });

  it.each([
    [429, "rate_limit"],
    [503, "provider"],
    [400, "provider"],
    [undefined, "network"],
  ] as const)("classifies status %s as %s", (status, category) => {
    expect(mapOpenAIError({ status })).toMatchObject({ category });
  });

  it("classifies quota codes separately from generic rate limits", () => {
    expect(
      mapOpenAIError({ code: "insufficient_quota", status: 429 }),
    ).toMatchObject({ category: "quota", code: "quota_exceeded" });
  });
});
