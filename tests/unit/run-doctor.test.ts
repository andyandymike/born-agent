import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runDoctor } from "../../src/doctor/run-doctor.js";
import type { CliRuntime } from "../../src/cli/types.js";
import { createRuntime } from "../helpers.js";

function findCheck(report: Awaited<ReturnType<typeof runDoctor>>, name: string) {
  const check = report.checks.find((candidate) => candidate.name === name);
  if (!check) {
    throw new Error(`missing ${name} check`);
  }
  return check;
}

describe("runDoctor", () => {
  it("accepts a supported Node.js version", async () => {
    const report = await runDoctor(createRuntime({ nodeVersion: "22.19.0" }));
    expect(findCheck(report, "Node.js")).toMatchObject({ ok: true });
  });

  it("rejects an older Node.js version", async () => {
    const report = await runDoctor(createRuntime({ nodeVersion: "22.18.9" }));
    expect(findCheck(report, "Node.js")).toMatchObject({
      detail: expect.stringContaining("v22.19.0+ required"),
      ok: false,
    });
  });

  it("reports Git when its executable exists", async () => {
    const report = await runDoctor(createRuntime());
    expect(findCheck(report, "Git")).toEqual({
      detail: "git version 2.30.0.windows.2",
      name: "Git",
      ok: true,
    });
  });

  it("reports install hints when Git is missing", async () => {
    const runtime = createRuntime({
      runExecutable: async (command, args, timeout) =>
        command === "git"
          ? { kind: "missing" }
          : createRuntime().runExecutable(command, args, timeout),
    });
    const report = await runDoctor(runtime);
    const check = findCheck(report, "Git");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("Windows");
    expect(check.detail).toContain("macOS");
    expect(check.detail).toContain("Linux");
  });

  it("reports a ripgrep timeout", async () => {
    const fallback = createRuntime().runExecutable;
    const runtime = createRuntime({
      runExecutable: async (command, args, timeout) =>
        command === "rg"
          ? { kind: "timeout" }
          : fallback(command, args, timeout),
    });
    const report = await runDoctor(runtime);
    expect(findCheck(report, "ripgrep")).toMatchObject({
      detail: expect.stringContaining("3000 ms"),
      ok: false,
    });
  });

  it("reports an unreadable workspace and still runs every check", async () => {
    const commands: string[] = [];
    const fallback = createRuntime().runExecutable;
    const runtime: CliRuntime = createRuntime({
      isReadableDirectory: async () => false,
      runExecutable: async (command, args, timeout) => {
        commands.push(command);
        return fallback(command, args, timeout);
      },
    });
    const report = await runDoctor(runtime);
    expect(findCheck(report, "Workspace")).toMatchObject({ ok: false });
    expect(commands).toEqual(["git", "rg", "ollama"]);
    expect(report.checks).toHaveLength(9);
  });

  it("does not read a remote credential when local-free denies the request", async () => {
    const secret = "sk-doctor-secret";
    let credentialReads = 0;
    const environment = new Proxy(
      { BORN_PROVIDER: "openai", OPENAI_API_KEY: secret },
      {
        get(target, property, receiver) {
          if (property === "OPENAI_API_KEY") credentialReads += 1;
          return Reflect.get(target, property, receiver) as string | undefined;
        },
      },
    );
    const report = await runDoctor(createRuntime({ env: environment }));

    expect(findCheck(report, "Provider")).toMatchObject({
      detail: expect.stringContaining("disabled_by_policy"),
      ok: false,
    });
    expect(findCheck(report, "Credential access")).toEqual({
      detail: "not_read (request disabled_by_policy)",
      name: "Credential access",
      ok: true,
    });
    expect(credentialReads).toBe(0);
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("checks only the provider credential allowed by an explicit remote profile", async () => {
    const secret = "anthropic-doctor-sentinel";
    const directory = await mkdtemp(join(tmpdir(), "bornagent-doctor-policy-"));
    const policyConfig = join(directory, "policy.json");
    try {
      await writeFile(
        policyConfig,
        JSON.stringify({
          schema_version: 1,
          profiles: [
            {
              schema_version: 1,
              id: "remote-anthropic-contract",
              mode: "remote_explicit",
              model_access: {
                kind: "remote_explicit",
                providers: [
                  {
                    provider: "anthropic",
                    models: ["claude-contract-v1"],
                    base_urls: ["https://api.anthropic.com"],
                  },
                ],
                credential_access: "selected_provider_only",
                limits: {
                  max_provider_requests_per_run: 1,
                  max_output_tokens_per_request: 128,
                  max_reported_total_tokens_per_run: 1_000,
                },
              },
              eval_access: {
                allowed_suites: ["targeted"],
                max_attempts_per_run: 1,
              },
              docker_acquisition: { kind: "deny" },
            },
          ],
        }),
        "utf8",
      );
      const report = await runDoctor(
        createRuntime({
          cwd: process.cwd(),
          env: { ANTHROPIC_API_KEY: secret },
        }),
        {
          model: "claude-contract-v1",
          policyConfig,
          policyProfile: "remote-anthropic-contract",
          provider: "anthropic",
        },
      );
      expect(findCheck(report, "Anthropic credential")).toMatchObject({
        detail: "configured",
        ok: true,
      });
      expect(JSON.stringify(report)).not.toContain(secret);
      expect(
        report.checks.some((check) => check.name === "Ollama service"),
      ).toBe(false);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("shows the exact profile model and rejects a blank override", async () => {
    const selected = await runDoctor(
      createRuntime({
        env: {
          BORN_MODEL: "qwen3:1.7b",
          BORN_PROVIDER: "ollama",
        },
      }),
    );
    const blank = await runDoctor(
      createRuntime({
        env: {
          BORN_MODEL: "   ",
          BORN_PROVIDER: "ollama",
        },
      }),
    );
    expect(findCheck(selected, "Model")).toMatchObject({
      detail: "qwen3:1.7b",
      ok: true,
    });
    expect(findCheck(blank, "Provider")).toMatchObject({
      detail: expect.stringContaining("policy_model_denied"),
      ok: false,
    });
    expect(findCheck(blank, "Credential access").detail).toContain("not_read");
  });

  it("checks the Ollama service and selected local model", async () => {
    const fallback = createRuntime().runExecutable;
    const report = await runDoctor(
      createRuntime({
        env: { BORN_MODEL: "qwen3:1.7b", BORN_PROVIDER: "ollama" },
        runExecutable: async (command, args, timeout) =>
          command === "ollama"
            ? {
                kind: "completed",
                exitCode: 0,
                stderr: "",
                stdout:
                  "NAME        ID      SIZE\nqwen3:1.7b  abc123  1.4 GB\n",
              }
            : fallback(command, args, timeout),
      }),
    );

    expect(findCheck(report, "Provider")).toEqual({
      detail: "ollama (enabled_by_policy)",
      name: "Provider",
      ok: true,
    });
    expect(findCheck(report, "Ollama service")).toMatchObject({ ok: true });
    expect(findCheck(report, "Model")).toMatchObject({
      detail: "qwen3:1.7b",
      ok: true,
    });
    expect(
      report.checks.some((check) => check.name === "OpenAI credential"),
    ).toBe(false);
  });

  it("reports a missing profile model without automatically pulling it", async () => {
    const fallback = createRuntime().runExecutable;
    const report = await runDoctor(
      createRuntime({
        env: { BORN_PROVIDER: "ollama" },
        runExecutable: async (command, args, timeout) =>
          command === "ollama"
            ? {
                kind: "completed",
                exitCode: 0,
                stderr: "",
                stdout:
                  "NAME      ID      SIZE\nqwen3:8b  abc123  4.9 GB\n",
              }
            : fallback(command, args, timeout),
      }),
    );

    expect(findCheck(report, "Model")).toMatchObject({
      detail: expect.stringContaining("ollama pull qwen3:1.7b"),
      ok: false,
    });
    expect(findCheck(report, "Model").detail).toContain("Automatic model pull is disabled");
  });
});
