import { describe, expect, it } from "vitest";

import { buildChildEnvironmentPolicy } from "../../src/delegation/context/child-environment-policy.js";
import { buildChildToolProfile } from "../../src/delegation/context/child-tool-profile.js";
import { phase20Content } from "../phase20-test-helpers.js";

const catalog = ["apply_patch", "finish_task", "read_file", "search", "propose_delegation"].map((id) => ({
  id,
  schemaSha256: "b".repeat(64),
  effectClass: id === "apply_patch" ? "patch" as const : id === "propose_delegation" ? "delegate" as const : "read" as const,
}));

describe("Phase 20B minimal child envelope boundaries", () => {
  it("builds an exact deterministic tool profile", () => {
    const request = phase20Content().authorityRequest;
    const profile = buildChildToolProfile({
      taskProfile: "read-only",
      requestedToolIds: request.toolIds,
      policyToolIds: catalog.map((entry) => entry.id),
      parentDelegableToolIds: catalog.map((entry) => entry.id),
      catalog,
    });
    expect(profile.toolIds).toEqual(["read_file", "search"]);
    expect(profile.profileId).toBe("delegated_read_only_v1");
    expect(profile.hardDeniedToolIds).toContain("propose_delegation");
  });

  it("physically rejects delegation aliases and sensitive environment inheritance", () => {
    expect(() => buildChildToolProfile({
      taskProfile: "read-only",
      requestedToolIds: ["propose_delegation"],
      policyToolIds: catalog.map((entry) => entry.id),
      parentDelegableToolIds: catalog.map((entry) => entry.id),
      catalog,
    })).toThrow(/hard-denied/u);
    expect(() => buildChildEnvironmentPolicy({ requestedVariableNames: ["OPENAI_API_KEY"] })).toThrow(/not allowed/u);
    const safe = buildChildEnvironmentPolicy({ requestedVariableNames: ["LANG", "NO_COLOR"] });
    expect(safe.allowedVariableNames).toEqual(["LANG", "NO_COLOR"]);
    expect(safe.deniedCategories).toContain("credentials");
  });
});
