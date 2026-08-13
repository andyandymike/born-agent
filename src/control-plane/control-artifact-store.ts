import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import { ApplicationControlError } from "./application-errors.js";
import {
  artifactReferenceV1Schema,
  resourceScopeSha256,
  resourceScopeV1Schema,
  type ArtifactReferenceV1,
  type ResourceScopeV1,
} from "./application-protocol.js";
import type { ControlStatePaths } from "./control-state-paths.js";
import {
  createPrivateFileIfAbsent,
  createPrivateJsonIfAbsent,
  isMissing,
  readBoundedPrivateJson,
} from "./durable-control-file.js";

const MAX_CONTROL_ARTIFACT_BYTES = 1024 * 1024;

const artifactRecordSchema = z.object({
  artifactId: z.string().uuid(),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  bytes: z.number().int().nonnegative().max(MAX_CONTROL_ARTIFACT_BYTES),
  createdByOperationId: z.string().uuid().nullable(),
  mediaType: z.string().min(1).max(128),
  recordSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  resourceScope: resourceScopeV1Schema,
  schemaVersion: z.literal(1),
  transportVisibility: z.enum(["resource_authorized", "host_internal", "sealed_one_use"]),
}).strict().superRefine((value, context) => {
  const { recordSha256, ...content } = value;
  if (sha256Canonical(content) !== recordSha256) {
    context.addIssue({ code: "custom", message: "control artifact record hash mismatch" });
  }
});

export type ControlArtifactRecordV1 = Readonly<z.infer<typeof artifactRecordSchema>>;

function referenceMac(
  key: Uint8Array,
  record: ControlArtifactRecordV1,
  disclosureProfileSha256: string,
): string {
  if (key.byteLength !== 32 || !/^[a-f0-9]{64}$/u.test(disclosureProfileSha256)) {
    throw new TypeError("artifact reference MAC inputs are invalid");
  }
  const digest = createHmac("sha256", key).update(canonicalJson({
    artifact_id: record.artifactId,
    disclosure_profile_sha256: disclosureProfileSha256,
    resource_scope_sha256: resourceScopeSha256(record.resourceScope),
    schema_version: 1,
  }), "utf8").digest("base64url");
  return `artref_v1_${digest}`;
}

export class ControlArtifactStore {
  constructor(
    private readonly paths: ControlStatePaths,
    private readonly integrityKey: Uint8Array,
  ) {
    if (integrityKey.byteLength !== 32) throw new TypeError("control artifact integrity key must be 32 bytes");
  }

  async storeJson(input: {
    readonly artifactId?: string;
    readonly createdByOperationId: string | null;
    readonly resourceScope: ResourceScopeV1;
    readonly transportVisibility: ControlArtifactRecordV1["transportVisibility"];
    readonly value: unknown;
  }): Promise<ControlArtifactRecordV1> {
    return this.storeBytes({
      ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
      bytes: Buffer.from(canonicalJson(input.value), "utf8"),
      createdByOperationId: input.createdByOperationId,
      mediaType: "application/json",
      resourceScope: input.resourceScope,
      transportVisibility: input.transportVisibility,
    });
  }

  async storeBytes(input: {
    readonly artifactId?: string;
    readonly bytes: Uint8Array;
    readonly createdByOperationId: string | null;
    readonly mediaType: string;
    readonly resourceScope: ResourceScopeV1;
    readonly transportVisibility: ControlArtifactRecordV1["transportVisibility"];
  }): Promise<ControlArtifactRecordV1> {
    if (input.bytes.byteLength > MAX_CONTROL_ARTIFACT_BYTES) {
      throw new ApplicationControlError("control_artifact_invalid", "control artifact exceeds its hard byte bound");
    }
    const artifactId = input.artifactId ?? randomUUID();
    const artifactSha256 = createHash("sha256").update(input.bytes).digest("hex");
    const objectPath = join(this.paths.artifactObjects, `${artifactSha256}.bin`);
    const createResult = await createPrivateFileIfAbsent({ bytes: input.bytes, paths: this.paths, target: objectPath });
    if (createResult === "exists") {
      const existing = await readFile(objectPath);
      if (!existing.equals(Buffer.from(input.bytes))) {
        throw new ApplicationControlError("control_artifact_invalid", "artifact object hash collision or corruption detected");
      }
    }
    const content = {
      artifactId,
      artifactSha256,
      bytes: input.bytes.byteLength,
      createdByOperationId: input.createdByOperationId,
      mediaType: input.mediaType,
      resourceScope: resourceScopeV1Schema.parse(input.resourceScope),
      schemaVersion: 1 as const,
      transportVisibility: input.transportVisibility,
    };
    const record = artifactRecordSchema.parse({ ...content, recordSha256: sha256Canonical(content) });
    const recordPath = join(this.paths.artifactRecords, `${artifactId}.json`);
    const outcome = await createPrivateJsonIfAbsent({ paths: this.paths, target: recordPath, value: record });
    if (outcome === "exists") {
      const existing = await this.readRecord(artifactId);
      if (existing.recordSha256 !== record.recordSha256) {
        throw new ApplicationControlError("control_artifact_invalid", "artifact ID is already bound to different bytes");
      }
      return existing;
    }
    return Object.freeze(record);
  }

