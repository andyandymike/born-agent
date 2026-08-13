import { randomUUID } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
import { lstat, realpath } from "node:fs/promises";

import { z } from "zod";
import { parseStrictJson } from "../system/strict-json.js";

import { sha256Canonical } from "../completion/canonical-json.js";
import { ApplicationControlError } from "./application-errors.js";
import {
  artifactReferenceV1Schema,
  type HostControlIdentityV1,
  type ResourceScopeV1,
} from "./application-protocol.js";
import { CatalogJournal, type CatalogHeadV1, type CatalogRecordV1 } from "./catalog-journal.js";
import type { ControlArtifactStore } from "./control-artifact-store.js";
import type { ControlStatePaths } from "./control-state-paths.js";

const registrationSchema = z.object({
  canonicalRootIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  controllerId: z.string().uuid(),
  createdOperationId: z.string().uuid(),
  ownerOnlyRootLocatorArtifact: artifactReferenceV1Schema,
  registrationSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  repositoryId: z.string().uuid(),
  status: z.enum(["active", "unavailable", "retired"]),
}).strict().superRefine((value, context) => {
  const { registrationSha256, ...content } = value;
  if (sha256Canonical(content) !== registrationSha256) {
    context.addIssue({ code: "custom", message: "repository registration hash mismatch" });
  }
  if (value.ownerOnlyRootLocatorArtifact.transportVisibility !== "host_internal") {
    context.addIssue({ code: "custom", message: "repository root locator must remain host-internal" });
  }
});

export type RepositoryRegistrationV1 = Readonly<z.infer<typeof registrationSchema>>;

export interface PublicRepositoryViewV1 {
  readonly canonicalRootIdentitySha256: string;
  readonly label: string;
  readonly repositoryId: string;
  readonly status: RepositoryRegistrationV1["status"];
}

export interface RepositoryRootPreviewV1 {
  readonly canonicalRoot: string;
  readonly canonicalRootIdentitySha256: string;
}

export interface PublicRepositoryCatalogSnapshotV1 {
  readonly head: CatalogHeadV1;
  readonly repositories: readonly PublicRepositoryViewV1[];
}

