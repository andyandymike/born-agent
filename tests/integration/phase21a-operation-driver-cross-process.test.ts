import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Canonical } from "../../src/completion/canonical-json.js";
import { ControlOperationJournal } from "../../src/control-plane/control-operation-journal.js";
import { loadOrCreateHostControlAuthority } from "../../src/control-plane/host-control-identity.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

const worker = String.raw`
const [root, operationId] = process.argv.slice(1);
const { loadOrCreateHostControlAuthority } = await import("./src/control-plane/host-control-identity.ts");
const { ControlOperationJournal } = await import("./src/control-plane/control-operation-journal.ts");
const authority = await loadOrCreateHostControlAuthority({ root });
const journal = new ControlOperationJournal(authority.paths, { driverLeaseMs: 5000 });
const result = await journal.acquireDriver(operationId);
process.stdout.write(JSON.stringify({ kind: result.kind, operationId: result.operation.operationId }) + "\n");
if (result.kind === "acquired") {
  await new Promise((resolve) => setTimeout(resolve, 250));
  await journal.releaseDriver(result.claim);
}
`;

function acquireProcess(root: string, operationId: string): Promise<Readonly<{
  exitCode: number | null;
  stderr: string;
  stdout: string;
}>> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      worker,
      root,
      operationId,
    ], {
      cwd: resolve("."),
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode) => resolveProcess({ exitCode, stderr, stdout }));
  });
}

describe("Phase 21A cross-process operation driver", () => {
  it("persists one exact driver winner across two real Node processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-phase21a-operation-process-"));
    temporary.push(root);
    const authority = await loadOrCreateHostControlAuthority({ root });
    const journal = new ControlOperationJournal(authority.paths);
    const preparedActionId = randomUUID();
    const accepted = await journal.accept({
      actionKind: "session.create",
      idempotencyKey: "cross-process",
      idempotencyNamespace: "application.commit.local_owner",
      preparedActionId,
      preparedActionSha256: sha256Canonical({ preparedActionId }),
      requestIdentitySha256: sha256Canonical({ preparedActionId, semantic: "session.create" }),
      target: {
        catalogScope: { kind: "session_catalog", repositoryId: randomUUID(), teamId: null },
        expectedCatalogVersion: { kind: "revision", revision: 0, sha256: "a".repeat(64) },
        kind: "new_session",
      },
    });
    const results = await Promise.all([
      acquireProcess(root, accepted.operation.operationId),
      acquireProcess(root, accepted.operation.operationId),
    ]);
    expect(results.map((result) => result.exitCode)).toEqual([0, 0]);
    expect(results.map((result) => result.stderr)).toEqual(["", ""]);
    const values = results.map((result) => JSON.parse(result.stdout) as { kind: string; operationId: string });
    expect(values.filter((value) => value.kind === "acquired")).toHaveLength(1);
    expect(values.filter((value) => value.kind === "busy")).toHaveLength(1);
    expect(new Set(values.map((value) => value.operationId))).toEqual(new Set([accepted.operation.operationId]));
  }, 30_000);
});
