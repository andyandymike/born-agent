import { describe, expect, it } from "vitest";

import { CAPABILITY_PLATFORM_SCHEMA_SHA256 } from "../../src/capabilities/plugin-manifest-schema.js";
import { sha256Canonical } from "../../src/completion/canonical-json.js";
import {
  MODEL_QUALIFICATION_PROBE_SUITE_VERSION,
  MODEL_QUALIFICATION_PROBE_TOOL_SCHEMA_SHA256,
  QUALIFICATION_STEP_TOOL,
} from "../../src/model/model-qualification-suite.js";
import { REPOSITORY_NAVIGATION_MODEL_TOOL_DEFINITIONS } from "../../src/tools/repository-navigation-tool-contract.js";

describe("Phase 18A model qualification identity", () => {
  it("invalidates old evidence when the capability schema/policy identity changes", () => {
    expect(MODEL_QUALIFICATION_PROBE_SUITE_VERSION).toBe(
      "phase18a-capability-registry-v1",
    );
    expect(MODEL_QUALIFICATION_PROBE_TOOL_SCHEMA_SHA256).toBe(
      sha256Canonical({
        capabilityPlatformSchemaSha256: CAPABILITY_PLATFORM_SCHEMA_SHA256,
        repositoryNavigation: REPOSITORY_NAVIGATION_MODEL_TOOL_DEFINITIONS,
        step: QUALIFICATION_STEP_TOOL,
      }),
    );
    expect(MODEL_QUALIFICATION_PROBE_TOOL_SCHEMA_SHA256).not.toBe(
      sha256Canonical({
        repositoryNavigation: REPOSITORY_NAVIGATION_MODEL_TOOL_DEFINITIONS,
        step: QUALIFICATION_STEP_TOOL,
      }),
    );
  });
});
