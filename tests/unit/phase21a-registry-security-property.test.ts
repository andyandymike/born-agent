import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Canonical } from "../../src/completion/canonical-json.js";
import { actionDisplayArtifactV1Schema } from "../../src/control-plane/action-display-builder.js";
import { ApplicationControlError, type ApplicationControlErrorCode } from "../../src/control-plane/application-errors.js";
import {
  applicationActionTargetV1Schema,
  applicationQueryRequestV1Schema,
  artifactReferenceV1Schema,
  assertWireArtifactReference,
  createPreparedAction,
  decodeStrictJsonBytes,
  preparedActionV1Schema,
  type ApplicationActionTargetV1,
  type ApplicationQueryRequestV1,
  type ArtifactReferenceV1,
} from "../../src/control-plane/application-protocol.js";
import { createPhase21ALocalControlPlane } from "../../src/control-plane/local-control-plane.js";

const temporary: string[] = [];
const SECRET = "phase21a-secret-sentinel-DO-NOT-DISCLOSE-9374";

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function fixture() {
  return createPhase21ALocalControlPlane({
    launcher: {
      launch: async () => {
        throw new Error("negative registry tests must never launch a run");
      },
    },
    stateRoot: await directory("bornagent-phase21a-registry-security-"),
  });
}

function expectControlCode(run: () => unknown, code: ApplicationControlErrorCode): void {
  let observed: unknown;
  try {
    run();
  } catch (error) {
    observed = error;
  }
  expect(observed).toBeInstanceOf(ApplicationControlError);
  expect((observed as ApplicationControlError).code).toBe(code);
}

function zeroHead(sessionId: string) {
  return Object.freeze({
    eventId: null,
    eventIntegrityToken: null,
    schemaVersion: 1 as const,
    sequence: 0,
    sessionId,
  });
}

