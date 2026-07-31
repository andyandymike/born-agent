import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { UserStateModelQualificationGate } from "../../src/model/user-state-model-qualification-gate.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function fixture(): Promise<{
  readonly policyPath: string;
  readonly state: string;
  readonly workspace: string;
}> {
  const workspace = await mkdtemp(join(tmpdir(), "bornagent-phase16e-remote-workspace-"));
  const state = await mkdtemp(join(tmpdir(), "bornagent-phase16e-remote-state-"));
  const config = await mkdtemp(join(tmpdir(), "bornagent-phase16e-remote-config-"));
  roots.push(workspace, state, config);
  const policyPath = join(config, "policy.json");
  await writeFile(
    policyPath,
    JSON.stringify({
      profiles: [
        {
          docker_acquisition: { kind: "deny" },
          eval_access: { allowed_suites: ["targeted", "smoke"], max_attempts_per_run: 1 },
          id: "remote-openai-qualification",
          mode: "remote_explicit",
          model_access: {
            credential_access: "selected_provider_only",
            kind: "remote_explicit",
            limits: {
              max_output_tokens_per_request: 256,
              max_provider_requests_per_run: 6,
              max_reported_total_tokens_per_run: 2_000,
            },
            providers: [
              {
                base_urls: ["https://api.openai.com/v1"],
                models: ["gpt-5.6-terra"],
                provider: "openai",
              },
            ],
          },
          schema_version: 1,
        },
      ],
      schema_version: 1,
    }),
    "utf8",
  );
  return { policyPath, state, workspace };
}

describe("Phase 16E remote zero-live boundary", () => {
  it("requires exact request consent before credential/backend access", async () => {
    const { policyPath, state, workspace } = await fixture();
    const secret = "sk-must-not-be-read-or-rendered";
    const createModelBackend = vi.fn(() => {
      throw new Error("remote backend must not be constructed");
    });
    const refreshLocalModelCatalog = vi.fn(async () => []);
    const env = { LOCALAPPDATA: state, OPENAI_API_KEY: secret };
    const runtime = createRuntime({
      createModelBackend,
      cwd: workspace,
      env,
      refreshLocalModelCatalog,
    });
    const memory = createMemoryIO();
    expect(
      await runCli(
        [
          "models",
          "qualify",
          "--provider",
          "openai",
          "--model",
          "gpt-5.6-terra",
          "--policy-profile",
          "remote-openai-qualification",
          "--policy-config",
          policyPath,
        ],
        memory.io,
        runtime,
      ),
    ).toBe(2);
    expect(memory.readStderr()).toContain("--confirm-remote-requests 6");
    expect(`${memory.readStdout()}${memory.readStderr()}`).not.toContain(secret);
    expect(createModelBackend).not.toHaveBeenCalled();
    expect(refreshLocalModelCatalog).not.toHaveBeenCalled();
  });

  it("rejects a normal remote run with no record before backend access", async () => {
    const { policyPath, state, workspace } = await fixture();
    const createModelBackend = vi.fn(() => {
      throw new Error("remote backend must not be constructed");
    });
    const refreshLocalModelCatalog = vi.fn(async () => []);
    const env = { LOCALAPPDATA: state, OPENAI_API_KEY: "sk-sentinel" };
    const runtime = createRuntime({
      createModelBackend,
      createSessionWriter: V2SessionWriter.create,
      cwd: workspace,
      env,
      modelQualificationGate: new UserStateModelQualificationGate({
        env,
        platform: "win32",
        refreshLocalModelCatalog,
      }),
      refreshLocalModelCatalog,
    });
    const memory = createMemoryIO();
    expect(
      await runCli(
        [
          "agent",
          "No paid request",
          "--mode",
          "plan",
          "--provider",
          "openai",
          "--model",
          "gpt-5.6-terra",
          "--policy-profile",
          "remote-openai-qualification",
          "--policy-config",
          policyPath,
        ],
        memory.io,
        runtime,
      ),
    ).toBe(2);
    expect(memory.readStderr()).toContain("model_unqualified");
    expect(createModelBackend).not.toHaveBeenCalled();
    expect(refreshLocalModelCatalog).not.toHaveBeenCalled();
  });
});
