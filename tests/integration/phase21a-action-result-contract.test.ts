import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  delegationPrepareCompositeResultCodec,
  delegationStartCompositeResultCodec,
  graphRunCompositeResultCodec,
  worktreeCleanupCompositeResultCodec,
} from "../../src/control-plane/use-cases/action-result-codecs.js";

describe("Phase 21A action-kind-bound result contracts", () => {
  it("does not accept a valid worktree result as a Graph run result", () => {
    const cleanup = {
      archiveSha256: null,
      status: "removed" as const,
      workspaceId: randomUUID(),
    };
    expect(worktreeCleanupCompositeResultCodec.decodeStrict(cleanup)).toEqual(cleanup);
    expect(() => graphRunCompositeResultCodec.decodeStrict(cleanup)).toThrow(/strict schema validation/u);
  });

  it("does not accept a valid Delegation start terminal as a prepare result", () => {
    const terminal = {
      deferred: [],
      groupId: randomUUID(),
      kind: "group_terminal" as const,
      results: [{
        childRunId: randomUUID(),
        delegationId: randomUUID(),
        receiptSha256: "a".repeat(64),
        status: "succeeded" as const,
      }],
      terminalStatus: "completed" as const,
    };
    expect(delegationStartCompositeResultCodec.decodeStrict(terminal)).toEqual(terminal);
    expect(() => delegationPrepareCompositeResultCodec.decodeStrict(terminal)).toThrow(/strict schema validation/u);
  });
});
