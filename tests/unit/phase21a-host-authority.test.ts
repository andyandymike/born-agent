import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ControlArtifactStore } from "../../src/control-plane/control-artifact-store.js";
import { assertWireArtifactReference } from "../../src/control-plane/application-protocol.js";
import { loadOrCreateHostControlAuthority } from "../../src/control-plane/host-control-identity.js";

const temporary: string[] = [];

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bornagent-phase21a-authority-"));
  temporary.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Phase 21A Host control authority", () => {
  it("creates one stable controller, principal generation, and integrity key", async () => {
    const root = await stateRoot();
    const [left, right] = await Promise.all([
      loadOrCreateHostControlAuthority({ root }),
      loadOrCreateHostControlAuthority({ root }),
    ]);
    expect(left.identity).toEqual(right.identity);
    expect(left.localOwner).toEqual(right.localOwner);
    expect(Buffer.from(left.integrityKey)).toEqual(Buffer.from(right.integrityKey));
    expect(left.localOwner).toMatchObject({
      grantRevision: 1,
      kind: "human",
      principalId: "local_owner",
    });
  });

  it("uses scoped opaque metadata tokens and never emits host-internal refs", async () => {
    const authority = await loadOrCreateHostControlAuthority({ root: await stateRoot() });
    const store = new ControlArtifactStore(authority.paths, authority.integrityKey);
    const resourceScope = {
      kind: "repository" as const,
      repositoryId: "00000000-0000-4000-8000-000000000001",
      teamId: null,
    };
    const record = await store.storeJson({
      createdByOperationId: null,
      resourceScope,
      transportVisibility: "resource_authorized",
      value: { lowEntropySecret: "candidate" },
    });
    const profileA = "a".repeat(64);
    const profileB = "b".repeat(64);
    const opaqueA = store.reference({ disclosure: "opaque", disclosureProfileSha256: profileA, record });
    const opaqueB = store.reference({ disclosure: "opaque", disclosureProfileSha256: profileB, record });
    expect(opaqueA).toMatchObject({ artifactSha256: null, bytes: null, mediaType: null });
    expect(opaqueA.scopedIntegrityToken).not.toBe(opaqueB.scopedIntegrityToken);
    expect(store.verifyOpaqueReference({ disclosureProfileSha256: profileA, record, reference: opaqueA })).toBe(true);

    const internal = await store.storeJson({
      createdByOperationId: null,
      resourceScope,
      transportVisibility: "host_internal",
      value: { root: "owner-only" },
    });
    const internalReference = store.reference({
      disclosure: "content_authorized",
      disclosureProfileSha256: profileA,
      record: internal,
    });
    expect(() => assertWireArtifactReference(internalReference)).toThrow(/host-internal/u);
  });
});

