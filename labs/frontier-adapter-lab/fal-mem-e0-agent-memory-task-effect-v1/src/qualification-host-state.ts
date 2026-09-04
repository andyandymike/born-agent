import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { reconstructArtifactSessionLedger } from "../../../../src/artifacts/artifact-session-ledger.js";
import { MAX_ARTIFACT_CAPTURE_BYTES } from "../../../../src/artifacts/artifact-types.js";
import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { readStoredSession } from "../../../../src/sessions/read-stored-session.js";
import { parseStrictJson } from "../../../../src/system/strict-json.js";

const SESSION_FILE = /^\.bornagent\/sessions\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/u;
const NAVIGATION_KEYS = Object.freeze([
  ".bornagent/cache/repository-intelligence/navigation-integrity.key",
  ".bornagent/cache/repository-intelligence/v1/navigation-integrity.key",
]);
const artifactMetadataSchema = z.object({
  bytes: z.number().int().min(0).max(MAX_ARTIFACT_CAPTURE_BYTES),
  schema_version: z.literal(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

const rawSha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

export function memE0QualificationSessionSpanSha256(events: readonly Readonly<{
  readonly data: unknown;
  readonly eventId: string;
  readonly runId: string;
  readonly type: string;
}>[]): string {
  return sha256Canonical(events.map((event) => ({
    dataSha256: sha256Canonical(event.data),
    eventIdSha256: rawSha256(event.eventId),
    runIdSha256: rawSha256(event.runId),
    type: event.type,
  })));
}

export interface MemE0QualificationHostState {
  /** Ephemeral parent-only paths, never copied to the public receipt. */
  readonly filePaths: readonly string[];
  readonly valid: boolean;
}

/**
 * Product execution writes Host state under .bornagent. This is not a blanket
 * exclusion: only the actor-bound V2 journal, its authorized content-addressed
 * artifact pairs, and the two exact navigation keys are accepted. The parent
 * still checks every other file against the frozen public workspace/DS0 record.
 */
export async function inspectMemE0QualificationHostState(input: Readonly<{
  readonly expectedSessionEventSpanSha256: string;
  readonly files: readonly string[];
  readonly workspace: string;
}>): Promise<MemE0QualificationHostState> {
  try {
    const sessionFiles = input.files.filter((path) => SESSION_FILE.test(path));
    if (sessionFiles.length !== 1) throw new Error("qualification requires one Host journal");
    const sessionPath = sessionFiles[0]!;
    const sessionId = SESSION_FILE.exec(sessionPath)![1]!;
    const events = await readStoredSession(join(input.workspace, sessionPath));
    if (events.length === 0 || events.some((event) =>
      event.sourceSchemaVersion !== 2 || event.sessionId !== sessionId)) {
      throw new Error("qualification Host journal identity drifted");
    }
    const runs = events.filter((event) => event.scope === "run");
    if (new Set(runs.map((event) => event.runId)).size !== 1 ||
      memE0QualificationSessionSpanSha256(runs) !== input.expectedSessionEventSpanSha256) {
      throw new Error("qualification Host journal does not match the actor observation");
    }
    const ledger = reconstructArtifactSessionLedger(events, sessionId);
    if (ledger.orphanedReferenceCount !== 0) throw new Error("qualification has orphaned artifacts");
    const accepted = new Set<string>([sessionPath]);
    for (const object of ledger.objects) {
      if (object.authorizedReferenceCount === 0 ||
        object.objectRef !== `artifacts/${sessionId}/objects/${object.sha256}`) {
        throw new Error("qualification artifact is not owned by this Host journal");
      }
      const path = `.bornagent/${object.objectRef}`;
      const metadataPath = `${path}.meta.json`;
      const objectStat = await lstat(join(input.workspace, path));
      const metadataStat = await lstat(join(input.workspace, metadataPath));
      if (!objectStat.isFile() || objectStat.isSymbolicLink() || objectStat.size > MAX_ARTIFACT_CAPTURE_BYTES ||
        !metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.size > 1_024) {
        throw new Error("qualification artifact file is invalid");
      }
      const bytes = await readFile(join(input.workspace, path));
      const metadata = artifactMetadataSchema.parse(parseStrictJson(
        await readFile(join(input.workspace, metadataPath), "utf8"),
      ));
      if (rawSha256(bytes) !== object.sha256 || bytes.byteLength !== object.bytes ||
        metadata.sha256 !== object.sha256 || metadata.bytes !== object.bytes) {
        throw new Error("qualification artifact integrity drifted");
      }
      accepted.add(path);
      accepted.add(metadataPath);
    }
    // The current product creates a legacy key and its V2 migrated copy. Bind
    // both exact locations and bytes; never print or export the key material.
    const keys = await Promise.all(NAVIGATION_KEYS.map(async (path) => {
      const metadata = await lstat(join(input.workspace, path));
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== 32) {
        throw new Error("qualification navigation key is invalid");
      }
      const bytes = await readFile(join(input.workspace, path));
      if (bytes.byteLength !== 32) throw new Error("qualification navigation key changed");
      accepted.add(path);
      return bytes;
    }));
    if (!keys[0]!.equals(keys[1]!)) throw new Error("qualification navigation key migration drifted");
    if ([...accepted].some((path) => !input.files.includes(path))) {
      throw new Error("qualification Host file was not in the parent manifest");
    }
    return Object.freeze({ filePaths: Object.freeze([...accepted].sort()), valid: true });
  } catch {
    return Object.freeze({ filePaths: Object.freeze([]), valid: false });
  }
}
