import { describe, expect, it } from "vitest";

import { mapOpenAIError } from "../../src/providers/openai/map-openai-error.js";

describe("mapOpenAIError", () => {
  it("classifies authentication without copying the SDK message", () => {
    const secret = "sk-secret-in-error";
    const error = mapOpenAIError({
      code: "invalid_api_key",
      message: `bad key ${secret}`,
      requestID: "req_auth",
      status: 401,
    });
    expect(error).toMatchObject({
      code: "invalid_api_key",
      kind: "authentication",
      requestId: "req_auth",
      status: 401,
    });
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it.each([
    [429, "rate_limit"],
    [503, "server_error"],
    [400, "request_error"],
    [undefined, "network"],
  ] as const)("classifies status %s as %s", (status, category) => {
    expect(mapOpenAIError({ status })).toMatchObject({
      category,
      kind: "provider",
    });
  });
});

