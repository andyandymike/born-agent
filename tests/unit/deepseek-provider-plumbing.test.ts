import { describe, expect, it } from "vitest";

import { restoreWorkspaceResumeFingerprint } from "../../src/resume/workspace-resume-fingerprint.js";

describe("DeepSeek provider plumbing", () => {
  it("restores a persisted DeepSeek backend identity for exact resume checks", () => {
    const restored = restoreWorkspaceResumeFingerprint({
      backend: {
        adapter: "pi-ai",
        adapter_version: "0.80.7",
        config_fingerprint: "a".repeat(64),
        model: "deepseek-v4-flash",
        provider: "deepseek",
      },
      canonical_root_identity: "fixture-root",
      checkpoint_codec_version: "fixture-codec",
      completion_schema_sha256: "b".repeat(64),
      policy_sha256: "c".repeat(64),
      source_state: {
        git_head_sha256: "d".repeat(64),
        git_index_sha256: "e".repeat(64),
        source_state_sha256: "f".repeat(64),
      },
      system_instructions_sha256: "1".repeat(64),
      task_profile: "coding",
      tool_schema_sha256: "2".repeat(64),
    });

    expect(restored.backend).toMatchObject({
      model: "deepseek-v4-flash",
      provider: "deepseek",
    });
    expect(Object.isFrozen(restored.backend)).toBe(true);
  });
});
