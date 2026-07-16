import { describe, expect, it } from "vitest";

import { redactSensitiveText } from "../../src/security/redact.js";

describe("redactSensitiveText", () => {
  it("removes exact, Bearer, Authorization, and sk-style secrets", () => {
    const exact = "custom-secret-value";
    const text = redactSensitiveText(
      `exact=${exact} Authorization: Bearer token-value-123 Bearer another-token-456 sk-exampletoken789`,
      [exact],
    );
    expect(text).not.toContain(exact);
    expect(text).not.toContain("token-value-123");
    expect(text).not.toContain("another-token-456");
    expect(text).not.toContain("sk-exampletoken789");
    expect(text).toContain("[redacted]");
  });
});
