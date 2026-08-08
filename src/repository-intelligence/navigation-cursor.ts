import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import { parseStrictJson } from "../system/strict-json.js";
import { RepositoryIntelligenceError } from "./repository-intelligence-error.js";
import type { NavigationIntegrityKey } from "./navigation-integrity-key.js";

const cursorPayloadSchema = z
  .object({
    canonicalQuerySha256: z.string().regex(/^[a-f0-9]{64}$/u),
    generationSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    offset: z.number().int().nonnegative().max(1_000_000),
    schemaVersion: z.literal(1),
    tool: z.enum(["repository_outline", "find_symbol", "find_references"]),
  })
  .strict();

export type NavigationCursorPayload = Readonly<z.infer<typeof cursorPayloadSchema>>;
export type NavigationToolName = NavigationCursorPayload["tool"];

function mac(payload: string, key: NavigationIntegrityKey): Buffer {
  if (key.byteLength !== 32) throw new TypeError("navigation integrity key must be 32 bytes");
  return createHmac("sha256", key).update(payload, "utf8").digest();
}

export function navigationQuerySha256(queryWithoutCursor: unknown): string {
  return sha256Canonical(queryWithoutCursor);
}

export function encodeNavigationCursor(payloadInput: NavigationCursorPayload, key: NavigationIntegrityKey): string {
  const payload = cursorPayloadSchema.parse(payloadInput);
  const payloadBytes = Buffer.from(canonicalJson(payload), "utf8");
  const signature = mac(payloadBytes.toString("base64url"), key);
  const token = `navcur_v1_${Buffer.concat([payloadBytes, signature]).toString("base64url")}`;
  if (token.length > 522) throw new RepositoryIntelligenceError("repository_cursor_invalid", "navigation cursor exceeds its hard bound", 2);
  return token;
}

export function decodeNavigationCursor(
  token: string,
  expected: { readonly canonicalQuerySha256: string; readonly generationSha256: string; readonly tool: NavigationToolName },
  key: NavigationIntegrityKey,
): NavigationCursorPayload {
  try {
    if (!/^navcur_v1_[A-Za-z0-9_-]{16,512}$/u.test(token)) throw new Error("cursor syntax invalid");
    const framed = Buffer.from(token.slice("navcur_v1_".length), "base64url");
    if (framed.byteLength <= 32) throw new Error("cursor framing invalid");
    const payloadBytes = framed.subarray(0, framed.byteLength - 32);
    const actualMac = framed.subarray(framed.byteLength - 32);
    const expectedMac = mac(payloadBytes.toString("base64url"), key);
    if (actualMac.byteLength !== expectedMac.byteLength || !timingSafeEqual(actualMac, expectedMac)) throw new Error("cursor integrity invalid");
    const payloadText = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
    const payload = cursorPayloadSchema.parse(parseStrictJson(payloadText));
    if (`${canonicalJson(payload)}` !== payloadText) throw new Error("cursor payload is not canonical");
    if (payload.generationSha256 !== expected.generationSha256) {
      throw new RepositoryIntelligenceError("repository_cursor_stale", "navigation cursor belongs to an old generation", 8);
    }
    if (payload.tool !== expected.tool || payload.canonicalQuerySha256 !== expected.canonicalQuerySha256) {
      throw new RepositoryIntelligenceError("repository_cursor_invalid", "navigation cursor does not match this query", 2);
    }
    return payload;
  } catch (error) {
    if (error instanceof RepositoryIntelligenceError) throw error;
    throw new RepositoryIntelligenceError("repository_cursor_invalid", "navigation cursor failed strict validation", 2, { cause: error });
  }
}

export function symbolId(generationSha256: string, recordId: string): string {
  if (!/^[a-f0-9]{64}$/u.test(generationSha256) || !/^[a-f0-9]{64}$/u.test(recordId)) throw new TypeError("symbol identity requires exact hashes");
  return `sym_v1_${generationSha256.slice(0, 16)}_${recordId}`;
}

export function decodeSymbolId(value: string, generationSha256: string): string {
  const match = /^sym_v1_([a-f0-9]{16})_([a-f0-9]{64})$/u.exec(value);
  if (match === null) throw new RepositoryIntelligenceError("repository_symbol_stale", "repository symbol ID is invalid", 8);
  // PHASE17: an old symbol ID never rebinds by name/path. The caller must issue find_symbol again.
  if (match[1] !== generationSha256.slice(0, 16)) throw new RepositoryIntelligenceError("repository_symbol_stale", "repository symbol belongs to an old generation", 8);
  return match[2]!;
}
