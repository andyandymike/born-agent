import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Ds0ExactSmokeApprovalPrompt } from "../src/exact-smoke-approval.js";
import {
  createDs0SubprocessEnvironment,
  createDs0PublicSmokeWorkspace,
  DS0_PUBLIC_SMOKE_FIXED_SOURCE,
  DS0_PUBLIC_SMOKE_TARGET,
  verifyDs0PublicSmokeWorkspace,
} from "../src/public-smoke-workspace.js";
import { writeFile } from "node:fs/promises";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })
  ));
});

describe("FAL DS0 public coding smoke boundary", () => {
  it("never forwards provider credentials to direct Git or verifier subprocesses", () => {
    const environment = createDs0SubprocessEnvironment({
      ANTHROPIC_API_KEY: "anthropic-sentinel",
      DEEPSEEK_API_KEY: "deepseek-sentinel",
      OPENAI_API_KEY: "openai-sentinel",
      PATH: "public-path",
    });
    expect(environment.PATH).toBe("public-path");
    expect(environment).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(environment).not.toHaveProperty("DEEPSEEK_API_KEY");
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(JSON.stringify(environment)).not.toContain("sentinel");
  });

  it("creates the reviewed buggy workspace and fresh-verifies only the exact fix", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "fal-ds0-public-smoke-"));
    roots.push(workspace);
    const created = await createDs0PublicSmokeWorkspace({
      repositoryRoot: resolve("."),
      workspace,
    });
    expect(created.baselineCommit).toMatch(/^[a-f0-9]{40}$/u);

    await writeFile(
      join(workspace, ...DS0_PUBLIC_SMOKE_TARGET.split("/")),
      DS0_PUBLIC_SMOKE_FIXED_SOURCE,
      "utf8",
    );
    await expect(verifyDs0PublicSmokeWorkspace(workspace)).resolves.toMatchObject({
      changedPaths: [DS0_PUBLIC_SMOKE_TARGET],
      verifierExitCode: 0,
    });

    await writeFile(join(workspace, "extra.txt"), "unexpected\n", "utf8");
    await expect(verifyDs0PublicSmokeWorkspace(workspace)).rejects.toThrow(
      /changed paths/u,
    );
  });

  it("approves only one bounded target patch and the exact verifier argv", async () => {
    const prompt = new Ds0ExactSmokeApprovalPrompt();
    const signal = new AbortController().signal;
    await expect(prompt.request({
      actionKind: "apply_patch",
      addedLines: 1,
      paths: [{ kind: "modify", path: DS0_PUBLIC_SMOKE_TARGET }],
      planId: "p".repeat(64),
      preview: "exact fix",
      previewTruncated: false,
      removedLines: 1,
    }, signal)).resolves.toBe("approved");
    await expect(prompt.request({
      actionKind: "run_command",
      actionSha256: "a".repeat(64),
      args: ["verify.mjs"],
      cwd: "fixtures/phase-07-fix-and-verify",
      executable: "node",
      executor: "local",
      purpose: "verify",
      reviewLines: [],
      riskWarning: "bounded public fixture",
    }, signal)).resolves.toBe("approved");
    await expect(prompt.request({
      actionKind: "run_command",
      actionSha256: "b".repeat(64),
      args: ["-e", "process.exit(0)"],
      cwd: ".",
      executable: "node",
      executor: "local",
      purpose: "verify",
      reviewLines: [],
      riskWarning: "wrong command",
    }, signal)).resolves.toBe("denied");
  });
});
