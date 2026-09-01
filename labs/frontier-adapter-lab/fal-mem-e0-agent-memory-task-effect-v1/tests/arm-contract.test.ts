import { describe, expect, it } from "vitest";

import {
  observeMemE0ArmContract,
  type MemE0ArmContractInput,
  type MemE0ArmContractObservation,
} from "../src/arm-contract.js";

type InputOverrides = Partial<Omit<MemE0ArmContractInput, "observation">>;

function successfulInput(
  inputOverrides: InputOverrides = {},
  observationOverrides: Partial<MemE0ArmContractObservation> = {},
): MemE0ArmContractInput {
  return {
    changedPathsExact: true,
    expectsSuccessfulEffect: true,
    hiddenVerifierPassed: true,
    observation: {
      agentExitCode: 0,
      approvalObservationSha256s: ["approval-edit", "approval-verify"],
      canonicalContextSha256s: ["context-1", "context-2", "context-3", "context-4"],
      decisionCounts: {
        emit_finish_task: 1,
        emit_patch: 1,
        emit_public_verifier: 1,
        emit_read_file: 1,
      },
      orchestrationFailure: false,
      toolArgumentSha256s: ["args-read", "args-patch", "args-verify", "args-finish"],
      toolNames: ["read_file", "apply_patch", "run_command", "finish_task"],
      ...observationOverrides,
    },
    publicVerifierPassed: true,
    workspaceUnchanged: false,
    ...inputOverrides,
  };
}

function memoryMissingInput(
  inputOverrides: InputOverrides = {},
  observationOverrides: Partial<MemE0ArmContractObservation> = {},
): MemE0ArmContractInput {
  return {
    changedPathsExact: false,
    expectsSuccessfulEffect: false,
    hiddenVerifierPassed: false,
    observation: {
      agentExitCode: 1,
      approvalObservationSha256s: [],
      canonicalContextSha256s: ["context-memory-missing"],
      decisionCounts: { fail_closed_memory_missing: 1 },
      orchestrationFailure: false,
      toolArgumentSha256s: [],
      toolNames: [],
      ...observationOverrides,
    },
    publicVerifierPassed: false,
    workspaceUnchanged: true,
    ...inputOverrides,
  };
}

describe("FAL MEM-E0 arm contract", () => {
  it("accepts the exact successful four-tool effect", () => {
    expect(observeMemE0ArmContract(successfulInput())).toBe(true);
  });

  it("rejects any incomplete or malformed successful effect", () => {
    expect(observeMemE0ArmContract(successfulInput({ publicVerifierPassed: false })))
      .toBe(false);
    expect(observeMemE0ArmContract(successfulInput({ hiddenVerifierPassed: false })))
      .toBe(false);
    expect(observeMemE0ArmContract(successfulInput({ changedPathsExact: false })))
      .toBe(false);
    expect(observeMemE0ArmContract(successfulInput({}, {
      toolNames: ["read_file", "run_command", "apply_patch", "finish_task"],
    }))).toBe(false);
    expect(observeMemE0ArmContract(successfulInput({}, {
      toolArgumentSha256s: ["args-read", "args-patch", "args-verify", "args-verify"],
    }))).toBe(false);
    expect(observeMemE0ArmContract(successfulInput({}, { agentExitCode: 1 })))
      .toBe(false);
    expect(observeMemE0ArmContract(successfulInput({}, { orchestrationFailure: true })))
      .toBe(false);
  });

  it("accepts the exact memory-missing fail-closed path when the workspace is unchanged", () => {
    expect(observeMemE0ArmContract(memoryMissingInput())).toBe(true);
  });

  it("rejects a crashed, effectful, mutated, or semantically wrong fail-closed path", () => {
    expect(observeMemE0ArmContract(memoryMissingInput({}, {
      orchestrationFailure: true,
    }))).toBe(false);
    expect(observeMemE0ArmContract(memoryMissingInput({}, {
      decisionCounts: { fail_closed_memory_missing: 2 },
    }))).toBe(false);
    expect(observeMemE0ArmContract(memoryMissingInput({}, {
      toolArgumentSha256s: ["args-read"],
      toolNames: ["read_file"],
    }))).toBe(false);
    expect(observeMemE0ArmContract(memoryMissingInput({}, {
      approvalObservationSha256s: ["unexpected-approval"],
    }))).toBe(false);
    expect(observeMemE0ArmContract(memoryMissingInput({ workspaceUnchanged: false })))
      .toBe(false);
    expect(observeMemE0ArmContract(memoryMissingInput({ hiddenVerifierPassed: true })))
      .toBe(false);
  });
});
