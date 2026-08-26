import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { canonicalJson } from "../../src/completion/canonical-json.js";
import { disposeApplicationHostForStateRoot } from "../../src/control-plane/adapters/agent-cli-adapter.js";
import type { Ml1EpisodeRecordV1 } from "../../src/memory/core/ml1-episode-record.js";
import { FakeStreamingChatClient, fixedStream } from "../fakes/fake-chat-client.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

const execFileAsync = promisify(execFile);
const temporary: string[] = [];
const activeStateRoots: string[] = [];
const fixtureRoot = resolve("fixtures/agent-memory/ml1");

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function withoutKeys(value: Record<string, unknown>, omitted: readonly string[]): Record<string, unknown> {
  const omissions = new Set(omitted);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !omissions.has(key)));
}

function normalizeRunIdentity(value: string): string {
  return value.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu,
    "<run-identity>",
  );
}

function offModeSemanticRequest(request: unknown): unknown {
  const raw = objectValue(request, "model request");
  const canonical = objectValue(raw.canonicalContext, "canonical context");
  const context = objectValue(JSON.parse(String(canonical.text)), "decoded canonical context");
  const items = Array.isArray(context.items)
    ? context.items.map((item) => withoutKeys(objectValue(item, "context item"), ["id", "turn_id"]))
    : [];
  const protectedFacts = Array.isArray(context.protected_facts)
    ? context.protected_facts.map((fact) => withoutKeys(objectValue(fact, "protected fact"), ["fact_id", "item_id"]))
    : [];
  const plan = objectValue(raw.contextPlan, "context plan");
  return {
    ...withoutKeys(raw, ["canonicalContext", "contextPlan"]),
    canonicalContext: {
      ...withoutKeys(canonical, ["sha256", "text"]),
      decoded: {
        ...withoutKeys(context, ["items", "protected_facts"]),
        items,
        protected_facts: protectedFacts,
      },
    },
    contextPlan: {
      ...withoutKeys(plan, ["canonicalContextSha256", "includedItemIds", "protectedFactIds"]),
      includedItemCount: Array.isArray(plan.includedItemIds) ? plan.includedItemIds.length : 0,
      protectedFactCount: Array.isArray(plan.protectedFactIds) ? plan.protectedFactIds.length : 0,
    },
  };
}

