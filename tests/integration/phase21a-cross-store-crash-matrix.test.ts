import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJson, sha256Canonical } from "../../src/completion/canonical-json.js";
import {
  ApplicationActionRegistry,
  type ApplicationActionDefinitionV1,
  type ApplicationActionExecutionResultV1,
} from "../../src/control-plane/application-action-registry.js";
import { ApplicationControlError } from "../../src/control-plane/application-errors.js";
import {
  createStrictCodec,
  type AuthenticatedCallContextV1,
  type PreparedActionV1,
} from "../../src/control-plane/application-protocol.js";
import { DefaultAgentRunApplicationService } from "../../src/control-plane/application-service.js";
import { createNodeApplicationHostRuntime } from "../../src/control-plane/application-host-runtime.js";
import { CatalogJournal, type CatalogRecordV1 } from "../../src/control-plane/catalog-journal.js";
import { ControlArtifactStore } from "../../src/control-plane/control-artifact-store.js";
import {
  controlIdempotencyKeySha256,
  ControlOperationJournal,
} from "../../src/control-plane/control-operation-journal.js";
import { SessionDeliveryCoordinator } from "../../src/control-plane/delivery-cursor.js";
import { loadOrCreateHostControlAuthority } from "../../src/control-plane/host-control-identity.js";
import { LocalOwnerPrincipalAuthority } from "../../src/control-plane/local-owner-principal.js";
import { PreparedActionStore } from "../../src/control-plane/prepared-action-store.js";

const temporary: string[] = [];
const payloadSchema = z.object({ label: z.string().min(1).max(64) }).strict();
const resultSchema = z.object({ label: z.string().min(1).max(64), operationId: z.string().uuid() }).strict();

type OwnerMode = "complete" | "no_record" | "partial";

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function recordReference(record: CatalogRecordV1) {
  return Object.freeze({
    ledgerId: "phase21a:fault-owner",
    ownerKind: "catalog" as const,
    recordId: record.recordId,
    recordSha256: record.recordSha256,
    sequence: record.revision,
  });
}

