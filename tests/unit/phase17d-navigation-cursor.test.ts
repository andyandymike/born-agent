import { describe, expect, it } from "vitest";

import {
  decodeNavigationCursor,
  decodeSymbolId,
  encodeNavigationCursor,
  navigationQuerySha256,
  symbolId,
} from "../../src/repository-intelligence/navigation-cursor.js";

const GENERATION = "a".repeat(64);
const QUERY = navigationQuerySha256({ limit: 1, query: "Session" });
const KEY = Buffer.alloc(32, 7);

describe("Phase 17D generation-bound opaque navigation identities", () => {
  it("round-trips only with the exact key, query, tool, and generation", () => {
    const token = encodeNavigationCursor({
      canonicalQuerySha256: QUERY,
      generationSha256: GENERATION,
      offset: 3,
      schemaVersion: 1,
      tool: "find_symbol",
    }, KEY);
    expect(decodeNavigationCursor(token, {
      canonicalQuerySha256: QUERY,
      generationSha256: GENERATION,
      tool: "find_symbol",
    }, KEY).offset).toBe(3);
    expect(() => decodeNavigationCursor(token, {
      canonicalQuerySha256: navigationQuerySha256({ limit: 2, query: "Session" }),
      generationSha256: GENERATION,
      tool: "find_symbol",
    }, KEY)).toThrow(/does not match/u);
    expect(() => decodeNavigationCursor(token, {
      canonicalQuerySha256: QUERY,
      generationSha256: GENERATION,
      tool: "find_references",
    }, KEY)).toThrow(/does not match/u);
    expect(() => decodeNavigationCursor(token, {
      canonicalQuerySha256: QUERY,
      generationSha256: "b".repeat(64),
      tool: "find_symbol",
    }, KEY)).toThrow(/old generation/u);
    expect(() => decodeNavigationCursor(token, {
      canonicalQuerySha256: QUERY,
      generationSha256: GENERATION,
      tool: "find_symbol",
    }, Buffer.alloc(32, 8))).toThrow(/strict validation/u);
  });

  it("rejects byte tampering and never rebinds an old symbol ID by name", () => {
    const token = encodeNavigationCursor({
      canonicalQuerySha256: QUERY,
      generationSha256: GENERATION,
      offset: 1,
      schemaVersion: 1,
      tool: "find_symbol",
    }, KEY);
    const index = token.length - 12;
    const tampered = `${token.slice(0, index)}${token[index] === "A" ? "B" : "A"}${token.slice(index + 1)}`;
    expect(() => decodeNavigationCursor(tampered, {
      canonicalQuerySha256: QUERY,
      generationSha256: GENERATION,
      tool: "find_symbol",
    }, KEY)).toThrow(/strict validation/u);

    const record = "c".repeat(64);
    const id = symbolId(GENERATION, record);
    expect(decodeSymbolId(id, GENERATION)).toBe(record);
    expect(() => decodeSymbolId(id, "b".repeat(64))).toThrow(/old generation/u);
    expect(() => decodeSymbolId(`sym_v1_${GENERATION.slice(0, 16)}_${"d".repeat(64)}`, GENERATION)).not.toThrow();
  });
});
