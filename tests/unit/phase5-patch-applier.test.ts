import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AtomicPatchApplier,
  type AtomicPatchFileSystem,
} from "../../src/changes/patch-applier.js";
import { PatchPlanner } from "../../src/changes/patch-planner.js";
import { PatchOperationError } from "../../src/changes/patch-types.js";
import { renderRunLocalDiff } from "../../src/changes/git-diff-renderer.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "born-phase5-apply-"));
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

function modifyPatch(path: string, oldValue: string, newValue: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    `-${oldValue}`,
    `+${newValue}`,
    "",
  ].join("\n");
}

function createPatch(path: string, value: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    "--- /dev/null",
    `+++ b/${path}`,
    "@@ -0,0 +1 @@",
    `+${value}`,
    "",
  ].join("\n");
}

function realFileSystem(
  renameOverride?: (oldPath: string, newPath: string) => Promise<void>,
  linkOverride?: (oldPath: string, newPath: string) => Promise<void>,
): AtomicPatchFileSystem {
  return {
    lstat,
    link: linkOverride ?? link,
    async mkdir(path) {
      await mkdir(path);
    },
    open,
    readFile,
    rename: renameOverride ?? rename,
    rmdir,
    unlink,
  };
}

describe("Phase 5 atomic patch applier", () => {
  it("applies create and modify as one batch and journals only run-local changes", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "value.ts"), "old\n", "utf8");
    await writeFile(join(root, "user-dirty.txt"), "keep my edit\n", "utf8");
    const patch = `${modifyPatch("src/value.ts", "old", "new")}${createPatch(
      "generated/result.ts",
      "export const result = true;",
    )}`;
    const planner = await PatchPlanner.create(root);
    const plan = await planner.plan(patch);
    let id = 0;
    const applier = new AtomicPatchApplier({
      now: () => new Date("2026-07-17T00:00:00.000Z"),
      planner,
      randomId: () => `test-${(id += 1)}`,
    });

    const result = await applier.apply(plan, new AbortController().signal);

    await expect(readFile(join(root, "src", "value.ts"), "utf8")).resolves.toBe(
      "new\n",
    );
    await expect(
      readFile(join(root, "generated", "result.ts"), "utf8"),
    ).resolves.toBe("export const result = true;\n");
    await expect(readFile(join(root, "user-dirty.txt"), "utf8")).resolves.toBe(
      "keep my edit\n",
    );
    expect(result).toMatchObject({
      appliedAt: "2026-07-17T00:00:00.000Z",
      planId: plan.planId,
    });
    expect(applier.journal.changedPaths()).toEqual([
      "src/value.ts",
      "generated/result.ts",
    ]);
    const rendered = renderRunLocalDiff(applier.journal.entries());
    expect(rendered.text).toContain("-old");
    expect(rendered.text).not.toContain("keep my edit");
    expect((await readdir(root, { recursive: true })).join("\n")).not.toContain(
      ".bornagent-",
    );
  });

  it("rejects stale approval before producing any mutation", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "first.ts"), "first\n", "utf8");
    await writeFile(join(root, "second.ts"), "second\n", "utf8");
    const planner = await PatchPlanner.create(root);
    const plan = await planner.plan(
      `${modifyPatch("first.ts", "first", "FIRST")}${modifyPatch(
        "second.ts",
        "second",
        "SECOND",
      )}`,
    );
    await writeFile(join(root, "second.ts"), "external\n", "utf8");
    const applier = new AtomicPatchApplier({ planner });

    await expect(
      applier.apply(plan, new AbortController().signal),
    ).rejects.toMatchObject({ code: "patch_stale", state: "unchanged" });
    await expect(readFile(join(root, "first.ts"), "utf8")).resolves.toBe(
      "first\n",
    );
    await expect(readFile(join(root, "second.ts"), "utf8")).resolves.toBe(
      "external\n",
    );
    expect(applier.journal.entries()).toEqual([]);
  });

  it("rolls back every target when a later install fails", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "first.ts"), "first\n", "utf8");
    await writeFile(join(root, "second.ts"), "second\n", "utf8");
    const planner = await PatchPlanner.create(root);
    const plan = await planner.plan(
      `${modifyPatch("first.ts", "first", "FIRST")}${modifyPatch(
        "second.ts",
        "second",
        "SECOND",
      )}`,
    );
    let linkCalls = 0;
    const fileSystem = realFileSystem(undefined, async (oldPath, newPath) => {
      linkCalls += 1;
      if (linkCalls === 2) {
        throw new Error("injected second install failure");
      }
      await link(oldPath, newPath);
    });
    let id = 0;
    const applier = new AtomicPatchApplier({
      fileSystem,
      planner,
      randomId: () => `rollback-${(id += 1)}`,
    });

    await expect(
      applier.apply(plan, new AbortController().signal),
    ).rejects.toMatchObject({ code: "patch_apply_failed", state: "unchanged" });
    await expect(readFile(join(root, "first.ts"), "utf8")).resolves.toBe(
      "first\n",
    );
    await expect(readFile(join(root, "second.ts"), "utf8")).resolves.toBe(
      "second\n",
    );
    expect((await readdir(root)).join("\n")).not.toContain(".bornagent-");
  });

  it("does not overwrite an external concurrent edit when rollback is ambiguous", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "first.ts"), "first\n", "utf8");
    await writeFile(join(root, "second.ts"), "second\n", "utf8");
    const planner = await PatchPlanner.create(root);
    const plan = await planner.plan(
      `${modifyPatch("first.ts", "first", "FIRST")}${modifyPatch(
        "second.ts",
        "second",
        "SECOND",
      )}`,
    );
    let linkCalls = 0;
    const fileSystem = realFileSystem(undefined, async (oldPath, newPath) => {
      linkCalls += 1;
      await link(oldPath, newPath);
      if (linkCalls === 2) {
        await writeFile(newPath, "external concurrent edit\n", "utf8");
        throw new Error("injected race after no-replace install");
      }
    });
    let id = 0;
    const applier = new AtomicPatchApplier({
      fileSystem,
      planner,
      randomId: () => `ambiguous-${(id += 1)}`,
    });

    await expect(
      applier.apply(plan, new AbortController().signal),
    ).rejects.toMatchObject({ code: "ambiguous_patch_state", state: "unknown" });
    await expect(readFile(join(root, "first.ts"), "utf8")).resolves.toBe(
      "first\n",
    );
    await expect(readFile(join(root, "second.ts"), "utf8")).resolves.toBe(
      "external concurrent edit\n",
    );
  });

  it("uses no-replace installation when a target reappears", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "first.ts"), "first\n", "utf8");
    await writeFile(join(root, "second.ts"), "second\n", "utf8");
    const planner = await PatchPlanner.create(root);
    const plan = await planner.plan(
      `${modifyPatch("first.ts", "first", "FIRST")}${modifyPatch(
        "second.ts",
        "second",
        "SECOND",
      )}`,
    );
    let linkCalls = 0;
    const fileSystem = realFileSystem(undefined, async (oldPath, newPath) => {
      linkCalls += 1;
      if (linkCalls === 2) {
        await writeFile(newPath, "external winner\n", "utf8");
      }
      await link(oldPath, newPath);
    });
    let id = 0;
    const applier = new AtomicPatchApplier({
      fileSystem,
      planner,
      randomId: () => `no-replace-${(id += 1)}`,
    });

    await expect(
      applier.apply(plan, new AbortController().signal),
    ).rejects.toMatchObject({ code: "ambiguous_patch_state", state: "unknown" });
    await expect(readFile(join(root, "first.ts"), "utf8")).resolves.toBe(
      "first\n",
    );
    await expect(readFile(join(root, "second.ts"), "utf8")).resolves.toBe(
      "external winner\n",
    );
  });

  it("does not apply a partially valid proposal and honors cancellation", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "first.ts"), "first\n", "utf8");
    await writeFile(join(root, "second.ts"), "second\n", "utf8");
    const planner = await PatchPlanner.create(root);
    const proposal = `${modifyPatch("first.ts", "first", "FIRST")}${modifyPatch(
      "second.ts",
      "wrong context",
      "SECOND",
    )}`;
    await expect(planner.plan(proposal)).rejects.toBeInstanceOf(PatchOperationError);
    await expect(readFile(join(root, "first.ts"), "utf8")).resolves.toBe(
      "first\n",
    );

    const plan = await planner.plan(modifyPatch("first.ts", "first", "FIRST"));
    const controller = new AbortController();
    controller.abort();
    const applier = new AtomicPatchApplier({ planner });
    await expect(applier.apply(plan, controller.signal)).rejects.toMatchObject({
      code: "patch_cancelled",
    });
    await expect(readFile(join(root, "first.ts"), "utf8")).resolves.toBe(
      "first\n",
    );
  });
});