async function fixture(input: Readonly<{
  readonly effectClass?: ApplicationActionDefinitionV1["effectClass"];
  readonly mode?: OwnerMode;
}> = {}) {
  const authority = await loadOrCreateHostControlAuthority({
    root: await directory("bornagent-phase21a-prefix-state-"),
  });
  const artifacts = new ControlArtifactStore(authority.paths, authority.integrityKey);
  const faultScope = Object.freeze({
    controllerId: authority.identity.controllerId,
    kind: "repository_catalog" as const,
  });
  const owner = await CatalogJournal.create({
    directory: join(authority.paths.catalogRoot, "fault-owner"),
    paths: authority.paths,
    resourceScope: faultScope,
  });
  const counters = { execute: 0, reconcile: 0 };
  const resultFor = (
    record: CatalogRecordV1,
    label: string,
  ): ApplicationActionExecutionResultV1 => Object.freeze({
    domainRecordRefs: Object.freeze([recordReference(record)]),
    primaryDomainRecord: recordReference(record),
    resolvedResourceScope: owner.resourceScope,
    resolvedResourceVersion: Object.freeze({
      kind: "revision" as const,
      revision: record.revision,
      sha256: record.catalogSha256,
    }),
    result: Object.freeze({ label, operationId: (record.payload as { operation_id: string }).operation_id }),
    underlyingOperationRefs: Object.freeze([]),
  });
  const findComplete = async (operationId: string): Promise<CatalogRecordV1 | null> =>
    (await owner.readRecords()).find((record) =>
      record.kind === "fault.completed" &&
      typeof record.payload === "object" &&
      record.payload !== null &&
      "operation_id" in record.payload &&
      record.payload.operation_id === operationId
    ) ?? null;
  const definition: ApplicationActionDefinitionV1<z.infer<typeof payloadSchema>> = {
    actionKind: "fault.owner.apply",
    confirmation: "none",
    display: (_resolved, payload) => ({ summary: `Apply ${payload.label}.`, warnings: [] }),
    effectClass: input.effectClass ?? "runtime_effect",
    execute: async (context, payload) => {
      counters.execute += 1;
      const recovered = await findComplete(context.operationId);
      if (recovered !== null) return resultFor(recovered, payload.label);
      if ((input.mode ?? "complete") === "no_record") {
        throw new Error("injected dispatch response loss before owner record");
      }
      const head = await owner.readHead();
      const appended = await owner.append({
        expectedHead: head,
        kind: (input.mode ?? "complete") === "partial" ? "fault.partial" : "fault.completed",
        payload: Object.freeze({ label: payload.label, operation_id: context.operationId }),
      });
      if ((input.mode ?? "complete") === "partial") {
        throw new Error("injected response loss after a partial owner record");
      }
      return resultFor(appended.record, payload.label);
    },
    payloadCodec: createStrictCodec({
      maximumBytes: 1024,
      schema: payloadSchema,
      schemaId: "phase21a.fault-owner.payload.v1",
    }),
    resultCodec: createStrictCodec({
      maximumBytes: 1024,
      schema: resultSchema,
      schemaId: "phase21a.fault-owner.result.v1",
    }),
    reconcile: async (context, payload) => {
      counters.reconcile += 1;
      const complete = await findComplete(context.operationId);
      return complete === null ? null : resultFor(complete, payload.label);
    },
    requiredPrincipalKind: "human",
    requiredScopes: ["repository.register"],
    resolveTarget: async (target, payload) => {
      if (target.kind !== "new_repository") {
        throw new ApplicationControlError("control_target_invalid", "fault owner requires a catalog target");
      }
      const head = await owner.readHead();
      if (
        target.expectedCatalogVersion.kind !== "revision" ||
        target.expectedCatalogVersion.revision !== head.revision ||
        target.expectedCatalogVersion.sha256 !== head.catalogSha256
      ) {
        throw new ApplicationControlError("control_stale_projection", "fault owner catalog head changed");
      }
      const targetIdentity = Object.freeze({
        catalog_sha256: head.catalogSha256,
        label: payload.label,
        revision: head.revision,
        schema_version: 1,
      });
      return Object.freeze({
        resourceScope: owner.resourceScope,
        resourceVersion: Object.freeze({
          kind: "revision" as const,
          revision: head.revision,
          sha256: head.catalogSha256,
        }),
        targetIdentity,
        targetIdentitySha256: sha256Canonical(targetIdentity),
      });
    },
    targetContracts: [{
      acceptedExpectedVersionKinds: ["revision"],
      resourceKinds: ["repository_catalog"],
      targetKind: "new_repository",
    }],
    zeroHeadPolicy: "not_applicable",
  };
  const journal = new ControlOperationJournal(authority.paths);
  const preparedActions = new PreparedActionStore(authority.integrityKey, authority.paths);
  const principalAuthority = new LocalOwnerPrincipalAuthority(
    authority.localOwner,
    authority.localOwnerScopes,
  );
  const createService = (
    serviceJournal = new ControlOperationJournal(authority.paths),
  ) => new DefaultAgentRunApplicationService({
    actions: new ApplicationActionRegistry([definition]),
    artifacts,
    createRequestId: randomUUID,
    delivery: new SessionDeliveryCoordinator(),
    hostRuntime: createNodeApplicationHostRuntime(),
    journal: serviceJournal,
    preparedActions,
    principalAuthority,
  });
  const context: AuthenticatedCallContextV1 = Object.freeze({
    principal: authority.localOwner,
    surface: Object.freeze({ clientId: randomUUID(), connectionId: randomUUID(), surface: "cli" as const }),
  });
  const prepare = async (key = "prepare", label = "prefix") => {
    const head = await owner.readHead();
    return createService().prepare(context, {
      actionKind: definition.actionKind,
      payload: { label },
      payloadSha256: sha256Canonical({ label }),
      prepareIdempotencyKey: key,
      requestId: randomUUID(),
      schemaVersion: 1,
      target: {
        catalogScope: faultScope,
        expectedCatalogVersion: { kind: "revision", revision: head.revision, sha256: head.catalogSha256 },
        kind: "new_repository",
      },
    });
  };
  const accept = async (prepared: PreparedActionV1, idempotencyKey = "K1") => journal.accept({
    actionKind: prepared.actionKind,
    idempotencyKey,
    idempotencyNamespace: `application.commit.${authority.localOwner.principalId}`,
    preparedActionId: prepared.preparedActionId,
    preparedActionSha256: prepared.preparedActionSha256,
    requestIdentitySha256: sha256Canonical({
      action_kind: prepared.actionKind,
      idempotency_key: idempotencyKey,
      prepared_action_sha256: prepared.preparedActionSha256,
      principal_id: authority.localOwner.principalId,
      schema_version: 1,
      target: prepared.target,
    }),
    target: prepared.target,
  });
  const commit = (
    prepared: PreparedActionV1,
    idempotencyKey = "K1",
    service = createService(),
  ) => service.commit(context, {
    idempotencyKey,
    preparedActionId: prepared.preparedActionId,
    preparedActionSha256: prepared.preparedActionSha256,
    requestId: randomUUID(),
    schemaVersion: 1,
  });
  return {
    accept,
    artifacts,
    authority,
    commit,
    context,
    counters,
    createService,
    definition,
    journal,
    owner,
    prepare,
  };
}

function exactPrepared(envelope: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["prepare"]>>): PreparedActionV1 {
  if (envelope.status !== "ok" || envelope.result === null) throw new Error("fault fixture prepare failed");
  return envelope.result.prepared;
}

