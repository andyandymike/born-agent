import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { GitRepositoryObservationV1, GitWorktreePort } from "../../src/worktrees/git-worktree-port.js";
import {
  captureOriginBaseline,
  captureOriginBaselineManifest,
  captureWorkspaceSnapshot,
  captureWorkspaceSnapshotManifest,
  type WorkspaceCaptureObservationV1,
} from "../../src/worktrees/workspace-baseline.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function workspaceFixture(prefix = "bornagent-as1.2-scanner-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "README.md"), "BornAgent AS0.2\n", "utf8");
  await writeFile(join(root, "src", "index.ts"), "export const value = 1;\n", "utf8");
  return root;
}

function retainedObservation() {
  let peak = 0;
  const passPeaks = new Map<string, number>();
  let reads = 0;
  let readBytes = 0;
  const observation: WorkspaceCaptureObservationV1 = {
    onPassRetainedPayloadBytes: ({ bytes, pass }) => {
      passPeaks.set(pass, Math.max(passPeaks.get(pass) ?? 0, bytes));
    },
    onPayloadRead: ({ bytes }) => {
      reads += 1;
      readBytes += bytes;
    },
    onRetainedPayloadBytes: (bytes) => { peak = Math.max(peak, bytes); },
  };
  return { observation, read: () => ({ passPeaks, peak, readBytes, reads }) };
}

function fakeGit(root: string): GitWorktreePort {
  const observation: GitRepositoryObservationV1 = Object.freeze({
    commonDir: join(root, ".git"),
    identity: {
      baseCommit: "1".repeat(40),
      gitCommonDirSha256: "2".repeat(64),
      objectFormat: "sha1" as const,
      originRootSha256: "3".repeat(64),
      repositoryId: "4".repeat(64),
      schemaVersion: 1 as const,
    },
    originRoot: root,
    statusBytes: Buffer.alloc(0),
    tracked: [
      { mode: "100644" as const, objectId: "5".repeat(40), path: "README.md" },
      { mode: "100644" as const, objectId: "6".repeat(40), path: "src/index.ts" },
    ],
  });
  const unsupported = async (): Promise<never> => { throw new Error("unused fake Git method"); };
  return {
    addNoCheckout: unsupported,
    list: unsupported,
    lock: unsupported,
    observe: async () => observation,
    remove: unsupported,
    unlock: unsupported,
  };
}

describe("AS1.2 bounded workspace scanner", () => {
  it("keeps snapshot and origin manifest identities byte-identical while verify retains at most one file", async () => {
    const root = await workspaceFixture();
    const snapshotCounters = retainedObservation();
    const snapshot = await captureWorkspaceSnapshot({
      baselineManifestSha256: "e".repeat(64),
      observation: snapshotCounters.observation,
      workspaceId: "72000000-0000-4000-8000-000000000020",
      workspaceRoot: root,
    });
    expect(snapshot.manifest.snapshotSha256).toBe("cfd9e17ac18bc130a098dda3bef3df019c405efd0902f236da5aabe2175377d7");
    expect(snapshotCounters.read()).toMatchObject({ peak: 64, readBytes: 80, reads: 4 });
    expect(snapshotCounters.read().passPeaks.get("snapshot_materialize")).toBe(40);
    expect(snapshotCounters.read().passPeaks.get("snapshot_verify")).toBe(24);

    const manifestCounters = retainedObservation();
    const manifestOnly = await captureWorkspaceSnapshotManifest({
      baselineManifestSha256: "e".repeat(64),
      observation: manifestCounters.observation,
      workspaceId: "72000000-0000-4000-8000-000000000020",
      workspaceRoot: root,
    });
    expect(manifestOnly.manifest).toEqual(snapshot.manifest);
    expect(manifestCounters.read()).toMatchObject({ peak: 24, readBytes: 80, reads: 4 });

    await mkdir(join(root, ".git"));
    const originCounters = retainedObservation();
    const origin = await captureOriginBaseline({ allowDirty: false, git: fakeGit(root), observation: originCounters.observation, originRoot: root });
    const originManifestCounters = retainedObservation();
    const originManifest = await captureOriginBaselineManifest({
      allowDirty: false,
      git: fakeGit(root),
      observation: originManifestCounters.observation,
      originRoot: root,
    });
    expect(originManifest.manifest).toEqual(origin.manifest);
    expect(originManifest.overlay).toBeNull();
    expect(originCounters.read().passPeaks.get("origin")).toBe(40);
    expect(originManifestCounters.read().passPeaks.get("origin")).toBe(24);
  });

  it("rejects total and single-file limits before reading the disallowed payload and checks every accepted payload after read", async () => {
    const root = await workspaceFixture();
    let reads = 0;
    const stages: string[] = [];
    const observation: WorkspaceCaptureObservationV1 = {
      onLimitCheck: ({ stage }) => { if (stage !== undefined) stages.push(stage); },
      onPayloadRead: () => { reads += 1; },
    };
    await expect(captureWorkspaceSnapshot({
      baselineManifestSha256: "e".repeat(64),
      limits: { maxTotalBytes: 20 },
      observation,
      workspaceId: "72000000-0000-4000-8000-000000000020",
      workspaceRoot: root,
    })).rejects.toMatchObject({ code: "worktree_promotion_unsupported" });
    expect(reads).toBe(1);
    expect(stages).toEqual(["pre_read", "post_read", "pre_read"]);

    reads = 0;
    await expect(captureWorkspaceSnapshot({
      baselineManifestSha256: "e".repeat(64),
      limits: { maxFileBytes: 8 },
      observation: { onPayloadRead: () => { reads += 1; } },
      workspaceId: "72000000-0000-4000-8000-000000000020",
      workspaceRoot: root,
    })).rejects.toMatchObject({ code: "worktree_promotion_unsupported" });
    expect(reads).toBe(0);
  });

  it("keeps stale and unsafe entry failures fail-closed without constructing whole-tree base64", async () => {
    const staleRoot = await workspaceFixture();
    let completed = 0;
    await expect(captureWorkspaceSnapshot({
      baselineManifestSha256: "e".repeat(64),
      observation: {
        onPassComplete: async (pass) => {
          if (pass === "snapshot_materialize" && completed === 0) {
            completed += 1;
            await writeFile(join(staleRoot, "README.md"), "BornAgent changed\n", "utf8");
          }
        },
      },
      workspaceId: "72000000-0000-4000-8000-000000000020",
      workspaceRoot: staleRoot,
    })).rejects.toMatchObject({ code: "worktree_identity_stale" });

    const unsafeRoot = await workspaceFixture("bornagent-as1.2-hardlink-");
    await link(join(unsafeRoot, "README.md"), join(unsafeRoot, "README-copy.md"));
    await expect(captureWorkspaceSnapshot({
      baselineManifestSha256: "e".repeat(64),
      workspaceId: "72000000-0000-4000-8000-000000000020",
      workspaceRoot: unsafeRoot,
    })).rejects.toMatchObject({ code: "worktree_promotion_unsupported" });

    const source = await readFile(resolve("src/worktrees/workspace-baseline.ts"), "utf8");
    expect(source).not.toContain('bytes.toString("base64")');
    expect(sha256("BornAgent AS0.2\n")).toHaveLength(64);
  });
});
