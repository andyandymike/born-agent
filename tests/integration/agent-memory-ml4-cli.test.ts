import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { disposeApplicationHostForStateRoot } from "../../src/control-plane/adapters/agent-cli-adapter.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

const temporary: string[] = [];
const activeStateRoots: string[] = [];

afterEach(async () => {
  await Promise.all(activeStateRoots.splice(0).map((root) => disposeApplicationHostForStateRoot(root)));
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

describe("Agent memory ML4 CLI lifecycle", () => {
  it("adds, supersedes, diagnoses, rebuilds and retracts one explicit record without admitting a secret", async () => {
    const fixture = JSON.parse(await readFile(
      resolve("fixtures/agent-memory/ml4/lifecycle.json"),
      "utf8",
    )) as {
      readonly add: { readonly kind: string; readonly query: string; readonly text: string };
      readonly rejectedSecret: string;
      readonly supersede: { readonly kind: string; readonly query: string; readonly text: string };
    };
    const cwd = await directory("bornagent-ml4-cli-repository-");
    const stateRoot = await directory("bornagent-ml4-cli-state-");
    activeStateRoots.push(stateRoot);
    const runtime = createRuntime({ controlPlaneStateRoot: stateRoot, cwd });

    const register = createMemoryIO();
    expect(await runCli([
      "agent",
      "register this repository without local memory",
      "--task-profile",
      "read-only",
      "--max-steps",
      "1",
      "--memory",
      "off",
    ], register.io, runtime), register.readStderr()).toBe(0);

    const remembered = createMemoryIO();
    expect(await runCli([
      "memory",
      "remember",
      fixture.add.kind,
      fixture.add.text,
      "--json",
    ], remembered.io, runtime), remembered.readStderr()).toBe(0);
    const first = JSON.parse(remembered.readStdout()) as {
      readonly derivedCleanup: string;
      readonly operation: { readonly operation: string };
      readonly record: { readonly recordId: string; readonly revision: number; readonly revisionId: string };
      readonly status: string;
    };
    expect(first).toMatchObject({
      derivedCleanup: "removed",
      operation: { operation: "ADD" },
      record: { revision: 1 },
      status: "added",
    });

    const initialSearch = createMemoryIO();
    expect(await runCli([
      "memory", "search", fixture.add.query, "--json",
    ], initialSearch.io, runtime), initialSearch.readStderr()).toBe(0);
    const initialHit = JSON.parse(initialSearch.readStdout()) as {
      readonly hits: readonly { readonly record: { readonly recordId: string; readonly revisionId: string } }[];
      readonly projection: { readonly action: string };
      readonly status: string;
    };
    expect(initialHit).toMatchObject({ projection: { action: "rebuilt" }, status: "matched" });
    expect(initialHit.hits[0]?.record).toMatchObject({
      recordId: first.record.recordId,
      revisionId: first.record.revisionId,
    });

    const secretText = fixture.rejectedSecret;
    const secretMarker = secretText.split(" ").at(-1)!;
    const rejected = createMemoryIO();
    expect(await runCli([
      "memory", "remember", "fact", secretText, "--json",
    ], rejected.io, runtime)).toBe(2);
    expect(rejected.readStderr()).toContain("memory_record_not_admitted");
    expect(rejected.readStderr()).not.toContain(secretMarker);
    expect(rejected.readStdout()).toBe("");

    const canonicalPath = join(stateRoot, "memory", "v1", "memory.sqlite3");
    const canonical = new DatabaseSync(canonicalPath, { readOnly: true });
    expect(canonical.prepare(
      "SELECT COUNT(*) AS count FROM memory_records WHERE instr(CAST(canonical_json AS TEXT), ?) > 0",
    ).get(secretMarker)).toEqual({ count: 0 });
    canonical.close();
    const projectionRoot = join(stateRoot, "memory", "v1", "retrieval", "fts5-v2");
    const projectionFiles = (await readdir(projectionRoot)).filter((name) => name.endsWith(".sqlite3"));
    expect(projectionFiles).toHaveLength(1);
    const projection = new DatabaseSync(join(projectionRoot, projectionFiles[0]!), { readOnly: true });
    expect(JSON.stringify(projection.prepare("SELECT title, text FROM records_fts").all()))
      .not.toContain(secretMarker);
    projection.close();

    const superseded = createMemoryIO();
    expect(await runCli([
      "memory",
      "remember",
      fixture.supersede.kind,
      fixture.supersede.text,
      "--supersedes",
      first.record.recordId,
      "--json",
    ], superseded.io, runtime), superseded.readStderr()).toBe(0);
    const second = JSON.parse(superseded.readStdout()) as typeof first;
    expect(second).toMatchObject({
      operation: { operation: "SUPERSEDE" },
      record: { recordId: first.record.recordId, revision: 2 },
      status: "superseded",
    });
    expect(second.record.revisionId).not.toBe(first.record.revisionId);

    for (const [query, expected] of [[fixture.add.query, "abstained"], [fixture.supersede.query, "matched"]] as const) {
      const searched = createMemoryIO();
      expect(await runCli(["memory", "search", query, "--json"], searched.io, runtime), searched.readStderr()).toBe(0);
      const result = JSON.parse(searched.readStdout()) as {
        readonly hits: readonly { readonly record: { readonly revisionId: string } }[];
        readonly status: string;
      };
      expect(result.status).toBe(expected);
      if (expected === "matched") expect(result.hits[0]?.record.revisionId).toBe(second.record.revisionId);
    }

    const doctor = createMemoryIO();
    expect(await runCli(["memory", "doctor", "--json"], doctor.io, runtime), doctor.readStderr()).toBe(0);
    expect(JSON.parse(doctor.readStdout())).toMatchObject({
      checks: {
        fts: { status: "ok" },
        quickCheck: "ok",
        sources: { available: 1, stale: 0 },
        storeSchemaVersion: 2,
      },
      status: "ok",
    });

    const before = createMemoryIO();
    expect(await runCli(["memory", "status", "--json"], before.io, runtime), before.readStderr()).toBe(0);
    const beforeStatus = JSON.parse(before.readStdout()) as { readonly logicalSha256: string };
    await rm(join(stateRoot, "memory", "v1", "retrieval"), { force: true, recursive: true });
    const rebuilt = createMemoryIO();
    expect(await runCli(["memory", "rebuild", "--json"], rebuilt.io, runtime), rebuilt.readStderr()).toBe(0);
    expect(JSON.parse(rebuilt.readStdout())).toMatchObject({
      afterLogicalSha256: beforeStatus.logicalSha256,
      beforeLogicalSha256: beforeStatus.logicalSha256,
      recordCount: 1,
      status: "rebuilt",
    });
    const after = createMemoryIO();
    expect(await runCli(["memory", "status", "--json"], after.io, runtime), after.readStderr()).toBe(0);
    expect(JSON.parse(after.readStdout())).toMatchObject({ logicalSha256: beforeStatus.logicalSha256 });

    const retracted = createMemoryIO();
    expect(await runCli([
      "memory", "retract", first.record.recordId, "--json",
    ], retracted.io, runtime), retracted.readStderr()).toBe(0);
    expect(JSON.parse(retracted.readStdout())).toMatchObject({
      derivedCleanup: "removed",
      operation: { operation: "RETRACT" },
      status: "retracted",
    });

    const noHit = createMemoryIO();
    expect(await runCli(["memory", "search", fixture.supersede.query, "--json"], noHit.io, runtime), noHit.readStderr()).toBe(0);
    expect(JSON.parse(noHit.readStdout())).toMatchObject({ hits: [], status: "abstained" });
    const listed = createMemoryIO();
    expect(await runCli(["memory", "list", "--json"], listed.io, runtime), listed.readStderr()).toBe(0);
    expect(JSON.parse(listed.readStdout())).toMatchObject({ items: [] });
    const shown = createMemoryIO();
    expect(await runCli([
      "memory", "show", first.record.recordId, "--json",
    ], shown.io, runtime), shown.readStderr()).toBe(0);
    expect(JSON.parse(shown.readStdout())).toMatchObject({
      lifecycleStatus: "retracted",
      record: { revision: 2, revisionId: second.record.revisionId },
      sourceStatus: "available",
    });

    const repeated = createMemoryIO();
    expect(await runCli([
      "memory", "retract", first.record.recordId, "--json",
    ], repeated.io, runtime), repeated.readStderr()).toBe(0);
    expect(JSON.parse(repeated.readStdout())).toMatchObject({
      derivedCleanup: "unchanged",
      status: "already_retracted",
    });
    const finalStatus = createMemoryIO();
    expect(await runCli(["memory", "status", "--json"], finalStatus.io, runtime), finalStatus.readStderr()).toBe(0);
    expect(JSON.parse(finalStatus.readStdout())).toMatchObject({
      activeRecordCount: 0,
      operationCount: 3,
      revisionCount: 2,
      schemaVersion: 2,
    });
  }, 45_000);
});
