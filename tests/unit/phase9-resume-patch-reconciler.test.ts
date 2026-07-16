import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  reconcilePendingPatch,
  reconcilePendingPatchFromReader,
  type PatchFileObservation,
} from "../../src/resume/patch-reconciler.js";
import type { PendingPatchEffect } from "../../src/resume/resume-types.js";
import { WorkspacePatchObservationReader } from "../../src/resume/workspace-patch-observation-reader.js";

const PRE_A = "a".repeat(64);
const POST_A = "b".repeat(64);
const PRE_B = "c".repeat(64);
const POST_B = "d".repeat(64);
const THIRD = "e".repeat(64);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

function effect(
  overrides: Partial<PendingPatchEffect> = {},
): PendingPatchEffect {
  return {
    approvalRequestId: "30000000-0000-4000-8000-000000000001",
    callId: "call-patch",
    files: [
      {
        kind: "modify",
        path: "src/a.ts",
        postSha256: POST_A,
        preSha256: PRE_A,
      },
      {
        kind: "modify",
        path: "src/b.ts",
        postSha256: POST_B,
        preSha256: PRE_B,
      },
    ],
    planId: "f".repeat(64),
    sourceRunId: "20000000-0000-4000-8000-000000000001",
    step: 1,
    ...overrides,
  };
}

function file(path: string, bytesSha256: string): PatchFileObservation {
  return { bytesSha256, kind: "file", path };
}

describe("Phase 9 patch reconciliation", () => {
  it("classifies all-pre as not applied and all-post as applied", () => {
    const allPre = reconcilePendingPatch(effect(), [
      file("src/a.ts", PRE_A),
      file("src/b.ts", PRE_B),
    ]);
    const allPost = reconcilePendingPatch(effect(), [
      file("src/a.ts", POST_A),
      file("src/b.ts", POST_B),
    ]);

    expect(allPre).toMatchObject({
      observed: "not_applied",
      status: "reconciled",
    });
    expect(allPost).toMatchObject({
      observed: "applied",
      status: "reconciled",
    });
    if (allPost.status === "reconciled") {
      expect(allPost.files).toEqual([
        expect.objectContaining({ path: "src/a.ts", postSha256: POST_A }),
        expect.objectContaining({ path: "src/b.ts", postSha256: POST_B }),
      ]);
    }
  });

  it("blocks mixed and third-party bytes", () => {
    expect(
      reconcilePendingPatch(effect(), [
        file("src/a.ts", PRE_A),
        file("src/b.ts", POST_B),
      ]),
    ).toMatchObject({ reason: "mixed_state", status: "blocked" });
    expect(
      reconcilePendingPatch(effect(), [
        file("src/a.ts", THIRD),
        file("src/b.ts", PRE_B),
      ]),
    ).toMatchObject({ reason: "third_state", status: "blocked" });
  });

  it("treats missing as pre-state only for a create", () => {
    const create = effect({
      files: [
        {
          kind: "create",
          path: "src/new.ts",
          postSha256: POST_A,
          preSha256: null,
        },
      ],
    });
    const modify = effect({ files: effect().files.slice(0, 1) });

    expect(
      reconcilePendingPatch(create, [{ kind: "missing", path: "src/new.ts" }]),
    ).toMatchObject({ observed: "not_applied", status: "reconciled" });
    expect(
      reconcilePendingPatch(modify, [{ kind: "missing", path: "src/a.ts" }]),
    ).toMatchObject({ reason: "missing_target", status: "blocked" });
  });

  it.each([
    ["symlink", "symlink_target"],
    ["unreadable", "unreadable_target"],
    ["other", "unsupported_target"],
  ] as const)("blocks a %s target", (kind, reason) => {
    const oneFile = effect({ files: effect().files.slice(0, 1) });
    expect(
      reconcilePendingPatch(oneFile, [{ kind, path: "src/a.ts" }]),
    ).toMatchObject({ reason, status: "blocked" });
  });

  it("blocks legacy starts without predicted postimage hashes", () => {
    const legacy = effect({
      files: [
        {
          kind: "modify",
          path: "src/a.ts",
          postSha256: null,
          preSha256: PRE_A,
        },
      ],
    });
    expect(reconcilePendingPatch(legacy, [file("src/a.ts", PRE_A)])).toMatchObject(
      { reason: "missing_postimage_hash", status: "blocked" },
    );
  });

  it("uses an injected read-only observer without filesystem mutation", async () => {
    const calls: string[] = [];
    const result = await reconcilePendingPatchFromReader(effect(), {
      observe: async (path) => {
        calls.push(path);
        return file(path, path.endsWith("a.ts") ? POST_A : POST_B);
      },
    });
    expect(calls).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result).toMatchObject({ observed: "applied", status: "reconciled" });
  });

  it("observes current workspace bytes through the mutation path boundary", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bornagent-phase9-reconcile-"));
    temporaryDirectories.push(workspace);
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", "a.ts"), "current bytes", "utf8");
    const reader = await WorkspacePatchObservationReader.create(workspace, {
      caseInsensitive: process.platform === "win32",
    });

    await expect(reader.observe("src/a.ts")).resolves.toEqual({
      bytesSha256: createHash("sha256").update("current bytes").digest("hex"),
      kind: "file",
      path: "src/a.ts",
    });
    await expect(reader.observe("src/new.ts")).resolves.toEqual({
      kind: "missing",
      path: "src/new.ts",
    });
    await expect(reader.observe("../outside.ts")).resolves.toEqual({
      kind: "unreadable",
      path: "../outside.ts",
    });
  });
});
