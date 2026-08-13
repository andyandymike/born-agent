import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  applicationQueryRequestV1Schema,
  assertWireArtifactReference,
  createPreparedAction,
  decodeStrictJsonBytes,
  projectUserActionOrigin,
  sessionLedgerHeadV1Schema,
  zeroSessionLedgerHead,
} from "../../src/control-plane/application-protocol.js";

describe("Phase 21A strict application protocol", () => {
  it("rejects duplicate JSON fields and caller-supplied trusted context", () => {
    const sessionId = randomUUID();
    const repositoryId = randomUUID();
    const request = {
      atVersion: null,
      pageCursor: null,
      payload: {},
      queryKind: "session.view",
      requestId: randomUUID(),
      resourceScope: { kind: "session", repositoryId, sessionId, teamId: null },
      schemaVersion: 1,
    };
    expect(decodeStrictJsonBytes(
      Buffer.from(JSON.stringify(request), "utf8"),
      applicationQueryRequestV1Schema,
      8 * 1024,
    )).toEqual(request);
    expect(() => decodeStrictJsonBytes(
      Buffer.from(`{"schemaVersion":1,"schemaVersion":1}`, "utf8"),
      applicationQueryRequestV1Schema,
      8 * 1024,
    )).toThrow(/strict JSON/u);
    expect(() => decodeStrictJsonBytes(
      Buffer.from(JSON.stringify({ ...request, principal: { principalId: "local_owner" } }), "utf8"),
      applicationQueryRequestV1Schema,
      8 * 1024,
    )).toThrow(/strict schema/u);
  });

  it("keeps zero and positive session-head identities exact", () => {
    const sessionId = randomUUID();
    expect(zeroSessionLedgerHead(sessionId)).toEqual({
      eventId: null,
      eventIntegrityToken: null,
      schemaVersion: 1,
      sequence: 0,
      sessionId,
    });
    expect(() => sessionLedgerHeadV1Schema.parse({
      eventId: randomUUID(),
      eventIntegrityToken: null,
      schemaVersion: 1,
      sequence: 1,
      sessionId,
    })).toThrow(/complete identities/u);
  });

  it("binds the prepared action hash and rejects host-internal references on wire", () => {
    const repositoryId = randomUUID();
    const scope = { kind: "repository" as const, repositoryId, teamId: null };
    const internal = {
      artifactId: randomUUID(),
      artifactSha256: "a".repeat(64),
      bytes: 2,
      createdByOperationId: null,
      mediaType: "application/json",
      metadataDisclosure: "content_authorized" as const,
      owner: "host_artifact_store" as const,
      resourceScope: scope,
      schemaVersion: 1 as const,
      scopedIntegrityToken: null,
      transportVisibility: "host_internal" as const,
    };
    const prepared = createPreparedAction({
      actionKind: "repository.register",
      confirmation: "show_before_commit",
      displayArtifact: internal,
      displaySha256: "b".repeat(64),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      grantSha256: "c".repeat(64),
      payloadArtifact: internal,
      payloadSha256: "d".repeat(64),
      policyRevision: 1,
      policySha256: "e".repeat(64),
      preparedActionId: randomUUID(),
      principalId: "local_owner",
      singleUse: true,
      target: {
        expectedVersion: { kind: "revision", revision: 0, sha256: "f".repeat(64) },
        kind: "existing_resource",
        resourceScope: scope,
      },
      targetIdentitySha256: "1".repeat(64),
    });
    expect(prepared.preparedActionSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => assertWireArtifactReference(internal)).toThrow(/host-internal/u);
  });

  it("replays legacy user origins without inventing authentication or audit", () => {
    expect(projectUserActionOrigin({ input_surface: "cli", kind: "user" })).toEqual({
      auditAvailability: "not_available_legacy",
      authenticationId: null,
      inputSurface: "cli",
      kind: "legacy_surface",
      operationId: null,
      principalId: "legacy_local_owner",
      requestId: null,
    });
    const operationId = randomUUID();
    expect(projectUserActionOrigin({
      action_identity_sha256: "a".repeat(64),
      application_commit: {
        action_kind: "goal.propose",
        authorization_decision_sha256: "b".repeat(64),
        operation_id: operationId,
        prepared_action_sha256: "c".repeat(64),
        principal_id: "local_owner",
        schema_version: 1,
      },
      authentication_id: "local-owner-generation",
      client_id: "stable-cli-client",
      kind: "authenticated_surface",
      request_id: randomUUID(),
      surface: "cli",
    })).toMatchObject({
      applicationCommit: { operationId, principalId: "local_owner" },
      kind: "authenticated_surface",
      principalId: "local_owner",
    });
  });
});
