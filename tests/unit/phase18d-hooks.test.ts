import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactSessionRuntime } from "../../src/artifacts/artifact-session-runtime.js";
import { canonicalJson } from "../../src/completion/canonical-json.js";
import { HookCommandRunner } from "../../src/hooks/hook-command-runner.js";
import { HookRuntime, type HookDurableFacts } from "../../src/hooks/hook-runtime.js";
import type { Phase18HookRunEventType } from "../../src/hooks/hook-event-schema.js";
import type { ProcessTreeCleanup } from "../../src/execution/process-tree-cleanup.js";
import {
  createTestCapabilityRoots,
  writeTestCapabilityPackage,
  writeTestSourceIndex,
} from "../phase18a-test-helpers.js";

const SESSION_ID = "10000000-0000-4000-8000-000000000018";
const RUN_ID = "20000000-0000-4000-8000-000000000018";
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

const baseFacts = (): HookDurableFacts => ({
  cleanEffectReconciliation: true,
  cleanEffectReconciliationEvidence: ["host:effect-ledger-clean:1"],
  currentVerifications: [],
  planApproved: false,
  planApprovalEvidence: [],
});

function commandGate(timeoutMs?: number) {
  return {
    component_id: "observer",
    description: "Strict command gate.",
    display_name: "Gate",
    event: "tool.before_effect",
    failure_policy: "fail_closed",
    handler: {
      argv: [],
      cwd: "plugin_root",
      environment: {},
      executable: "observer.mjs",
      sandbox: "policy_selected",
      type: "command",
    },
    kind: "hook",
    mode: "gate",
    requested_effects: ["process_spawn"],
    schema_version: 1,
    ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
  };
}

