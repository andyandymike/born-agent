import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";
import { ApplicationControlError } from "./application-errors.js";
import { resourceScopeSha256, resourceScopeV1Schema, type ResourceScopeV1 } from "./application-protocol.js";
import { withControlFileLock } from "./control-file-lock.js";
import type { ControlStatePaths } from "./control-state-paths.js";
import { createPrivateJsonIfAbsent, readBoundedPrivateJson } from "./durable-control-file.js";

const recordSchema = z.object({
  catalogSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  kind: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/u),
  payload: z.unknown(),
  previousCatalogSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  previousRecordSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  recordId: z.string().uuid(),
  recordSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  resourceScope: resourceScopeV1Schema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  schemaVersion: z.literal(1),
}).strict().superRefine((value, context) => {
  const { catalogSha256, recordSha256, ...content } = value;
  const actualRecord = sha256Canonical(content);
  if (actualRecord !== recordSha256) {
    context.addIssue({ code: "custom", message: "catalog record hash mismatch" });
  }
  if (sha256Canonical({
    previous_catalog_sha256: value.previousCatalogSha256,
    record_sha256: actualRecord,
    revision: value.revision,
    schema_version: 1,
  }) !== catalogSha256) {
    context.addIssue({ code: "custom", message: "catalog chain hash mismatch" });
  }
});

export interface CatalogHeadV1 {
  readonly catalogSha256: string;
  readonly lastRecordId: string | null;
  readonly lastRecordSha256: string | null;
  readonly resourceScope: ResourceScopeV1;
  readonly revision: number;
  readonly schemaVersion: 1;
}

export type CatalogRecordV1 = Readonly<z.infer<typeof recordSchema>>;

export interface CatalogSnapshotV1 {
  readonly head: CatalogHeadV1;
  readonly records: readonly CatalogRecordV1[];
}

function emptyCatalogSha256(scope: ResourceScopeV1): string {
  return sha256Canonical({
    records: [],
    resource_scope: scope,
    schema_version: 1,
  });
}

function revisionName(revision: number): string {
  return `${String(revision).padStart(12, "0")}.json`;
}

export class CatalogJournal {
  private constructor(
    private readonly directory: string,
    private readonly paths: ControlStatePaths,
    readonly resourceScope: ResourceScopeV1,
  ) {}

  static async create(input: {
    readonly directory: string;
    readonly paths: ControlStatePaths;
    readonly resourceScope: ResourceScopeV1;
  }): Promise<CatalogJournal> {
    await mkdir(input.directory, { mode: 0o700, recursive: true });
    const metadata = await lstat(input.directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new ApplicationControlError("control_catalog_corrupt", "catalog path is not a real directory");
    }
    await input.paths.assertSafe(join(input.directory, ".catalog-probe"));
    return new CatalogJournal(input.directory, input.paths, resourceScopeV1Schema.parse(input.resourceScope));
  }

  emptyHead(): CatalogHeadV1 {
    return Object.freeze({
      catalogSha256: emptyCatalogSha256(this.resourceScope),
      lastRecordId: null,
      lastRecordSha256: null,
      resourceScope: this.resourceScope,
      revision: 0,
      schemaVersion: 1,
    });
  }