describe("Phase 21A registry security properties", () => {
  it("hard-denies unknown actions and every unregistered action target/version combination before effects", async () => {
    const plane = await fixture();
    const context = plane.context("cli");
    const repositoryHead = await plane.repositories.head();
    const repositoryTarget: ApplicationActionTargetV1 = {
      catalogScope: plane.repositories.resourceScope,
      expectedCatalogVersion: {
        kind: "revision",
        revision: repositoryHead.revision,
        sha256: repositoryHead.catalogSha256,
      },
      kind: "new_repository",
    };
    const unknownPayload = { sentinel: SECRET };
    const unknown = await plane.actions.prepare(context, {
      actionKind: "workspace.raw_mutation",
      payload: unknownPayload,
      payloadSha256: sha256Canonical(unknownPayload),
      prepareIdempotencyKey: "unknown-action",
      requestId: randomUUID(),
      schemaVersion: 1,
      target: repositoryTarget,
    });
    expect(unknown).toMatchObject({ status: "rejected", error: { code: "control_unknown_action" } });

    const repositoryId = randomUUID();
    const sessionId = randomUUID();
    const sessionScope = { kind: "session" as const, repositoryId, sessionId, teamId: null };
    const invalidTargets: readonly Readonly<{
      actionKind: "goal.propose" | "session.create";
      expectedCode: ApplicationControlErrorCode;
      target: ApplicationActionTargetV1;
    }>[] = [
      {
        actionKind: "goal.propose",
        expectedCode: "control_target_invalid",
        target: {
        expectedVersion: { kind: "revision", revision: 0, sha256: "a".repeat(64) },
        kind: "existing_resource",
        resourceScope: sessionScope,
        },
      },
      {
        actionKind: "session.create",
        expectedCode: "control_payload_invalid",
        target: {
          catalogScope: { kind: "session_catalog", repositoryId, teamId: null },
          expectedCatalogVersion: { generation: 0, kind: "controller_generation", sha256: "b".repeat(64) },
          kind: "new_session",
        } as unknown as ApplicationActionTargetV1,
      },
    ];
    for (const [index, candidate] of invalidTargets.entries()) {
      const response = await plane.actions.prepare(context, {
        actionKind: candidate.actionKind,
        payload: {},
        payloadSha256: sha256Canonical({}),
        prepareIdempotencyKey: `invalid-target-${String(index)}`,
        requestId: randomUUID(),
        schemaVersion: 1,
        target: candidate.target,
      });
      expect(response.status).toBe("rejected");
      expect(response.error?.code, `invalid target index ${String(index)}: ${JSON.stringify(response.error)}`).toBe(
        candidate.expectedCode,
      );
    }

    const zeroHeadDenied = await plane.actions.prepare(context, {
      actionKind: "goal.propose",
      payload: {},
      payloadSha256: sha256Canonical({}),
      prepareIdempotencyKey: "zero-head-denied",
      requestId: randomUUID(),
      schemaVersion: 1,
      target: {
        expectedVersion: { head: zeroHead(sessionId), kind: "session_ledger_head" },
        kind: "existing_resource",
        resourceScope: sessionScope,
      },
    });
    expect(zeroHeadDenied).toMatchObject({ status: "rejected", error: { code: "control_session_not_started" } });
    expect(await plane.operations.list()).toHaveLength(0);
    expect(await plane.repositories.list()).toHaveLength(0);
  });

  it("hard-denies unknown queries, resource/version mismatches, and current-version pagination", async () => {
    const plane = await fixture();
    const context = plane.context("tui");
    const controllerScope = plane.repositories.resourceScope;
    const base = {
      atVersion: null,
      pageCursor: null,
      payload: {},
      requestId: randomUUID(),
      resourceScope: controllerScope,
      schemaVersion: 1 as const,
    };
    const unknown = await plane.queries.query(context, { ...base, queryKind: "workspace.raw_read" });
    expect(unknown).toMatchObject({ status: "rejected", error: { code: "control_query_unknown" } });

    const repositoryId = randomUUID();
    const sessionId = randomUUID();
    const wrongResource = await plane.queries.query(context, {
      ...base,
      queryKind: "session.view",
    });
    expect(wrongResource).toMatchObject({ status: "rejected", error: { code: "control_target_invalid" } });

    const wrongVersion = await plane.queries.query(context, {
      ...base,
      atVersion: { kind: "revision", revision: 0, sha256: "c".repeat(64) },
      queryKind: "session.view",
      resourceScope: { kind: "session", repositoryId, sessionId, teamId: null },
    });
    expect(wrongVersion).toMatchObject({ status: "rejected", error: { code: "control_target_invalid" } });

    const currentPage = await plane.queries.query(context, {
      ...base,
      pageCursor: {
        cursorAuthenticator: `pg_v1_${"A".repeat(43)}`,
        cursorId: randomUUID(),
        schemaVersion: 1,
      },
      queryKind: "repository.list",
    });
    expect(currentPage).toMatchObject({ status: "rejected", error: { code: "control_stale_projection" } });
  });

  it("rejects invalid UTF-8, duplicate JSON keys, and caller-supplied trusted fields", () => {
    const request: ApplicationQueryRequestV1 = {
      atVersion: null,
      pageCursor: null,
      payload: {},
      queryKind: "repository.list",
      requestId: randomUUID(),
      resourceScope: { controllerId: randomUUID(), kind: "repository_catalog" },
      schemaVersion: 1,
    };
    expectControlCode(
      () => decodeStrictJsonBytes(Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]), applicationQueryRequestV1Schema, 8 * 1024),
      "control_payload_invalid",
    );
    expectControlCode(
      () => decodeStrictJsonBytes(
        Buffer.from(JSON.stringify(request).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'), "utf8"),
        applicationQueryRequestV1Schema,
        8 * 1024,
      ),
      "control_payload_invalid",
    );
    for (const trusted of [
      { principal: { principalId: "local_owner" } },
      { grantSha256: "d".repeat(64) },
      { surface: { surface: "cli" } },
    ]) {
      expectControlCode(
        () => decodeStrictJsonBytes(
          Buffer.from(JSON.stringify({ ...request, ...trusted }), "utf8"),
          applicationQueryRequestV1Schema,
          8 * 1024,
        ),
        "control_payload_invalid",
      );
    }
  });

  it("rejects raw/path/object references and host-internal artifact references at the wire boundary", () => {
    const repositoryId = randomUUID();
    const resourceScope = { kind: "repository" as const, repositoryId, teamId: null };
    const reference: ArtifactReferenceV1 = artifactReferenceV1Schema.parse({
      artifactId: randomUUID(),
      artifactSha256: "e".repeat(64),
      bytes: 2,
      createdByOperationId: null,
      mediaType: "application/json",
      metadataDisclosure: "content_authorized",
      owner: "host_artifact_store",
      resourceScope,
      schemaVersion: 1,
      scopedIntegrityToken: null,
      transportVisibility: "resource_authorized",
    });
    for (const untrusted of [
      { absolutePath: `C:\\${SECRET}` },
      { objectRef: { path: SECRET } },
      { rawEventSha256: "f".repeat(64) },
    ]) {
      expect(() => artifactReferenceV1Schema.parse({ ...reference, ...untrusted })).toThrow();
      expect(() => applicationActionTargetV1Schema.parse({
        expectedVersion: { kind: "revision", revision: 1, sha256: "1".repeat(64) },
        kind: "existing_resource",
        resourceScope,
        ...untrusted,
      })).toThrow();
    }
    const internal = artifactReferenceV1Schema.parse({ ...reference, transportVisibility: "host_internal" });
    expectControlCode(() => assertWireArtifactReference(internal), "control_artifact_forbidden");
  });

  it("binds display and target bytes so tampering cannot preserve a prepared action identity", () => {
    const controllerId = randomUUID();
    const target: ApplicationActionTargetV1 = {
      catalogScope: { controllerId, kind: "repository_catalog" },
      expectedCatalogVersion: { kind: "revision", revision: 0, sha256: "2".repeat(64) },
      kind: "new_repository",
    };
    const targetIdentity = { canonical_root_identity_sha256: "3".repeat(64), schema_version: 1 };
    const displayContent = {
      actionKind: "repository.register",
      effectPreviewRefs: [],
      policyRevision: 1,
      policySha256: "4".repeat(64),
      preparedActionId: randomUUID(),
      principalScope: "local_owner",
      schemaVersion: 1 as const,
      summary: "Register the exact local repository.",
      target,
      targetIdentity,
      warnings: [],
    };
    const display = actionDisplayArtifactV1Schema.parse({
      ...displayContent,
      displaySha256: sha256Canonical(displayContent),
    });
    expect(() => actionDisplayArtifactV1Schema.parse({ ...display, summary: `tampered ${SECRET}` })).toThrow();
    expect(() => actionDisplayArtifactV1Schema.parse({
      ...display,
      target: { ...target, expectedCatalogVersion: { ...target.expectedCatalogVersion, revision: 1 } },
    })).toThrow();

    const artifact = artifactReferenceV1Schema.parse({
      artifactId: randomUUID(),
      artifactSha256: "5".repeat(64),
      bytes: 2,
      createdByOperationId: null,
      mediaType: "application/json",
      metadataDisclosure: "content_authorized",
      owner: "host_artifact_store",
      resourceScope: target.catalogScope,
      schemaVersion: 1,
      scopedIntegrityToken: null,
      transportVisibility: "resource_authorized",
    });
    const prepared = createPreparedAction({
      actionKind: "repository.register",
      confirmation: "show_before_commit",
      displayArtifact: artifact,
      displaySha256: display.displaySha256,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      grantSha256: "6".repeat(64),
      payloadArtifact: artifact,
      payloadSha256: "7".repeat(64),
      policyRevision: 1,
      policySha256: display.policySha256,
      preparedActionId: display.preparedActionId,
      principalId: "local_owner",
      singleUse: true,
      target,
      targetIdentitySha256: sha256Canonical(targetIdentity),
    });
    expect(preparedActionV1Schema.parse(prepared)).toEqual(prepared);
    expect(() => preparedActionV1Schema.parse({
      ...prepared,
      target: { ...target, expectedCatalogVersion: { ...target.expectedCatalogVersion, sha256: "8".repeat(64) } },
    })).toThrow();
    expect(() => preparedActionV1Schema.parse({ ...prepared, displaySha256: "9".repeat(64) })).toThrow();
  });

  it("rejects one idempotency key reused for a different payload identity without leaking it", async () => {
    const plane = await fixture();
    const head = await plane.repositories.head();
    const target: ApplicationActionTargetV1 = {
      catalogScope: plane.repositories.resourceScope,
      expectedCatalogVersion: { kind: "revision", revision: head.revision, sha256: head.catalogSha256 },
      kind: "new_repository",
    };
    const firstPayload = { root: "first" };
    const secondPayload = { root: SECRET };
    await plane.operations.accept({
      actionKind: "repository.register",
      idempotencyKey: "same-key",
      idempotencyNamespace: "security-property",
      preparedActionId: randomUUID(),
      preparedActionSha256: "a".repeat(64),
      requestIdentitySha256: sha256Canonical(firstPayload),
      target,
    });
    let observed: unknown;
    try {
      await plane.operations.accept({
        actionKind: "repository.register",
        idempotencyKey: "same-key",
        idempotencyNamespace: "security-property",
        preparedActionId: randomUUID(),
        preparedActionSha256: "b".repeat(64),
        requestIdentitySha256: sha256Canonical(secondPayload),
        target,
      });
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(ApplicationControlError);
    expect((observed as ApplicationControlError).code).toBe("control_idempotency_conflict");
    expect(JSON.stringify({
      code: (observed as ApplicationControlError).code,
      message: (observed as ApplicationControlError).message,
    })).not.toContain(SECRET);
    expect(await plane.operations.list()).toHaveLength(1);
    expect(await plane.repositories.list()).toHaveLength(0);
  });

  it("returns bounded redacted envelopes for secret-bearing invalid payloads", async () => {
    const plane = await fixture();
    const context = plane.context("cli");
    const head = await plane.repositories.head();
    const payload = { injectedSecret: SECRET, root: await directory("bornagent-phase21a-secret-payload-") };
    const response = await plane.actions.prepare(context, {
      actionKind: "repository.register",
      payload,
      payloadSha256: sha256Canonical(payload),
      prepareIdempotencyKey: "secret-payload",
      requestId: randomUUID(),
      schemaVersion: 1,
      target: {
        catalogScope: plane.repositories.resourceScope,
        expectedCatalogVersion: { kind: "revision", revision: head.revision, sha256: head.catalogSha256 },
        kind: "new_repository",
      },
    });
    expect(response).toMatchObject({ status: "rejected", error: { code: "control_payload_invalid" } });
    expect(JSON.stringify(response)).not.toContain(SECRET);
    expect(JSON.stringify(response).length).toBeLessThan(4_096);
    expect(await plane.artifacts.listRecords()).toHaveLength(0);
    expect(await plane.operations.list()).toHaveLength(0);
  });
});