async function hookFixture(
  hook: unknown,
  facts = baseFacts(),
  command?: {
    readonly approval?: "approved" | "cancelled" | "denied";
    readonly cleanup?: ProcessTreeCleanup;
    readonly onEvent?: (type: Phase18HookRunEventType) => void;
    readonly script?: string;
  },
) {
  const base = await mkdtemp(join(tmpdir(), "bornagent-phase18d-hooks-"));
  temporary.push(base);
  const roots = await createTestCapabilityRoots(base);
  const plugin = await writeTestCapabilityPackage(join(roots.userRoot, "hook-package"), {
    extraFiles: {
      "hook.json": `${canonicalJson(hook)}\n`,
      "observer.mjs": command?.script ?? "process.stdout.write('{}');\n",
    },
    includeHook: true,
    includeSkill: false,
  });
  await writeTestSourceIndex(join(roots.userRoot, "enablement.json"), 1, [
    { enabled: true, package: plugin, path: "hook-package" },
  ]);
  const snapshot = await roots.platform.createSnapshot("2026-08-08T00:00:00.000Z");
  const artifacts = await ArtifactSessionRuntime.create({
    eventAppender: { appendArtifactEvent: async () => undefined },
    events: [],
    runId: RUN_ID,
    sessionId: SESSION_ID,
    workspace: roots.workspace,
  });
  const events: Array<{ readonly data: unknown; readonly type: Phase18HookRunEventType }> = [];
  let counter = 0;
  const randomUUID = () => {
    counter += 1;
    return `30000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  };
  return {
    events,
    runtime: new HookRuntime({
      artifacts,
      ...(command === undefined
        ? {}
        : {
            commandRunner: new HookCommandRunner({
              cleanup: command.cleanup ?? {
                terminate: async (pid) => {
                  if (pid !== undefined) {
                    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
                  }
                  return { detail: "clean" as const, forced: true, verified: true };
                },
              },
              content: roots.platform.createContentSource(snapshot),
              environment: process.env,
              executable: process.execPath,
              prompt: { request: async () => command.approval ?? "approved" },
              randomUUID,
              secrets: [],
              workspace: roots.workspace,
            }),
          }),
      events: {
        append: async (type, data) => {
          events.push({ data, type });
          command?.onEvent?.(type);
        },
      },
      facts: () => facts,
      randomUUID,
      runId: RUN_ID,
      sessionId: SESSION_ID,
      snapshot,
      timestamp: () => "2026-08-08T00:00:00.000Z",
      workspaceLogicalId: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    }),
  };
}

describe("Phase 18D lifecycle Hooks", () => {
  it("denies a protected exact path and never upgrades no_objection to allow", async () => {
    const value = await hookFixture({
      component_id: "protect-generated",
      description: "Protect one generated path.",
      display_name: "Protect generated",
      event: "tool.before_effect",
      failure_policy: "fail_closed",
      handler: {
        message: "protected output",
        predicate: { prefixes: ["generated/protected.txt"], type: "deny_path_prefixes" },
        type: "declarative_gate",
      },
      kind: "hook",
      matcher: { action_kinds: ["apply_patch"], path_prefixes: ["generated"] },
      mode: "gate",
      requested_effects: [],
      schema_version: 1,
    });
    const denied = await value.runtime.run("tool.before_effect", {
      action: {
        actionKind: "apply_patch",
        originalActionSha256: "a".repeat(64),
        paths: ["generated/protected.txt"],
        toolName: "apply_patch",
      },
    }, new AbortController().signal);
    expect(denied).toMatchObject({ decision: "deny", code: "hook_gate_denied" });
    expect(value.events.map((event) => event.type)).toEqual([
      "hook.matched",
      "hook.invocation.requested",
      "hook.invocation.decided",
    ]);

    const clean = await value.runtime.run("tool.before_effect", {
      action: {
        actionKind: "apply_patch",
        originalActionSha256: "b".repeat(64),
        paths: ["generated/allowed.txt"],
        toolName: "apply_patch",
      },
    }, new AbortController().signal);
    expect(clean).toMatchObject({ decision: "no_objection" });
    expect(clean).not.toHaveProperty("allow");
  });

  it("requires current verification identities with durable evidence, not a bare command claim", async () => {
    const hook = {
      component_id: "verified-completion",
      description: "Require current typecheck evidence.",
      display_name: "Verified completion",
      event: "completion.before_commit",
      failure_policy: "fail_closed",
      handler: {
        message: "pnpm typecheck must be current",
        predicate: { commands: ["pnpm typecheck"], type: "require_latest_verification" },
        type: "declarative_gate",
      },
      kind: "hook",
      mode: "gate",
      requested_effects: [],
      schema_version: 1,
    };
    const missing = await hookFixture(hook);
    await expect(missing.runtime.run("completion.before_commit", {}, new AbortController().signal))
      .resolves.toMatchObject({ decision: "deny" });

    const current = await hookFixture(hook, {
      ...baseFacts(),
      currentVerifications: [{
        command: "pnpm typecheck",
        evidence: ["event:30000000-0000-4000-8000-000000000099", `action:sha256:${"c".repeat(64)}`],
      }],
    });
    const decision = await current.runtime.run(
      "completion.before_commit",
      {},
      new AbortController().signal,
    );
    expect(decision).toMatchObject({ decision: "no_objection" });
    expect(decision.evidence).toContain("event:30000000-0000-4000-8000-000000000099");
  });

  it("records command observers as degraded when no suppression-safe runner is available", async () => {
    const value = await hookFixture({
      component_id: "observer",
      description: "Strict command observer.",
      display_name: "Observer",
      event: "run.terminal",
      failure_policy: "record_degraded",
      handler: {
        argv: [],
        cwd: "plugin_root",
        environment: {},
        executable: "observer.mjs",
        sandbox: "policy_selected",
        type: "command",
      },
      kind: "hook",
      mode: "observe",
      requested_effects: ["process_spawn"],
      schema_version: 1,
    });
    const decision = await value.runtime.run(
      "run.terminal",
      { action: { terminalState: "completed" } },
      new AbortController().signal,
    );
    expect(decision).toMatchObject({ decision: "no_objection" });
    expect(value.events.at(-1)).toMatchObject({
      data: { code: "hook_observer_degraded", effect_state: "none" },
      type: "hook.invocation.failed",
    });
  });

  it("runs a frozen command gate behind an independent approval and persists its strict result", async () => {
    const value = await hookFixture({
      component_id: "observer",
      description: "Strict command gate.",
      display_name: "Gate",
      event: "tool.before_effect",
      failure_policy: "fail_closed",
      handler: {
        argv: [],
        cwd: "plugin_root",
        environment: {},
        executable: "observer.mjs",
        sandbox: "policy_selected",
        type: "command",
      },
      kind: "hook",
      mode: "gate",
      requested_effects: ["process_spawn"],
      schema_version: 1,
    }, baseFacts(), {
      script: "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({schemaVersion:1,decision:'no_objection',evidence:['fixture:checked']})));\n",
    });
    let revalidated = 0;
    const decision = await value.runtime.run(
      "tool.before_effect",
      {
        action: {
          actionKind: "run_command",
          originalActionSha256: "d".repeat(64),
          toolName: "run_command",
        },
        revalidateOriginalAction: async () => {
          revalidated += 1;
          return true;
        },
      },
      new AbortController().signal,
    );
    expect(decision).toMatchObject({ decision: "no_objection" });
    expect(decision.evidence).toContain("fixture:checked");
    expect(decision.evidence?.some((entry) => entry.startsWith("sha256:"))).toBe(true);
    expect(revalidated).toBe(1);
    expect(value.events.map((event) => event.type)).toEqual([
      "hook.matched",
      "hook.invocation.requested",
      "hook.permission.evaluated",
      "hook.approval.requested",
      "hook.approval.decided",
      "hook.invocation.started",
      "hook.invocation.decided",
    ]);
  });

  it("does not spawn a command Hook when its exact action approval is denied", async () => {
    const value = await hookFixture({
      component_id: "observer",
      description: "Strict command gate.",
      display_name: "Gate",
      event: "tool.before_effect",
      failure_policy: "fail_closed",
      handler: {
        argv: [],
        cwd: "plugin_root",
        environment: {},
        executable: "observer.mjs",
        sandbox: "policy_selected",
        type: "command",
      },
      kind: "hook",
      mode: "gate",
      requested_effects: ["process_spawn"],
      schema_version: 1,
    }, baseFacts(), { approval: "denied" });
    await expect(value.runtime.run(
      "tool.before_effect",
      { action: { actionKind: "run_command", originalActionSha256: "e".repeat(64) } },
      new AbortController().signal,
    )).resolves.toMatchObject({ decision: "deny", code: "hook_approval_denied" });
    expect(value.events.some((event) => event.type === "hook.invocation.started")).toBe(false);
    expect(value.events.at(-1)).toMatchObject({
      data: { code: "hook_approval_denied", effect_state: "none" },
      type: "hook.invocation.failed",
    });
  });

  it("fails closed when a before-effect command gate has no original-action revalidation", async () => {
    const value = await hookFixture({
      component_id: "observer",
      description: "Strict command gate.",
      display_name: "Gate",
      event: "tool.before_effect",
      failure_policy: "fail_closed",
      handler: {
        argv: [],
        cwd: "plugin_root",
        environment: {},
        executable: "observer.mjs",
        sandbox: "policy_selected",
        type: "command",
      },
      kind: "hook",
      mode: "gate",
      requested_effects: ["process_spawn"],
      schema_version: 1,
    }, baseFacts(), {
      script: "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({schemaVersion:1,decision:'no_objection'})));\n",
    });

    await expect(value.runtime.run(
      "tool.before_effect",
      { action: { actionKind: "run_command", originalActionSha256: "f".repeat(64) } },
      new AbortController().signal,
    )).resolves.toMatchObject({ decision: "deny", code: "hook_original_action_stale" });
    expect(value.events.at(-1)).toMatchObject({
      data: { code: "hook_original_action_stale", effect_state: "none" },
      type: "hook.invocation.failed",
    });
  });

  it("blocks on strict-output failure after spawn because the Hook effect is unknown", async () => {
    const value = await hookFixture({
      component_id: "observer",
      description: "Strict command gate.",
      display_name: "Gate",
      event: "tool.before_effect",
      failure_policy: "fail_closed",
      handler: {
        argv: [],
        cwd: "plugin_root",
        environment: {},
        executable: "observer.mjs",
        sandbox: "policy_selected",
        type: "command",
      },
      kind: "hook",
      mode: "gate",
      requested_effects: ["process_spawn"],
      schema_version: 1,
    }, baseFacts(), { script: "process.stdout.write('{not-json');\n" });

    await expect(value.runtime.run(
      "tool.before_effect",
      {
        action: { actionKind: "run_command", originalActionSha256: "1".repeat(64) },
        revalidateOriginalAction: async () => true,
      },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "hook_effect_unknown" });
    expect(value.events.at(-1)).toMatchObject({
      data: { code: "hook_gate_output_invalid", effect_state: "unknown" },
      type: "hook.invocation.failed",
    });
  });

  it("requires verified process-tree cleanup even after a zero exit", async () => {
    const terminate = vi.fn(async () => ({
      detail: "force_failed" as const,
      forced: true,
      verified: false,
    }));
    const value = await hookFixture({
      component_id: "observer",
      description: "Strict command gate.",
      display_name: "Gate",
      event: "tool.before_effect",
      failure_policy: "fail_closed",
      handler: {
        argv: [],
        cwd: "plugin_root",
        environment: {},
        executable: "observer.mjs",
        sandbox: "policy_selected",
        type: "command",
      },
      kind: "hook",
      mode: "gate",
      requested_effects: ["process_spawn"],
      schema_version: 1,
    }, baseFacts(), {
      cleanup: { terminate },
      script: "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({schemaVersion:1,decision:'no_objection'})));\n",
    });

    await expect(value.runtime.run(
      "tool.before_effect",
      {
        action: { actionKind: "run_command", originalActionSha256: "2".repeat(64) },
        revalidateOriginalAction: async () => true,
      },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "hook_effect_unknown" });
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("terminates and blocks a timed-out command Hook", async () => {
    const value = await hookFixture(commandGate(100), baseFacts(), {
      script: "process.stdin.resume(); setInterval(() => undefined, 1000);\n",
    });
    await expect(value.runtime.run(
      "tool.before_effect",
      {
        action: { actionKind: "run_command", originalActionSha256: "3".repeat(64) },
        revalidateOriginalAction: async () => true,
      },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "hook_effect_unknown" });
    expect(value.events.at(-1)).toMatchObject({
      data: { code: "hook_invocation_timeout", effect_state: "unknown" },
      type: "hook.invocation.failed",
    });
  });

  it("terminates and blocks when cancellation arrives after the Hook child starts", async () => {
    const controller = new AbortController();
    const value = await hookFixture(commandGate(), baseFacts(), {
      onEvent: (type) => {
        if (type === "hook.invocation.started") controller.abort();
      },
      script: "process.stdin.resume(); setInterval(() => undefined, 1000);\n",
    });
    await expect(value.runtime.run(
      "tool.before_effect",
      {
        action: { actionKind: "run_command", originalActionSha256: "4".repeat(64) },
        revalidateOriginalAction: async () => true,
      },
      controller.signal,
    )).rejects.toMatchObject({ code: "hook_effect_unknown" });
    expect(value.events.at(-1)).toMatchObject({
      data: { code: "hook_invocation_cancelled", effect_state: "unknown" },
      type: "hook.invocation.failed",
    });
  });

  it("rejects invalid UTF-8 and terminal controls after spawn", async () => {
    for (const script of [
      "process.stdout.write(Buffer.from([255]));\n",
      "process.stdout.write('\\u001b[31m' + JSON.stringify({schemaVersion:1,decision:'no_objection'}));\n",
    ]) {
      const value = await hookFixture(commandGate(), baseFacts(), { script });
      await expect(value.runtime.run(
        "tool.before_effect",
        {
          action: { actionKind: "run_command", originalActionSha256: "5".repeat(64) },
          revalidateOriginalAction: async () => true,
        },
        new AbortController().signal,
      )).rejects.toMatchObject({ code: "hook_effect_unknown" });
      expect(value.events.at(-1)).toMatchObject({
        data: { code: "hook_gate_output_invalid", effect_state: "unknown" },
        type: "hook.invocation.failed",
      });
    }
  });

  it("does not expose ambient credential or proxy variables to a command Hook", async () => {
    const value = await hookFixture(commandGate(), baseFacts(), {
      script: [
        "const forbidden = Object.keys(process.env).filter((name) => /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH|COOKIE|PROXY/i.test(name));",
        "process.stdout.write(JSON.stringify({schemaVersion:1,decision:forbidden.length===0?'no_objection':'deny',...(forbidden.length===0?{evidence:['ambient-env:none']}:{code:'ambient_env_exposed',message:forbidden.join(',')})}));",
      ].join("\n"),
    });
    await expect(value.runtime.run(
      "tool.before_effect",
      {
        action: { actionKind: "run_command", originalActionSha256: "6".repeat(64) },
        revalidateOriginalAction: async () => true,
      },
      new AbortController().signal,
    )).resolves.toMatchObject({ decision: "no_objection", evidence: expect.arrayContaining(["ambient-env:none"]) });
  });
});