  async readRecord(artifactId: string): Promise<ControlArtifactRecordV1> {
    if (!z.string().uuid().safeParse(artifactId).success) {
      throw new ApplicationControlError("control_artifact_invalid", "artifact ID is invalid");
    }
    try {
      return Object.freeze(artifactRecordSchema.parse(
        await readBoundedPrivateJson(join(this.paths.artifactRecords, `${artifactId}.json`), 16 * 1024),
      ));
    } catch (error) {
      if (isMissing(error) || isMissing((error as ErrorOptions).cause)) {
        throw new ApplicationControlError("control_artifact_invalid", "artifact is unavailable");
      }
      if (error instanceof ApplicationControlError) throw error;
      throw new ApplicationControlError("control_artifact_invalid", "artifact record is corrupt", { cause: error });
    }
  }

  async listRecords(): Promise<readonly ControlArtifactRecordV1[]> {
    const names = (await readdir(this.paths.artifactRecords))
      .filter((name) => /^[0-9a-f-]{36}\.json$/u.test(name))
      .sort();
    if (names.length > 10_000) {
      throw new ApplicationControlError("control_artifact_invalid", "control artifact registry exceeds its hard bound");
    }
    return Object.freeze(await Promise.all(names.map((name) => this.readRecord(name.slice(0, -5)))));
  }

  async readVerified(input: {
    readonly artifactId: string;
    readonly expectedResourceScope: ResourceScopeV1;
    readonly maximumBytes: number;
  }): Promise<{ readonly bytes: Buffer; readonly record: ControlArtifactRecordV1 }> {
    const record = await this.readRecord(input.artifactId);
    if (resourceScopeSha256(record.resourceScope) !== resourceScopeSha256(input.expectedResourceScope)) {
      throw new ApplicationControlError("control_artifact_forbidden", "artifact is outside the authorized resource scope");
    }
    if (record.bytes > input.maximumBytes) {
      throw new ApplicationControlError("control_artifact_invalid", "artifact exceeds the caller byte bound");
    }
    const objectPath = join(this.paths.artifactObjects, `${record.artifactSha256}.bin`);
    const metadata = await lstat(objectPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== record.bytes) {
      throw new ApplicationControlError("control_artifact_invalid", "artifact object identity is invalid");
    }
    const bytes = await readFile(objectPath);
    if (createHash("sha256").update(bytes).digest("hex") !== record.artifactSha256) {
      throw new ApplicationControlError("control_artifact_invalid", "artifact content hash mismatch");
    }
    return Object.freeze({ bytes, record });
  }

  reference(input: {
    readonly disclosure: "opaque" | "content_authorized";
    readonly disclosureProfileSha256: string;
    readonly record: ControlArtifactRecordV1;
  }): ArtifactReferenceV1 {
    const base = {
      artifactId: input.record.artifactId,
      createdByOperationId: input.record.createdByOperationId,
      owner: "host_artifact_store" as const,
      resourceScope: input.record.resourceScope,
      schemaVersion: 1 as const,
      transportVisibility: input.record.transportVisibility,
    };
    if (input.disclosure === "content_authorized") {
      return Object.freeze(artifactReferenceV1Schema.parse({
        ...base,
        artifactSha256: input.record.artifactSha256,
        bytes: input.record.bytes,
        mediaType: input.record.mediaType,
        metadataDisclosure: "content_authorized",
        scopedIntegrityToken: null,
      }));
    }
    return Object.freeze(artifactReferenceV1Schema.parse({
      ...base,
      artifactSha256: null,
      bytes: null,
      mediaType: null,
      metadataDisclosure: "opaque",
      scopedIntegrityToken: referenceMac(this.integrityKey, input.record, input.disclosureProfileSha256),
    }));
  }

  verifyOpaqueReference(input: {
    readonly disclosureProfileSha256: string;
    readonly reference: ArtifactReferenceV1;
    readonly record: ControlArtifactRecordV1;
  }): boolean {
    if (input.reference.metadataDisclosure !== "opaque") return false;
    const expected = Buffer.from(referenceMac(this.integrityKey, input.record, input.disclosureProfileSha256));
    const actual = Buffer.from(input.reference.scopedIntegrityToken);
    return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
  }
}
