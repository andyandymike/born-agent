import { describe, expect, it } from "vitest";

import {
  VerificationCommandClassifier,
  type ApprovedCommandForVerification,
  type RegistryVerificationClassification,
} from "../../src/verification/verification-command-classifier.js";

const approvedVerify: ApprovedCommandForVerification = {
  actionSha256: "a".repeat(64),
  approved: true,
  args: ["pnpm", "test"],
  cwd: ".",
  logicalExecutable: "corepack",
  purpose: "verify",
};

function classifier(
  value: RegistryVerificationClassification | null,
): VerificationCommandClassifier {
  return new VerificationCommandClassifier({
    async classify() {
      return value;
    },
  });
}

describe("Phase 7 verification command classifier", () => {
  it("accepts only an approved verify command with explicit registry inputs", async () => {
    const result = await classifier({
      inputPaths: ["package.json", "pnpm-lock.yaml", "vitest.config.ts"],
      kind: "test",
      packageScriptSha256: "b".repeat(64),
    }).classify(approvedVerify);

    expect(result).toEqual({
      eligible: true,
      inputPaths: ["package.json", "pnpm-lock.yaml", "vitest.config.ts"],
      kind: "test",
      packageScriptSha256: "b".repeat(64),
    });
  });

  it("does not infer verification from an inspect command or an unapproved action", async () => {
    const adapter = classifier({ inputPaths: ["package.json"], kind: "check" });
    await expect(
      adapter.classify({ ...approvedVerify, purpose: "inspect" }),
    ).resolves.toEqual({
      eligible: false,
      reason: "command_not_verify_purpose",
    });
    await expect(
      adapter.classify({ ...approvedVerify, approved: false }),
    ).resolves.toEqual({
      eligible: false,
      reason: "command_not_approved",
    });
  });

  it("fails closed for an unknown classification, manifest, or unsafe input path", async () => {
    await expect(classifier(null).classify(approvedVerify)).resolves.toEqual({
      eligible: false,
      reason: "command_not_classified",
    });
    await expect(
      classifier({ inputPaths: [], kind: "test" }).classify(approvedVerify),
    ).resolves.toEqual({
      eligible: false,
      reason: "verification_inputs_unknown",
    });
    await expect(
      classifier({ inputPaths: ["../package.json"], kind: "test" }).classify(
        approvedVerify,
      ),
    ).resolves.toEqual({
      eligible: false,
      reason: "verification_inputs_unknown",
    });
  });
});
