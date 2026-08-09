import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DefaultCapabilityPlatform } from "../../src/capabilities/capability-platform.js";
import { canonicalJson } from "../../src/completion/canonical-json.js";
import { EventPublisher } from "../../src/events/event-publisher.js";
import { PluginLifecycle } from "../../src/plugins/plugin-lifecycle.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import { writeTestCapabilityPackage } from "../phase18a-test-helpers.js";

const RUN_ID = "20000000-0000-4000-8000-000000000018";
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "bornagent-phase18e-lifecycle-"));
  temporary.push(base);
  const workspace = join(base, "workspace");
  const userRoot = join(base, "user-state");
  const builtinRoot = join(base, "builtin");
  await Promise.all([mkdir(workspace), mkdir(builtinRoot)]);
  await writeFile(join(builtinRoot, "index.json"), `${canonicalJson({
    packages: [],
    revision: 1,
    schema_version: 1,
  })}\n`, "utf8");
  let counter = 0;
  const randomUUID = () => {
    counter += 1;
    return `30000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  };
  const lifecycle = new PluginLifecycle({
    isProcessAlive: (pid) => pid === process.pid,
    now: () => "2026-08-08T00:00:00.000Z",
    randomUUID,
    root: userRoot,
    workspace,
  });
  return { base, builtinRoot, lifecycle, userRoot, workspace };
}

async function resetOperationToRequested(path: string): Promise<Record<string, unknown>> {
  const operation = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  delete operation.reconciliation;
  operation.state = "requested";
  await writeFile(path, `${canonicalJson(operation)}\n`, "utf8");
  return operation;
}

async function removeAuditOperation(userRoot: string, operationId: string): Promise<void> {
  const path = join(userRoot, "audit", "v1", "events.jsonl");
  const events = (await readFile(path, "utf8")).trim().split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.operation_id !== operationId);
  await writeFile(path, events.length === 0 ? "" : `${events.map((event) => canonicalJson(event)).join("\n")}\n`, "utf8");
}

describe("Phase 18E local Plugin lifecycle", () => {
  it("inspects without writes, installs disabled, freezes enabled bytes, leases, disables, and removes logically", async () => {
    const value = await fixture();
    const source = resolve("fixtures/capability-platform/m9-review-pack");
    const inspection = await value.lifecycle.inspect(source);
    expect(inspection).toMatchObject({
      pluginId: "bornagent.m9-review-pack",
      status: "valid_schema",
    });
    await expect(access(value.userRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const installed = await value.lifecycle.install(source, inspection.pluginSha256);
    expect(installed).toMatchObject({ changed: true, deduplicated: false, pendingNextRun: false });
    expect((await value.lifecycle.list())[0]).toMatchObject({ enabled: false });

    const enabled = await value.lifecycle.enable(installed.exactSelector);
    expect(enabled).toMatchObject({ beforeRevision: 0, afterRevision: 1, pendingNextRun: true });
    const platform = new DefaultCapabilityPlatform({
      builtinRoot: value.builtinRoot,
      env: {},
      platform: process.platform,
      pluginLifecycle: value.lifecycle,
      userStateRoot: value.userRoot,
      workspace: value.workspace,
    });
    const snapshot = await platform.createSnapshot("2026-08-08T00:00:00.000Z");
    expect(snapshot.plugins.some((plugin) => plugin.pluginSha256 === inspection.pluginSha256)).toBe(true);
    const leases = await platform.acquireContentLeases(snapshot, {
      runId: RUN_ID,
      sessionId: "10000000-0000-4000-8000-000000000018",
      sessionLockNonceSha256: "a".repeat(64),
    });
    expect(leases).toHaveLength(1);

    await value.lifecycle.disable(installed.exactSelector);
    const frozenSkill = snapshot.plugins
      .flatMap((plugin) => plugin.components)
      .find((component) => component.identity.componentId === "review-change")!;
    const content = await platform.createContentSource(snapshot).readComponentFile(
      frozenSkill.identity,
      "SKILL.md",
    );
    expect(Buffer.from(content.bytes).toString("utf8")).toContain("# Review change");

    await expect(value.lifecycle.remove(installed.exactSelector)).rejects.toMatchObject({
      code: "plugin_active_lease",
    });
    expect(await value.lifecycle.list()).toHaveLength(1);
    await leases[0]!.release();

    const removed = await value.lifecycle.remove(installed.exactSelector);
    expect(removed).toMatchObject({ changed: true, retainedContent: true });
    expect(await value.lifecycle.list()).toHaveLength(0);
    await expect(access(join(
      value.userRoot,
      "store",
      "v1",
      "sha256",
      inspection.pluginSha256,
      "bornagent.plugin.json",
    ))).resolves.toBeUndefined();
    const audit = await readFile(join(value.userRoot, "audit", "v1", "events.jsonl"), "utf8");
    expect(audit.trim().split("\n").map((line) => JSON.parse(line).operation)).toEqual([
      "installed",
      "enabled",
      "disabled",
      "removed",
    ]);
    await expect(value.lifecycle.install(source, inspection.pluginSha256)).resolves.toMatchObject({
      changed: true,
      exactSelector: installed.exactSelector,
      retainedContent: true,
    });
  });

  it("deduplicates exact installs, rejects enablement conflicts, and fails closed on store tamper", async () => {
    const value = await fixture();
    const firstSource = join(value.workspace, "first");
    const secondSource = join(value.workspace, "second");
    const firstPackage = await writeTestCapabilityPackage(firstSource, {
      pluginId: "acme.collision",
      pluginVersion: "1.0.0",
    });
    const secondPackage = await writeTestCapabilityPackage(secondSource, {
      extraFiles: { "SKILL.md": "# Different exact bytes\n" },
      pluginId: "acme.collision",
      pluginVersion: "1.0.0",
    });
    const first = await value.lifecycle.install(firstSource, firstPackage.pluginSha256);
    await expect(value.lifecycle.install(firstSource, firstPackage.pluginSha256)).resolves.toMatchObject({
      changed: false,
      deduplicated: true,
    });
    const second = await value.lifecycle.install(secondSource, secondPackage.pluginSha256);
    await value.lifecycle.enable(first.exactSelector);
    await expect(value.lifecycle.enable(second.exactSelector)).rejects.toMatchObject({
      code: "plugin_enablement_conflict",
    });

    await writeFile(join(
      value.userRoot,
      "store",
      "v1",
      "sha256",
      firstPackage.pluginSha256,
      "SKILL.md",
    ), "tampered\n", "utf8");
    await expect(value.lifecycle.show(first.exactSelector)).rejects.toMatchObject({
      code: "plugin_tampered",
    });
  });

  it("reconciles durable leases only from an exact run terminal or dead session-lock owner", async () => {
    const value = await fixture();
    const installed = await value.lifecycle.install(resolve("fixtures/capability-platform/m9-review-pack"));
    await value.lifecycle.enable(installed.exactSelector);
    const sessionId = "10000000-0000-4000-8000-000000000018";
    const writer = await V2SessionWriter.createNew(value.workspace, sessionId);
    const publisher = new EventPublisher({
      randomUUID,
      renderer: { render: () => undefined },
      runId: RUN_ID,
      sessionId,
      timestamp: () => "2026-08-08T00:00:00.000Z",
      writer,
    });
    await publisher.publish({
      data: {
        command: "chat",
        input: { role: "user", text: "lease fixture" },
        model: "local-fixture",
        provider: "ollama",
        timeout_ms: 1_000,
        workspace: value.workspace,
      },
      type: "run.started",
    });
    await publisher.publish({
      data: {
        adapter: "pi-ai",
        adapter_version: "0.80.7",
        capabilities: {
          cancellation: "abort_signal",
          reasoning: "none",
          streaming: true,
          tools: "best_effort",
          usage: "complete",
        },
        config_fingerprint: "1".repeat(64),
        model: "local-fixture",
        provider: "ollama",
        resume_capability: "canonical_only",
      },
      type: "backend.selected",
    });
    const leases = await value.lifecycle.acquireLeases([installed.exactSelector.slice(-64)], {
      runId: RUN_ID,
      sessionId,
      sessionLockNonceSha256: writer.lockNonceSha256,
    });
    await value.lifecycle.disable(installed.exactSelector);
    await expect(value.lifecycle.reconcileLeases(sessionId, writer.events)).resolves.toMatchObject({
      released: 0,
      retained: 1,
    });
    await expect(value.lifecycle.remove(installed.exactSelector)).rejects.toMatchObject({ code: "plugin_active_lease" });
    await publisher.publish({
      data: {
        category: "internal",
        code: "fixture_terminal",
        duration_ms: 1,
        message: "fixture terminal",
        retryable: false,
      },
      type: "run.failed",
    });
    await expect(value.lifecycle.reconcileLeases(sessionId, writer.events)).resolves.toMatchObject({
      released: 1,
      retained: 0,
    });
    await expect(value.lifecycle.remove(installed.exactSelector)).resolves.toMatchObject({ retainedContent: true });
    await leases[0]!.release();
    await writer.close();

    const reinstalled = await value.lifecycle.install(resolve("fixtures/capability-platform/m9-review-pack"));
    await value.lifecycle.enable(reinstalled.exactSelector);
    const deadOwnerNonce = "e".repeat(64);
    await value.lifecycle.acquireLeases([reinstalled.exactSelector.slice(-64)], {
      runId: "21000000-0000-4000-8000-000000000018",
      sessionId,
      sessionLockNonceSha256: deadOwnerNonce,
    });
    const resumed = await V2SessionWriter.openExisting(value.workspace, sessionId);
    await resumed.appendSessionEvent("session.lock.recovered", {
      previous_nonce_sha256: "f".repeat(64),
      reason: "owner_confirmed_dead",
    });
    await expect(value.lifecycle.reconcileLeases(sessionId, resumed.events)).resolves.toMatchObject({ released: 0 });
    await resumed.appendSessionEvent("session.lock.recovered", {
      previous_nonce_sha256: deadOwnerNonce,
      reason: "owner_confirmed_dead",
    });
    await expect(value.lifecycle.reconcileLeases(sessionId, resumed.events)).resolves.toMatchObject({ released: 1 });
    await resumed.close();
  });

  it("reconciles applied and not-applied operation crash prefixes before later mutations", async () => {
    const value = await fixture();
    const source = resolve("fixtures/capability-platform/m9-review-pack");
    const installed = await value.lifecycle.install(source);
    const operations = join(value.userRoot, "tmp", "operations");
    const installedOperation = join(operations, `${installed.operationId}.json`);
    await resetOperationToRequested(installedOperation);
    await writeFile(join(value.userRoot, "audit", "v1", "events.jsonl"), "", "utf8");

    await expect(value.lifecycle.doctor()).resolves.toMatchObject({
      incompleteOperationCount: 0,
      reconciledOperationCount: 1,
      status: "valid",
    });
    expect(JSON.parse(await readFile(installedOperation, "utf8"))).toMatchObject({
      reconciliation: { observed: "applied_exact" },
      state: "completed",
    });

    const enabled = await value.lifecycle.enable(installed.exactSelector);
    const pending = join(operations, `${enabled.operationId}.json`);
    await resetOperationToRequested(pending);
    await removeAuditOperation(value.userRoot, enabled.operationId);
    await writeFile(join(value.userRoot, "enablement", "v1", "state.json"), `${canonicalJson({
      packages: [],
      revision: 0,
      schema_version: 1,
    })}\n`, "utf8");
    await expect(value.lifecycle.doctor()).resolves.toMatchObject({
      incompleteOperationCount: 0,
      reconciledOperationCount: 1,
      status: "valid",
    });
    expect(JSON.parse(await readFile(pending, "utf8"))).toMatchObject({
      reconciliation: { observed: "not_applied" },
      state: "completed",
    });
  });

  it("backfills exact enable, disable, and remove audit prefixes without repeating a mutation", async () => {
    const value = await fixture();
    const installed = await value.lifecycle.install(resolve("fixtures/capability-platform/m9-review-pack"));
    const operations = join(value.userRoot, "tmp", "operations");

    const enabled = await value.lifecycle.enable(installed.exactSelector);
    const enabledPath = join(operations, `${enabled.operationId}.json`);
    await resetOperationToRequested(enabledPath);
    await removeAuditOperation(value.userRoot, enabled.operationId);
    await expect(value.lifecycle.doctor()).resolves.toMatchObject({ reconciledOperationCount: 1, status: "valid" });
    expect(JSON.parse(await readFile(enabledPath, "utf8"))).toMatchObject({
      reconciliation: { observed: "applied_exact" },
      state: "completed",
    });

    const disabled = await value.lifecycle.disable(installed.exactSelector);
    const disabledPath = join(operations, `${disabled.operationId}.json`);
    await resetOperationToRequested(disabledPath);
    await removeAuditOperation(value.userRoot, disabled.operationId);
    await expect(value.lifecycle.doctor()).resolves.toMatchObject({ reconciledOperationCount: 1, status: "valid" });

    const removed = await value.lifecycle.remove(installed.exactSelector);
    const removedPath = join(operations, `${removed.operationId}.json`);
    await resetOperationToRequested(removedPath);
    await removeAuditOperation(value.userRoot, removed.operationId);
    await expect(value.lifecycle.doctor()).resolves.toMatchObject({
      installedPluginCount: 0,
      reconciledOperationCount: 1,
      status: "valid",
    });
    const audit = (await readFile(join(value.userRoot, "audit", "v1", "events.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(audit.map((event) => event.operation)).toEqual(["installed", "enabled", "disabled", "removed"]);
    expect(new Set(audit.map((event) => event.operation_id)).size).toBe(4);
  });

  it("adopts an exact immutable install orphan before completing its original operation", async () => {
    const value = await fixture();
    const installed = await value.lifecycle.install(resolve("fixtures/capability-platform/m9-review-pack"));
    const operationPath = join(value.userRoot, "tmp", "operations", `${installed.operationId}.json`);
    const operation = await resetOperationToRequested(operationPath);
    await removeAuditOperation(value.userRoot, installed.operationId);
    await writeFile(join(value.userRoot, "indexes", "v1", "installed.json"), `${canonicalJson({
      plugins: [],
      revision: 0,
      schema_version: 1,
    })}\n`, "utf8");
    const indexTemporary = join(value.userRoot, "indexes", "v1", `.installed.json.${String(operation.operation_id)}.tmp`);
    const auditTemporary = join(value.userRoot, "audit", "v1", `.events.jsonl.${String(operation.audit_event_id)}.tmp`);
    await writeFile(indexTemporary, "stale index prefix", "utf8");
    await writeFile(auditTemporary, "stale audit prefix", "utf8");

    await expect(value.lifecycle.doctor()).resolves.toMatchObject({
      installedPluginCount: 1,
      reconciledOperationCount: 1,
      status: "valid",
    });
    expect(JSON.parse(await readFile(operationPath, "utf8"))).toMatchObject({
      reconciliation: { observed: "applied_exact" },
      state: "completed",
    });
    await expect(access(indexTemporary)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(auditTemporary)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on ambiguous state and audit revision conflicts", async () => {
    const value = await fixture();
    const installed = await value.lifecycle.install(resolve("fixtures/capability-platform/m9-review-pack"));
    const enabled = await value.lifecycle.enable(installed.exactSelector);
    const operationPath = join(value.userRoot, "tmp", "operations", `${enabled.operationId}.json`);
    await resetOperationToRequested(operationPath);
    const auditPath = join(value.userRoot, "audit", "v1", "events.jsonl");
    const events = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const originalEventId = events.at(-1).event_id;
    events.at(-1).event_id = "30000000-0000-4000-8000-000000008888";
    await writeFile(auditPath, `${events.map((event) => canonicalJson(event)).join("\n")}\n`, "utf8");
    await expect(value.lifecycle.doctor()).rejects.toMatchObject({ code: "plugin_store_corrupt" });

    events.at(-1).event_id = originalEventId;
    events.at(-1).next_enablement_revision = 2;
    await writeFile(auditPath, `${events.map((event) => canonicalJson(event)).join("\n")}\n`, "utf8");
    await expect(value.lifecycle.doctor()).rejects.toMatchObject({ code: "plugin_store_corrupt" });

    await removeAuditOperation(value.userRoot, enabled.operationId);
    await writeFile(join(value.userRoot, "enablement", "v1", "state.json"), `${canonicalJson({
      packages: [],
      revision: 2,
      schema_version: 1,
    })}\n`, "utf8");
    await expect(value.lifecycle.doctor()).rejects.toMatchObject({ code: "plugin_store_corrupt" });
  });

  it("rejects a truncated audit rather than skipping or rewriting its tail", async () => {
    const value = await fixture();
    await value.lifecycle.install(resolve("fixtures/capability-platform/m9-review-pack"));
    const auditPath = join(value.userRoot, "audit", "v1", "events.jsonl");
    await writeFile(auditPath, '{"schema_version":1', "utf8");
    await expect(value.lifecycle.doctor()).rejects.toMatchObject({ code: "plugin_store_corrupt" });
    await writeFile(auditPath, "", "utf8");
    await expect(value.lifecycle.doctor()).rejects.toMatchObject({ code: "plugin_store_corrupt" });
  });
});
