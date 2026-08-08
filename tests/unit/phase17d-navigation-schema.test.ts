import { describe, expect, it } from "vitest";

import {
  findReferencesQuerySchema,
  findSymbolQuerySchema,
  repositoryOutlineQuerySchema,
} from "../../src/repository-intelligence/navigation-query-schema.js";
import {
  findSymbolResultSchema,
  repositoryOutlineResultSchema,
} from "../../src/repository-intelligence/navigation-result-schema.js";

const SHA = "a".repeat(64);

function envelope() {
  return {
    confirmedAbsent: false,
    coverage: "partial" as const,
    engine: { id: "typescript-language-service", identitySha256: SHA },
    evidenceLevel: "semantic" as const,
    freshness: "current" as const,
    generationSha256: SHA,
    nextCursor: null,
    repositoryStatusSha256: SHA,
    result: [],
    ruleManifestSha256: SHA,
    schemaVersion: 1 as const,
    sourceStateSha256: SHA,
    truncated: false,
  };
}

describe("Phase 17D navigation schemas", () => {
  it("accepts only canonical bounded queries without duplicate filters", () => {
    expect(repositoryOutlineQuerySchema.parse({})).toEqual({ limit: 100, max_depth: 2 });
    expect(findSymbolQuerySchema.parse({ query: "Session" })).toMatchObject({ limit: 20, query: "Session" });
    expect(findReferencesQuerySchema.safeParse({ symbol_id: `sym_v1_${"b".repeat(16)}_${"c".repeat(64)}` }).success).toBe(true);
    for (const path of ["/absolute.ts", "C:/absolute.ts", "src\\a.ts", "src/../a.ts", "src//a.ts"]) {
      expect(repositoryOutlineQuerySchema.safeParse({ path }).success).toBe(false);
    }
    expect(findSymbolQuerySchema.safeParse({ query: "bad\u0000query" }).success).toBe(false);
    expect(findSymbolQuerySchema.safeParse({ kinds: ["class", "class"], query: "A" }).success).toBe(false);
    expect(findReferencesQuerySchema.safeParse({ relations: ["read", "read"], symbol_id: `sym_v1_${"b".repeat(16)}_${"c".repeat(64)}` }).success).toBe(false);
    expect(repositoryOutlineQuerySchema.safeParse({ extra: true }).success).toBe(false);
  });

  it("never upgrades a partial/unsupported empty result to confirmed absence", () => {
    expect(findSymbolResultSchema.parse(envelope()).confirmedAbsent).toBe(false);
    expect(findSymbolResultSchema.safeParse({ ...envelope(), confirmedAbsent: true }).success).toBe(false);
    expect(findSymbolResultSchema.safeParse({ ...envelope(), coverage: "unsupported", confirmedAbsent: true }).success).toBe(false);
    expect(repositoryOutlineResultSchema.safeParse({ ...envelope(), evidenceLevel: "syntactic", coverage: "complete", confirmedAbsent: true }).success).toBe(true);
  });

  it("binds truncation to a cursor and validates result paths/snippet identities", () => {
    expect(findSymbolResultSchema.safeParse({ ...envelope(), truncated: true }).success).toBe(false);
    const candidate = {
      applicableRuleScopeSha256: SHA,
      evidenceLevel: "semantic" as const,
      exported: true,
      kind: "class" as const,
      name: "Session",
      qualifiedName: "Session",
      range: { endByte: 7, endColumnUtf16: 8, endLine: 1, startByte: 0, startColumnUtf16: 1, startLine: 1 },
      relativePath: "../outside.ts",
      snippet: { bytes: 7, endLine: 1, sourceSha256: SHA, startLine: 1, text: "Session", trust: "untrusted_repository_content" as const },
      sourceSha256: SHA,
      symbolId: `sym_v1_${"b".repeat(16)}_${"c".repeat(64)}`,
    };
    expect(findSymbolResultSchema.safeParse({ ...envelope(), result: [candidate] }).success).toBe(false);
    expect(findSymbolResultSchema.safeParse({
      ...envelope(),
      result: [{ ...candidate, relativePath: "src/session.ts", snippet: { ...candidate.snippet, bytes: 6 } }],
    }).success).toBe(false);
    expect(findSymbolResultSchema.safeParse({
      ...envelope(),
      result: [{ ...candidate, relativePath: "src/session.ts", snippet: { ...candidate.snippet, sourceSha256: "d".repeat(64) } }],
    }).success).toBe(false);
  });
});
