import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PatchPlanner } from "../../src/changes/patch-planner.js";
import { PatchOperationError } from "../../src/changes/patch-types.js";
import { parseUnifiedDiff } from "../../src/changes/unified-diff-parser.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix = "born-phase5-"): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

function createPatch(path: string, contents = "created\n"): string {
  const additions = contents
    .replace(/\n$/u, "")
    .split("\n")
    .map((line) => `+${line}`)
    .join("\n");
  const count = additions.split("\n").length;
  return [
    `diff --git a/${path} b/${path}`,
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${count} @@`,
    additions,
    "",
  ].join("\n");
}

describe("Phase 5 unified diff parser", () => {
  it("parses create, modify, multiple files, and multiple hunks", () => {
    const patch = [
      "diff --git a/src/value.ts b/src/value.ts",
      "--- a/src/value.ts",
      "+++ b/src/value.ts",
      "@@ -1,2 +1,2 @@",
      "-const first = 1;",
      "+const first = 2;",
      " const middle = true;",
      "@@ -4 +4 @@",
      "-const last = 3;",
      "+const last = 4;",
      "diff --git a/src/new.ts b/src/new.ts",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,2 @@",
      "+export const created = true;",
      "+export const count = 2;",
      "",
    ].join("\n");

    const parsed = parseUnifiedDiff(patch);
    expect(parsed).toMatchObject({ addedLines: 4, removedLines: 2 });
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files[0]).toMatchObject({
      hunks: expect.arrayContaining([expect.anything(), expect.anything()]),
      kind: "modify",
      path: "src/value.ts",
    });
    expect(parsed.files[1]).toMatchObject({ kind: "create", path: "src/new.ts" });
  });

  it.each([
    {
      label: "delete",
      patch: [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-old",
        "",
      ].join("\n"),
    },
    {
      label: "rename",
      patch: [
        "diff --git a/a.ts b/b.ts",
        "similarity index 100%",
        "rename from a.ts",
        "rename to b.ts",
        "",
      ].join("\n"),
    },
    {
      label: "binary",
      patch: [
        "diff --git a/a.bin b/a.bin",
        "GIT binary patch",
        "literal 1",
        "A",
        "",
      ].join("\n"),
    },
    {
      label: "mode",
      patch: [
        "diff --git a/a.ts b/a.ts",
        "old mode 100644",
        "new mode 100755",
        "",
      ].join("\n"),
    },
    { label: "empty", patch: "\n" },
    {
      label: "bad hunk count",
      patch: [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,2 +1,1 @@",
        "-old",
        "+new",
        "",
      ].join("\n"),
    },
  ])("rejects unsupported or ambiguous $label patches", ({ patch }) => {
    expect(() => parseUnifiedDiff(patch)).toThrow(PatchOperationError);
  });

  it("enforces the proposal byte and changed-line limits", () => {
    expect(() => parseUnifiedDiff("x".repeat(16 * 1024 + 1))).toThrow(
      expect.objectContaining({ code: "patch_too_large" }),
    );

    const additions = Array.from({ length: 2_001 }, () => "+x").join("\n");
    const oversized = [
      "diff --git a/a.ts b/a.ts",
      "--- /dev/null",
      "+++ b/a.ts",
      "@@ -0,0 +1,2001 @@",
      additions,
      "",
    ].join("\n");
    expect(() => parseUnifiedDiff(oversized)).toThrow(PatchOperationError);
  });
});

describe("Phase 5 patch planner", () => {
  it("binds a deterministic plan to current preimages and simulates all hunks", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "value.ts"), "one\ntwo\nthree\nfour\n", "utf8");
    const patch = [
      "diff --git a/src/value.ts b/src/value.ts",
      "--- a/src/value.ts",
      "+++ b/src/value.ts",
      "@@ -1,2 +1,2 @@",
      " one",
      "-two",
      "+TWO",
      "@@ -4 +4 @@",
      "-four",
      "+FOUR",
      "diff --git a/generated/new.ts b/generated/new.ts",
      "--- /dev/null",
      "+++ b/generated/new.ts",
      "@@ -0,0 +1 @@",
      "+export const ok = true;",
      "",
    ].join("\n");
    const planner = await PatchPlanner.create(root);

    const first = await planner.plan(patch);
    const second = await planner.plan(patch);

    expect(second.planId).toBe(first.planId);
    expect(first.patchSha256).toHaveLength(64);
    expect(first.files.map((file) => file.relativePath)).toEqual([
      "src/value.ts",
      "generated/new.ts",
    ]);
    expect(first.files[0]?.postimage.toString("utf8")).toBe(
      "one\nTWO\nthree\nFOUR\n",
    );
    expect(first.files[1]?.parent.missingDirectories).toEqual([
      join(first.workspaceRealPath, "generated"),
    ]);
  });

  it("rejects context mismatch, case-folded duplicates, escape, and sensitive writes", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "value.ts"), "current\n", "utf8");
    const planner = await PatchPlanner.create(root);
    const mismatch = [
      "diff --git a/value.ts b/value.ts",
      "--- a/value.ts",
      "+++ b/value.ts",
      "@@ -1 +1 @@",
      "-stale",
      "+new",
      "",
    ].join("\n");
    await expect(planner.plan(mismatch)).rejects.toMatchObject({
      code: "patch_context_mismatch",
    });

    const duplicate = `${createPatch("A.ts")}${createPatch("a.ts")}`;
    await expect(planner.plan(duplicate)).rejects.toMatchObject({
      code: "patch_duplicate_target",
    });
    for (const path of ["../outside.ts", ".env.example", ".git/config", "C:/escape.ts"]) {
      await expect(planner.plan(createPatch(path)), path).rejects.toBeInstanceOf(
        PatchOperationError,
      );
    }
  });

  it("rejects symlink parents, invalid UTF-8, NUL, and oversized targets", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory("born-phase5-outside-");
    await symlink(outside, join(root, "escape"), "junction");
    const planner = await PatchPlanner.create(root);
    await expect(planner.plan(createPatch("escape/new.ts"))).rejects.toMatchObject({
      code: "patch_symlink_denied",
    });

    await writeFile(join(root, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    await writeFile(join(root, "nul.txt"), Buffer.from("a\0b\n"));
    await writeFile(join(root, "large.txt"), Buffer.alloc(1024 * 1024 + 1, 65));
    for (const path of ["invalid.txt", "nul.txt", "large.txt"]) {
      const modify = [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n");
      await expect(planner.plan(modify), path).rejects.toBeInstanceOf(
        PatchOperationError,
      );
    }
  });

  it("invalidates approval when a target changes after planning", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "value.ts"), "old\n", "utf8");
    const planner = await PatchPlanner.create(root);
    const patch = [
      "diff --git a/value.ts b/value.ts",
      "--- a/value.ts",
      "+++ b/value.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const plan = await planner.plan(patch);
    await writeFile(join(root, "value.ts"), "external\n", "utf8");

    await expect(planner.revalidate(plan)).rejects.toMatchObject({
      code: "patch_stale",
    });
    await expect(readFile(join(root, "value.ts"), "utf8")).resolves.toBe(
      "external\n",
    );
  });
});