afterEach(async () => {
  await Promise.all(activeStateRoots.splice(0).map((root) => disposeApplicationHostForStateRoot(root)));
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

async function goldenWorkspace(): Promise<Readonly<{ manifest: { readonly expectedRecord: Ml1EpisodeRecordV1 }; workspace: string }>> {
  const manifest = JSON.parse(await readFile(join(fixtureRoot, "manifest.json"), "utf8")) as {
    readonly expectedRecord: Ml1EpisodeRecordV1;
  };
  const workspace = await directory("bornagent-ml1-process-workspace-");
  const target = join(workspace, ".bornagent", "sessions", `${manifest.expectedRecord.source.sessionId}.jsonl`);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join(fixtureRoot, "session.jsonl"), target);
  return Object.freeze({ manifest, workspace });
}

async function child(action: "read" | "write", stateRoot: string, workspace: string): Promise<unknown> {
  const result = await execFileAsync(process.execPath, [
    "--import",
    "tsx",
    resolve("tests/fixtures/agent-memory-ml1-process.ts"),
    action,
    stateRoot,
    workspace,
  ], { cwd: resolve("."), timeout: 20_000, windowsHide: true });
  return JSON.parse(result.stdout) as unknown;
}

describe("Agent memory ML1 CLI integration", () => {
  it("ML1 product path keeps memory mode off storage-free and behavior-neutral", async () => {
    const cwd = await directory("bornagent-ml1-off-repository-");
    const requests: unknown[] = [];
    const outputs: Array<Readonly<{ stderr: string; stdout: string }>> = [];
    for (const suffix of [[], ["--memory", "off"]] as const) {
      const stateRoot = await directory("bornagent-ml1-off-state-");
      activeStateRoots.push(stateRoot);
      const client = new FakeStreamingChatClient(fixedStream());
      const runtime = createRuntime({
        controlPlaneStateRoot: stateRoot,
        createModelBackend: () => client,
        cwd,
      });
      const output = createMemoryIO();
      const exitCode = await runCli([
        "agent",
        "answer one bounded read-only question",
        "--task-profile",
        "read-only",
        "--max-steps",
        "1",
        ...suffix,
      ], output.io, runtime);
      expect(exitCode, output.readStderr()).toBe(0);
      await expect(access(join(stateRoot, "memory", "v1", "memory.sqlite3"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(client.calls).toHaveLength(1);
      requests.push(client.calls[0]!.request);
      outputs.push({ stderr: output.readStderr(), stdout: output.readStdout() });
      await disposeApplicationHostForStateRoot(stateRoot);
      const activeIndex = activeStateRoots.indexOf(stateRoot);
      if (activeIndex >= 0) {
        activeStateRoots.splice(activeIndex, 1);
      }
      await rm(join(cwd, ".bornagent"), { force: true, recursive: true });
    }
    expect(outputs[1]?.stdout).toBe(outputs[0]?.stdout);
    expect(normalizeRunIdentity(outputs[1]?.stderr ?? "")).toBe(
      normalizeRunIdentity(outputs[0]?.stderr ?? ""),
    );
    expect(canonicalJson(offModeSemanticRequest(requests[1]))).toBe(
      canonicalJson(offModeSemanticRequest(requests[0])),
    );
  });

  it("ML1 product local mode ingests after terminal and exposes status list and show", async () => {
    const cwd = await directory("bornagent-ml1-local-repository-");
    const stateRoot = await directory("bornagent-ml1-local-state-");
    activeStateRoots.push(stateRoot);
    const runtime = createRuntime({ controlPlaneStateRoot: stateRoot, cwd });
    const run = createMemoryIO();
    expect(await runCli([
      "agent",
      "answer one bounded read-only question",
      "--task-profile",
      "read-only",
      "--max-steps",
      "1",
      "--memory",
      "local",
    ], run.io, runtime), run.readStderr()).toBe(0);
    await expect(access(join(stateRoot, "memory", "v1", "memory.sqlite3"))).resolves.toBeUndefined();

    const status = createMemoryIO();
    expect(await runCli(["memory", "status", "--json"], status.io, runtime), status.readStderr()).toBe(0);
    expect(JSON.parse(status.readStdout())).toMatchObject({ episodeCount: 1, mode: "local", schemaVersion: 1 });
    const listed = createMemoryIO();
    expect(await runCli(["memory", "list", "--json"], listed.io, runtime), listed.readStderr()).toBe(0);
    const page = JSON.parse(listed.readStdout()) as { readonly items: readonly { readonly record: { readonly recordId: string } }[] };
    expect(page.items).toHaveLength(1);
    const shown = createMemoryIO();
    expect(await runCli(["memory", "show", page.items[0]!.record.recordId, "--json"], shown.io, runtime), shown.readStderr()).toBe(0);
    expect(JSON.parse(shown.readStdout())).toMatchObject({ sourceStatus: "available" });

    const foreignRoot = await directory("bornagent-ml1-foreign-repository-");
    const foreign = createMemoryIO();
    expect(await runCli(
      ["memory", "list", "--json"],
      foreign.io,
      createRuntime({ controlPlaneStateRoot: stateRoot, cwd: foreignRoot }),
    )).toBe(2);
    expect(foreign.readStderr()).toContain("memory_repository_unregistered");
    expect(foreign.readStdout()).toBe("");
  });

  it("ML1 ingest failure cannot replace an already successful Agent terminal", async () => {
    const cwd = await directory("bornagent-ml1-failed-ingest-repository-");
    const stateRoot = await directory("bornagent-ml1-failed-ingest-state-");
    activeStateRoots.push(stateRoot);
    const databasePath = join(stateRoot, "memory", "v1", "memory.sqlite3");
    await mkdir(dirname(databasePath), { recursive: true });
    await writeFile(databasePath, Buffer.alloc(0));
    const output = createMemoryIO();
    const exitCode = await runCli([
      "agent",
      "answer one bounded read-only question",
      "--task-profile",
      "read-only",
      "--max-steps",
      "1",
      "--memory",
      "local",
    ], output.io, createRuntime({ controlPlaneStateRoot: stateRoot, cwd }));
    expect(exitCode, output.readStderr()).toBe(0);
    expect(output.readStdout()).toBe("fake response\n");
    expect(output.readStderr()).toContain("memory_ingest_failed: memory_store_corrupt");
    expect((await readFile(databasePath)).byteLength).toBe(0);
  });

  it("ML1 packed-style CLI reads the same logical episode after a full process restart", async () => {
    const stateRoot = await directory("bornagent-ml1-process-state-");
    const { manifest, workspace } = await goldenWorkspace();
    const written = await child("write", stateRoot, workspace) as {
      readonly record: Ml1EpisodeRecordV1;
      readonly result: { readonly status: string };
      readonly status: string;
    };
    expect(written).toMatchObject({ result: { status: "inserted" }, status: "stored" });
    const read = await child("read", stateRoot, workspace) as {
      readonly record: Ml1EpisodeRecordV1;
      readonly sourceStatus: string;
    };
    expect(read.sourceStatus).toBe("available");
    expect(read.record.recordId).toBe(manifest.expectedRecord.recordId);
    expect(read.record.recordSha256).toBe(manifest.expectedRecord.recordSha256);
  });

  it("ML1 show marks missing or tampered exact session evidence stale", async () => {
    const stateRoot = await directory("bornagent-ml1-stale-state-");
    const { manifest, workspace } = await goldenWorkspace();
    await child("write", stateRoot, workspace);
    const sessionPath = join(workspace, ".bornagent", "sessions", `${manifest.expectedRecord.source.sessionId}.jsonl`);
    const lines = (await readFile(sessionPath, "utf8")).trimEnd().split("\n");
    await writeFile(sessionPath, `${lines.slice(0, -1).join("\n")}\n`, "utf8");
    const read = await child("read", stateRoot, workspace) as {
      readonly sourceStatus: string;
      readonly staleReason: string;
    };
    expect(read).toMatchObject({ sourceStatus: "stale", staleReason: "range_mismatch" });

    await copyFile(join(fixtureRoot, "session.jsonl"), sessionPath);
    const original = await readFile(sessionPath, "utf8");
    expect(original).toContain("Update README and run pnpm check");
    await writeFile(
      sessionPath,
      original.replace("Update README and run pnpm check", "Update READMZ and run pnpm check"),
      "utf8",
    );
    const tampered = await child("read", stateRoot, workspace) as {
      readonly sourceStatus: string;
      readonly staleReason: string;
    };
    expect(tampered).toMatchObject({ sourceStatus: "stale", staleReason: "range_mismatch" });
  });
});
