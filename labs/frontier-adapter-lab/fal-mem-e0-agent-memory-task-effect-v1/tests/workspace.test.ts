import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadMemE0Fixture, type MemE0CaseId } from "../src/fixture.js";
import {
  createMemE0Workspace,
  memE0VerifierEnvironment,
  runMemE0PublicVerifier,
  verifyMemE0WorkspaceFresh,
} from "../src/workspace.js";

const roots: string[] = [];

const exactSources: Readonly<Record<MemE0CaseId, string>> = Object.freeze({
  "mem-e0-output-contract": [
    "export function outputMarker() {",
    "  return \"AURORA_PUBLIC_731\";",
    "}",
    "",
  ].join("\n"),
  "mem-e0-retry-schedule": [
    "export function retrySchedule() {",
    "  return Object.freeze([1739, 4253, 7919]);",
    "}",
    "",
  ].join("\n"),
  "mem-e0-path-convention": [
    "export function generatedOutputPath() {",
    "  return \"generated/public-synthetic/nebula-593/output.mjs\";",
    "}",
    "",
  ].join("\n"),
  "mem-e0-harm-control": [
    "export function harmControlMarker() {",
    "  return \"HARM_PUBLIC_214\";",
    "}",
    "",
  ].join("\n"),
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })
  ));
});

describe("FAL MEM-E0 disposable workspaces", () => {
  it("creates identical public baselines, observes before-fail, and fresh-verifies exact effects", async () => {
    const fixture = await loadMemE0Fixture(resolve("."));
    for (const loadedCase of fixture.cases) {
      const root = await mkdtemp(join(tmpdir(), "fal-mem-e0-workspace-"));
      roots.push(root);
      const workspace = join(root, "workspace");
      const before = await createMemE0Workspace({ loadedCase, workspace });
      expect(before.hiddenVerifier.exitCode).not.toBe(0);
      expect(before.hiddenVerifier.passed).toBe(false);
      await expect(runMemE0PublicVerifier(loadedCase, workspace)).resolves.toMatchObject({
        passed: false,
      });
      expect(before.publicFilePaths).toEqual(
        loadedCase.definition.publicWorkspace.orderedFiles.map((file) => file.path),
      );
      await expect(access(join(workspace, "hidden", "verifier.mjs"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      await writeFile(
        join(
          workspace,
          ...loadedCase.definition.publicWorkspace.targetRelativePath.split("/"),
        ),
        exactSources[loadedCase.definition.caseId],
        "utf8",
      );
      const publicVerifier = await runMemE0PublicVerifier(loadedCase, workspace);
      expect(publicVerifier.passed).toBe(true);
      const fresh = await verifyMemE0WorkspaceFresh(loadedCase, before);
      expect(fresh.fullPass).toBe(true);
      expect(fresh.after.changedPaths).toEqual(
        loadedCase.definition.publicWorkspace.allowedChangedPaths,
      );
      expect(fresh.verifier.implementationRawSha256).toBe(
        loadedCase.definition.hiddenVerifier.implementationRawSha256,
      );
      expect(fresh.verifier.stdoutSha256).toBe(
        loadedCase.definition.hiddenVerifier.successStdoutSha256,
      );
    }
  }, 30_000);

  it("fails closed on a wrong value and on any path outside the exact target", async () => {
    const fixture = await loadMemE0Fixture(resolve("."));
    const loadedCase = fixture.cases[0]!;
    const root = await mkdtemp(join(tmpdir(), "fal-mem-e0-fail-closed-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const before = await createMemE0Workspace({ loadedCase, workspace });
    const target = join(
      workspace,
      ...loadedCase.definition.publicWorkspace.targetRelativePath.split("/"),
    );
    await writeFile(target, [
      "export function outputMarker() {",
      "  return \"GUESSED_PUBLIC_000\";",
      "}",
      "",
    ].join("\n"), "utf8");
    await expect(verifyMemE0WorkspaceFresh(loadedCase, before)).resolves.toMatchObject({
      fullPass: false,
      verifier: { passed: false },
    });
    await writeFile(join(workspace, "extra.txt"), "unexpected\n", "utf8");
    await expect(verifyMemE0WorkspaceFresh(loadedCase, before)).rejects.toThrow(
      /changed paths/u,
    );
  });

  it("never forwards provider credentials or unrelated environment data to verifiers", () => {
    const environment = memE0VerifierEnvironment({
      DEEPSEEK_API_KEY: "deepseek-sentinel",
      OPENAI_API_KEY: "openai-sentinel",
      PATH: "public-path",
      PRIVATE_NOTE: "private-sentinel",
    });
    expect(environment.PATH).toBe("public-path");
    expect(environment).not.toHaveProperty("DEEPSEEK_API_KEY");
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(environment).not.toHaveProperty("PRIVATE_NOTE");
    expect(JSON.stringify(environment)).not.toContain("sentinel");
  });
});