/**
 * Cross-file coverage note: prefix 8 is exercised by
 * phase21a-crash-prefix-recovery.test.ts and prefix 9 by
 * phase21a-run-cancel-cross-process.test.ts. This suite injects the remaining
 * control/owner/result-store boundaries from spec 21A section 9.4.
 */
describe("Phase 21A cross-store 13-prefix crash matrix", () => {
  it("[1,2] replays a persisted prepare after response/process loss before commit", async () => {
    const value = await fixture();
    const first = exactPrepared(await value.prepare("lost-prepare-response"));
    expect(await value.journal.list()).toHaveLength(0);

    const replay = exactPrepared(await value.prepare("lost-prepare-response"));
    expect(replay).toEqual(first);
    expect(await readdir(value.authority.paths.prepareRoot)).toHaveLength(1);

    const committed = await value.commit(replay, "K1", value.createService());
    expect(committed.status).toBe("ok");
    expect(value.counters.execute).toBe(1);
    expect(await value.journal.list()).toHaveLength(1);
  });

  it("[3,4] recovers accepted authority after both lagging indexes are lost", async () => {
    const value = await fixture();
    const prepared = exactPrepared(await value.prepare("accepted-no-index"));
    const accepted = await value.accept(prepared);
    const preparedIndex = join(
      value.authority.paths.operationRoot,
      "indexes",
      "prepared",
      `${sha256Canonical(prepared.preparedActionId)}.json`,
    );
    const idempotencyIndex = join(
      value.authority.paths.operationRoot,
      "indexes",
      "idempotency",
      `${controlIdempotencyKeySha256("application.commit.local_owner", "K1")}.json`,
    );
    await Promise.all([unlink(preparedIndex), unlink(idempotencyIndex)]);

    const committed = await value.commit(prepared);
    expect(committed).toMatchObject({ operationId: accepted.operation.operationId, status: "ok" });
    expect(value.counters.execute).toBe(1);
    expect(await value.journal.list()).toHaveLength(1);
    await access(preparedIndex);
    await expect(value.journal.accept({
      actionKind: prepared.actionKind,
      idempotencyKey: "K1",
      idempotencyNamespace: "application.commit.local_owner",
      preparedActionId: randomUUID(),
      preparedActionSha256: "b".repeat(64),
      requestIdentitySha256: "c".repeat(64),
      target: prepared.target,
    })).rejects.toMatchObject({ code: "control_idempotency_conflict" });
    await access(idempotencyIndex);
    expect(await value.journal.list()).toHaveLength(1);
  });

  it("[5] fresh-validates a reserved takeover and performs zero stale owner dispatch", async () => {
    const value = await fixture();
    const prepared = exactPrepared(await value.prepare("reserved-stale"));
    const accepted = await value.accept(prepared);
    const acquired = await value.journal.acquireDriver(accepted.operation.operationId);
    if (acquired.kind !== "acquired") throw new Error("expected crash-prefix driver");
    await value.journal.updateClaimed({ claim: acquired.claim, patch: { state: "authority_validated" } });
    await value.journal.updateClaimed({ claim: acquired.claim, patch: { state: "reserved" } });
    await value.journal.releaseDriver(acquired.claim);
    const head = await value.owner.readHead();
    await value.owner.append({ expectedHead: head, kind: "fault.unrelated", payload: { reason: "stale target" } });

    const rejected = await value.commit(prepared);
    expect(rejected).toMatchObject({ error: { code: "control_stale_projection" }, status: "rejected" });
    const replay = await value.commit(prepared, "K2", value.createService());
    expect(replay).toMatchObject({ error: { code: "control_stale_projection" }, status: "rejected" });
    expect(value.counters).toEqual({ execute: 0, reconcile: 0 });
    expect((await value.journal.read(accepted.operation.operationId))?.state).toBe("blocked_stale");
    expect((await value.owner.readRecords()).filter((record) => record.kind === "fault.completed")).toHaveLength(0);
  });

  it.each([
    ["no canonical owner record", "no_record"],
    ["one partial composite owner record", "partial"],
  ] as const)("[6,7,10] blocks unknown after %s without a second dispatch", async (_label, mode) => {
    const value = await fixture({ effectClass: "external_effect", mode });
    const prepared = exactPrepared(await value.prepare(`unknown-${mode}`));

    const first = await value.commit(prepared, "K1");
    expect(first.status).toBe("rejected");
    const replay = await value.commit(prepared, "K2");
    expect(replay).toMatchObject({ error: { code: "control_operation_busy" }, status: "rejected" });
    expect(value.counters.execute).toBe(1);
    expect((await value.journal.list())[0]?.state).toBe("blocked_unknown_effect");
    const records = await value.owner.readRecords();
    expect(records.filter((record) => record.kind === "fault.completed")).toHaveLength(0);
    expect(records.filter((record) => record.kind === "fault.partial")).toHaveLength(mode === "partial" ? 1 : 0);
  });

  it("[11] reconciles complete owner facts after result-store failure without re-execute", async () => {
    const value = await fixture();
    const prepared = exactPrepared(await value.prepare("result-store-loss"));
    const storeJson = value.artifacts.storeJson.bind(value.artifacts);
    let failResultStore = true;
    vi.spyOn(value.artifacts, "storeJson").mockImplementation(async (input) => {
      if (failResultStore && input.createdByOperationId !== null && input.transportVisibility === "resource_authorized") {
        failResultStore = false;
        throw new Error("injected result artifact store failure");
      }
      return storeJson(input);
    });

    const first = await value.commit(prepared, "K1");
    expect(first.status).toBe("rejected");
    expect((await value.journal.list())[0]).toMatchObject({
      ownerClaim: null,
      resultArtifact: null,
      state: "domain_records_linked",
    });

    const recovered = await value.commit(prepared, "K2", value.createService());
    expect(recovered.status).toBe("ok");
    expect(value.counters).toEqual({ execute: 1, reconcile: 1 });
    expect((await value.owner.readRecords()).filter((record) => record.kind === "fault.completed")).toHaveLength(1);
  });

  it("[12,13] finishes a linked persisted result and replays exact K2 after response loss", async () => {
    const value = await fixture();
    const prepared = exactPrepared(await value.prepare("linked-result", "linked-result"));
    const serviceJournal = new ControlOperationJournal(value.authority.paths);
    const updateClaimed = serviceJournal.updateClaimed.bind(serviceJournal);
    let failResultPublish = true;
    vi.spyOn(serviceJournal, "updateClaimed").mockImplementation(async (input) => {
      if (failResultPublish && input.patch.state === "result_built") {
        failResultPublish = false;
        throw new Error("injected loss after result artifact fsync");
      }
      return updateClaimed(input);
    });

    const lostResponse = await value.commit(prepared, "K1", value.createService(serviceJournal));
    expect(lostResponse.status).toBe("rejected");
    const linked = (await value.journal.list())[0]!;
    expect(linked).toMatchObject({ ownerClaim: null, resultArtifact: null, state: "domain_records_linked" });
    const persistedBeforeState = (await value.artifacts.listRecords()).filter(
      (record) => record.createdByOperationId === linked.operationId,
    );
    expect(persistedBeforeState).toHaveLength(1);
    expect(persistedBeforeState[0]?.artifactId).toBe(linked.operationId);

    const firstResponse = await value.commit(prepared, "K2");
    const result = Object.freeze({ label: "linked-result", operationId: linked.operationId });
    expect(firstResponse).toMatchObject({ operationId: linked.operationId, result, status: "ok" });
    const responseLossReplay = await value.commit(prepared, "K3", value.createService());
    expect(responseLossReplay).toMatchObject({
      operationId: linked.operationId,
      result,
      status: "ok",
    });
    expect(responseLossReplay.result).toEqual(firstResponse.result);
    expect(value.counters).toEqual({ execute: 1, reconcile: 1 });
    expect((await value.artifacts.listRecords()).filter(
      (record) => record.createdByOperationId === linked.operationId,
    )).toHaveLength(1);
    expect(await value.journal.list()).toHaveLength(1);
  });

  it("rejects a hash-consistent but schema-malformed completed artifact after response loss", async () => {
    const value = await fixture();
    const prepared = exactPrepared(await value.prepare("malformed-result-replay", "strict-result"));
    const first = await value.commit(prepared, "K1");
    expect(first.status).toBe("ok");
    const operationId = first.operationId!;
    const record = await value.artifacts.readRecord(operationId);
    const bytes = Buffer.from(canonicalJson({ label: null, operationId }), "utf8");
    const artifactSha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(value.authority.paths.artifactObjects, `${artifactSha256}.bin`), bytes);
    const content = {
      artifactId: record.artifactId,
      artifactSha256,
      bytes: bytes.byteLength,
      createdByOperationId: record.createdByOperationId,
      mediaType: record.mediaType,
      resourceScope: record.resourceScope,
      schemaVersion: 1 as const,
      transportVisibility: record.transportVisibility,
    };
    await writeFile(
      join(value.authority.paths.artifactRecords, `${operationId}.json`),
      `${canonicalJson({ ...content, recordSha256: sha256Canonical(content) })}\n`,
      "utf8",
    );

    const replay = await value.commit(prepared, "K2", value.createService());
    expect(replay).toMatchObject({
      error: { code: "control_operation_corrupt" },
      result: null,
      status: "rejected",
    });
    expect(value.counters.execute).toBe(1);
  });
});