  async readRecords(): Promise<readonly CatalogRecordV1[]> {
    const names = (await readdir(this.directory)).filter((name) => /^[0-9]{12}\.json$/u.test(name)).sort();
    if (names.length > 50_000) {
      throw new ApplicationControlError("control_catalog_corrupt", "catalog exceeds its hard record bound");
    }
    const records: CatalogRecordV1[] = [];
    let previousHead = this.emptyHead();
    for (let index = 0; index < names.length; index += 1) {
      const expectedRevision = index + 1;
      if (names[index] !== revisionName(expectedRevision)) {
        throw new ApplicationControlError("control_catalog_corrupt", "catalog revisions are not contiguous");
      }
      let record: CatalogRecordV1;
      try {
        record = recordSchema.parse(await readBoundedPrivateJson(join(this.directory, names[index]!), 1024 * 1024));
      } catch (error) {
        throw new ApplicationControlError("control_catalog_corrupt", "catalog record is corrupt", { cause: error });
      }
      if (
        record.revision !== expectedRevision ||
        resourceScopeSha256(record.resourceScope) !== resourceScopeSha256(this.resourceScope) ||
        record.previousCatalogSha256 !== previousHead.catalogSha256 ||
        record.previousRecordSha256 !== previousHead.lastRecordSha256
      ) {
        throw new ApplicationControlError("control_catalog_corrupt", "catalog record chain is inconsistent");
      }
      records.push(Object.freeze(record));
      previousHead = this.headFromRecord(record);
    }
    return Object.freeze(records);
  }

  async readHead(): Promise<CatalogHeadV1> {
    const last = (await this.readRecords()).at(-1);
    return last === undefined ? this.emptyHead() : this.headFromRecord(last);
  }

  /**
   * PHASE21: queries bind content and version to one immutable journal scan.
   * Reading records and then re-reading the head would permit an intervening
   * append to label old content with a newer catalog identity.
   */
  async readSnapshot(): Promise<CatalogSnapshotV1> {
    const records = await this.readRecords();
    const last = records.at(-1);
    return Object.freeze({
      head: last === undefined ? this.emptyHead() : this.headFromRecord(last),
      records,
    });
  }

  async append(input: {
    readonly expectedHead: CatalogHeadV1;
    readonly kind: string;
    readonly payload: unknown;
    readonly recordId?: string;
  }): Promise<{ readonly head: CatalogHeadV1; readonly record: CatalogRecordV1 }> {
    const lockKey = sha256Canonical({ kind: "catalog", resource_scope: this.resourceScope });
    return withControlFileLock({ keySha256: lockKey, paths: this.paths }, async () => {
      const current = await this.readHead();
      if (
        input.expectedHead.revision !== current.revision ||
        input.expectedHead.catalogSha256 !== current.catalogSha256 ||
        resourceScopeSha256(input.expectedHead.resourceScope) !== resourceScopeSha256(current.resourceScope)
      ) {
        throw new ApplicationControlError("control_catalog_conflict", "catalog compare-and-swap lost ownership");
      }
      const content = {
        kind: input.kind,
        payload: input.payload,
        previousCatalogSha256: current.catalogSha256,
        previousRecordSha256: current.lastRecordSha256,
        recordId: input.recordId ?? randomUUID(),
        resourceScope: this.resourceScope,
        revision: current.revision + 1,
        schemaVersion: 1 as const,
      };
      const recordSha256 = sha256Canonical(content);
      const record = recordSchema.parse({
        ...content,
        catalogSha256: sha256Canonical({
          previous_catalog_sha256: current.catalogSha256,
          record_sha256: recordSha256,
          revision: current.revision + 1,
          schema_version: 1,
        }),
        recordSha256,
      });
      const result = await createPrivateJsonIfAbsent({
        paths: this.paths,
        target: join(this.directory, revisionName(record.revision)),
        value: record,
      });
      if (result !== "created") {
        throw new ApplicationControlError("control_catalog_conflict", "catalog revision already exists");
      }
      const committed = (await this.readRecords()).at(-1);
      if (committed?.recordSha256 !== record.recordSha256) {
        throw new ApplicationControlError("control_catalog_corrupt", "catalog append readback mismatch");
      }
      return Object.freeze({ head: this.headFromRecord(committed), record: committed });
    });
  }

  private headFromRecord(record: CatalogRecordV1): CatalogHeadV1 {
    return Object.freeze({
      catalogSha256: record.catalogSha256,
      lastRecordId: record.recordId,
      lastRecordSha256: record.recordSha256,
      resourceScope: this.resourceScope,
      revision: record.revision,
      schemaVersion: 1,
    });
  }
}
