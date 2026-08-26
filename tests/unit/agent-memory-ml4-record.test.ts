import { describe, expect, it } from "vitest";

import type { Ml1MemoryScopeV1 } from "../../src/memory/core/ml1-episode-record.js";
import {
  createExplicitMemoryRecordV1,
  decodeMemoryRecordV1,
  encodeMemoryRecordV1,
  memoryRecordRevisionId,
  memoryRecordSourceReferenceSha256,
} from "../../src/memory/core/memory-record-v1.js";

const scope: Ml1MemoryScopeV1 = Object.freeze({
  applicationRepositoryId: "00000000-0000-4000-8000-000000000401",
  canonicalRootIdentitySha256: "4".repeat(64),
  ownerPrincipalId: "local_owner",
});

describe("Agent memory ML4 formal record", () => {
  it("builds strict stable explicit revisions without rewriting the logical record identity", () => {
    const first = createExplicitMemoryRecordV1({
      commandId: "00000000-0000-4000-8000-000000000402",
      kind: "preference",
      occurredAt: "2026-08-26T04:00:00.000Z",
      revision: 1,
      scope,
      supersedesRevisionId: null,
      text: "  Prefer pnpm for this repository.\r\nKeep commands explicit.  ",
    });
    expect(first.text).toBe("Prefer pnpm for this repository.\nKeep commands explicit.");
    expect(first.recordId).toMatch(/^memory_[a-f0-9]{64}$/u);
    expect(first.revisionId).toMatch(/^revision_[a-f0-9]{64}$/u);
    expect(decodeMemoryRecordV1(encodeMemoryRecordV1(first))).toEqual(first);

    const second = createExplicitMemoryRecordV1({
      commandId: "00000000-0000-4000-8000-000000000403",
      kind: first.kind,
      occurredAt: "2026-08-26T04:01:00.000Z",
      recordId: first.recordId,
      revision: 2,
      scope,
      supersedesRevisionId: first.revisionId,
      text: "Prefer pnpm and run the focused check first.",
    });
    expect(second.recordId).toBe(first.recordId);
    expect(second.revisionId).not.toBe(first.revisionId);
    expect(second.recordSha256).not.toBe(first.recordSha256);
    expect(memoryRecordRevisionId(second)).toBe(second.revisionId);
    expect(memoryRecordSourceReferenceSha256(second)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails strict decoding for tampered revision linkage or record hashes", () => {
    const record = createExplicitMemoryRecordV1({
      commandId: "00000000-0000-4000-8000-000000000404",
      kind: "decision",
      occurredAt: "2026-08-26T04:02:00.000Z",
      revision: 1,
      scope,
      supersedesRevisionId: null,
      text: "Keep memory repository scoped.",
    });
    const tampered = Buffer.from(JSON.stringify({ ...record, text: "tampered" }), "utf8");
    expect(() => decodeMemoryRecordV1(tampered)).toThrowError(
      expect.objectContaining({ code: "memory_store_corrupt" }),
    );
    expect(() => createExplicitMemoryRecordV1({
      commandId: "00000000-0000-4000-8000-000000000405",
      kind: "decision",
      occurredAt: "2026-08-26T04:03:00.000Z",
      recordId: record.recordId,
      revision: 2,
      scope,
      supersedesRevisionId: null,
      text: "Invalid unlinked revision.",
    })).toThrow();
  });
});