function platformPath(value: string): string {
  const normalized = value.normalize("NFC");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export class RepositoryRegistry {
  readonly resourceScope: Extract<ResourceScopeV1, { readonly kind: "repository_catalog" }>;
  private readonly journalPromise: Promise<CatalogJournal>;

  constructor(
    private readonly artifacts: ControlArtifactStore,
    private readonly identity: HostControlIdentityV1,
    private readonly paths: ControlStatePaths,
  ) {
    this.resourceScope = Object.freeze({ kind: "repository_catalog", controllerId: identity.controllerId });
    this.journalPromise = CatalogJournal.create({
      directory: paths.repositoryRoot,
      paths,
      resourceScope: this.resourceScope,
    });
  }

  async head(): Promise<CatalogHeadV1> {
    return (await this.journalPromise).readHead();
  }

  async list(): Promise<readonly RepositoryRegistrationV1[]> {
    return Object.freeze((await this.registrationsWithRecords()).map((entry) => entry.registration));
  }

  async publicSnapshot(): Promise<PublicRepositoryCatalogSnapshotV1> {
    const journal = await this.journalPromise;
    const snapshot = await journal.readSnapshot();
    const registrations = this.projectRegistrations(snapshot.records);
    const repositories = await Promise.all(registrations.map(async ({ registration }) => {
      const locator = await this.readRoot(registration);
      return Object.freeze({
        canonicalRootIdentitySha256: registration.canonicalRootIdentitySha256,
        label: basename(locator),
        repositoryId: registration.repositoryId,
        status: registration.status,
      });
    }));
    return Object.freeze({ head: snapshot.head, repositories: Object.freeze(repositories) });
  }

  private async registrationsWithRecords(): Promise<readonly {
    readonly record: CatalogRecordV1;
    readonly registration: RepositoryRegistrationV1;
  }[]> {
    const records = await (await this.journalPromise).readRecords();
    return this.projectRegistrations(records);
  }

  /**
   * PHASE21: observe the exact repository registration owned by one
   * application operation. This never appends or treats a same-root record
   * from another operation as recovery evidence.
   */
  async findByCreatedOperation(operationId: string): Promise<Readonly<{
    readonly catalogRecord: CatalogRecordV1;
    readonly head: CatalogHeadV1;
    readonly registration: RepositoryRegistrationV1;
  }> | null> {
    const snapshot = await (await this.journalPromise).readSnapshot();
    const matches = this.projectRegistrations(snapshot.records).filter(
      (entry) => entry.registration.createdOperationId === operationId,
    );
    if (matches.length > 1) {
      throw new ApplicationControlError("control_catalog_corrupt", "repository operation has more than one registration");
    }
    const match = matches[0];
    return match === undefined
      ? null
      : Object.freeze({ catalogRecord: match.record, head: snapshot.head, registration: match.registration });
  }

  private projectRegistrations(records: readonly CatalogRecordV1[]): readonly {
    readonly record: CatalogRecordV1;
    readonly registration: RepositoryRegistrationV1;
  }[] {
    const current = new Map<string, { readonly record: CatalogRecordV1; readonly registration: RepositoryRegistrationV1 }>();
    for (const record of records) {
      if (record.kind !== "repository.registered") {
        throw new ApplicationControlError("control_catalog_corrupt", "repository catalog contains an unknown record kind");
      }
      let registration: RepositoryRegistrationV1;
      try {
        registration = registrationSchema.parse(record.payload);
      } catch (error) {
        throw new ApplicationControlError("control_catalog_corrupt", "repository registration is invalid", { cause: error });
      }
      current.set(registration.repositoryId, Object.freeze({ record, registration: Object.freeze(registration) }));
    }
    return Object.freeze([...current.values()]);
  }

  async get(repositoryId: string): Promise<RepositoryRegistrationV1 | null> {
    return (await this.list()).find((entry) => entry.repositoryId === repositoryId) ?? null;
  }

  async publicView(repositoryId: string): Promise<PublicRepositoryViewV1 | null> {
    const registration = await this.get(repositoryId);
    if (registration === null) return null;
    const locator = await this.readRoot(registration);
    return Object.freeze({
      canonicalRootIdentitySha256: registration.canonicalRootIdentitySha256,
      label: basename(locator),
      repositoryId,
      status: registration.status,
    });
  }

  async previewRoot(root: string): Promise<RepositoryRootPreviewV1> {
    if (!isAbsolute(root)) {
      throw new ApplicationControlError("control_target_invalid", "repository root must be absolute");
    }
    const requested = resolve(root);
    const metadata = await lstat(requested);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new ApplicationControlError("control_target_invalid", "repository root must be a real directory");
    }
    const canonicalRoot = await realpath(requested);
    return Object.freeze({
      canonicalRoot,
      canonicalRootIdentitySha256: sha256Canonical({
        dev: metadata.dev,
        ino: metadata.ino,
        real_path: platformPath(canonicalRoot),
        schema_version: 1,
      }),
    });
  }

  async register(input: {
    readonly expectedHead: CatalogHeadV1;
    readonly operationId: string;
    readonly root: string;
  }): Promise<{
    readonly catalogRecord: CatalogRecordV1 | null;
    readonly created: boolean;
    readonly head: CatalogHeadV1;
    readonly registration: RepositoryRegistrationV1;
  }> {
    const { canonicalRoot, canonicalRootIdentitySha256 } = await this.previewRoot(input.root);
    const journal = await this.journalPromise;
    const snapshot = await journal.readSnapshot();
    const registrations = this.projectRegistrations(snapshot.records);
    const recovered = registrations.find((entry) => entry.registration.createdOperationId === input.operationId);
    if (recovered !== undefined) {
      if (recovered.registration.canonicalRootIdentitySha256 !== canonicalRootIdentitySha256) {
        throw new ApplicationControlError(
          "control_catalog_corrupt",
          "repository operation is bound to another canonical root identity",
        );
      }
      return Object.freeze({
        catalogRecord: recovered.record,
        created: true,
        head: snapshot.head,
        registration: recovered.registration,
      });
    }
    if (
      input.expectedHead.resourceScope.kind !== "repository_catalog" ||
      input.expectedHead.resourceScope.controllerId !== this.resourceScope.controllerId ||
      input.expectedHead.revision !== snapshot.head.revision ||
      input.expectedHead.catalogSha256 !== snapshot.head.catalogSha256 ||
      input.expectedHead.lastRecordId !== snapshot.head.lastRecordId ||
      input.expectedHead.lastRecordSha256 !== snapshot.head.lastRecordSha256
    ) {
      throw new ApplicationControlError("control_catalog_conflict", "repository catalog compare-and-swap failed");
    }
    const existing = registrations.find(
      (entry) => entry.registration.status === "active" && entry.registration.canonicalRootIdentitySha256 === canonicalRootIdentitySha256,
    );
    if (existing !== undefined) {
      return Object.freeze({ catalogRecord: null, created: false, head: snapshot.head, registration: existing.registration });
    }
    const repositoryId = randomUUID();
    const rootArtifact = await this.artifacts.storeJson({
      createdByOperationId: input.operationId,
      resourceScope: { kind: "repository", repositoryId, teamId: null },
      transportVisibility: "host_internal",
      value: { canonicalRoot },
    });
    const rootReference = this.artifacts.reference({
      disclosure: "content_authorized",
      disclosureProfileSha256: "0".repeat(64),
      record: rootArtifact,
    });
    const content = {
      canonicalRootIdentitySha256,
      controllerId: this.identity.controllerId,
      createdOperationId: input.operationId,
      ownerOnlyRootLocatorArtifact: rootReference,
      repositoryId,
      status: "active" as const,
    };
    const registration = Object.freeze(registrationSchema.parse({
      ...content,
      registrationSha256: sha256Canonical(content),
    }));
    const committed = await journal.append({
      expectedHead: input.expectedHead,
      kind: "repository.registered",
      payload: registration,
    });
    return Object.freeze({ catalogRecord: committed.record, created: true, head: committed.head, registration });
  }

  async readRoot(registration: RepositoryRegistrationV1): Promise<string> {
    const artifact = await this.artifacts.readVerified({
      artifactId: registration.ownerOnlyRootLocatorArtifact.artifactId,
      expectedResourceScope: { kind: "repository", repositoryId: registration.repositoryId, teamId: null },
      maximumBytes: 16 * 1024,
    });
    let value: unknown;
    try {
      value = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(artifact.bytes));
    } catch (error) {
      throw new ApplicationControlError("control_catalog_corrupt", "repository root locator is invalid", { cause: error });
    }
    const parsed = z.object({ canonicalRoot: z.string().min(1).max(4096) }).strict().parse(value);
    return parsed.canonicalRoot;
  }
}
