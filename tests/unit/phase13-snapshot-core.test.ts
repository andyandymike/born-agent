import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  filterSnapshotEntry,
  SnapshotPolicyError,
} from "../../src/execution/snapshot/snapshot-filter.js";
import {
  createSnapshotManifest,
  resolveSnapshotLimits,
} from "../../src/execution/snapshot/snapshot-manifest.js";
import {
  planSnapshotEntries,
  WorkspaceSnapshotPlanner,
  type SnapshotSourceEntry,
  type WorkspaceSnapshotPlanningAdapter,
} from "../../src/execution/snapshot/workspace-snapshot-planner.js";
import {
  WorkspaceSnapshotter,
  type SnapshotSinkAdapter,
  type SnapshotSinkHandle,
  type SnapshotSourceAdapter,
} from "../../src/execution/snapshot/workspace-snapshotter.js";

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function file(
  relativePath: string,
  content: string,
  overrides: Partial<SnapshotSourceEntry> = {},
): SnapshotSourceEntry {
  return {
    bytes: Buffer.byteLength(content, "utf8"),
    contentSha256: digest(content),
    ignored: false,
    kind: "file",
    mode: "regular",
    relativePath,
    tracked: true,
    ...overrides,
  };
}

describe("Phase 13 snapshot filter and manifest", () => {
  it("includes tracked/current/untracked files and records only omission categories", () => {
    const sourceStateSha256 = "1".repeat(64);
    const plan = planSnapshotEntries({
      entries: [
        file("src/current.ts", "changed working tree bytes"),
        file("notes/new.txt", "untracked", { tracked: false }),
        file(".bornagent/sessions/private.jsonl", "session"),
        file("config/.env.local", "provider key"),
        file("node_modules/pkg/index.js", "cache"),
        file("ignored.log", "ignored", { ignored: true }),
      ],
      sourceStateSha256,
    });

    expect(plan.entries.map(({ path, tracked }) => ({ path, tracked }))).toEqual([
      { path: "notes/new.txt", tracked: false },
      { path: "src/current.ts", tracked: true },
    ]);
    expect(plan.manifest.omitted).toEqual([
      { category: "host_cache", count: 1 },
      { category: "ignored", count: 1 },
      { category: "internal_state", count: 1 },
      { category: "sensitive_path", count: 1 },
    ]);
    expect(JSON.stringify(plan.manifest)).not.toContain("provider key");
    expect(JSON.stringify(plan.manifest)).not.toContain(".env.local");
  });

  it("rejects traversal, Unicode ambiguity, special files, and case collisions", () => {
    expect(() =>
      filterSnapshotEntry({
        ignored: false,
        kind: "file",
        relativePath: "../outside.txt",
      }),
    ).toThrow("dot");
    expect(() =>
      filterSnapshotEntry({
        ignored: false,
        kind: "symlink",
        relativePath: "src/link",
      }),
    ).toThrow("refuses symlink");
    expect(() =>
      filterSnapshotEntry({
        ignored: false,
        kind: "file",
        relativePath: "cafe\u0301.txt",
      }),
    ).toThrow("normalized portable");
    expect(() =>
      createSnapshotManifest({
        entries: [
          { bytes: 1, mode: "regular", path: "src/A.ts", sha256: digest("a") },
          { bytes: 1, mode: "regular", path: "src/a.ts", sha256: digest("b") },
        ],
      }),
    ).toThrow("case-insensitive path collision");
  });

  it("hashes sorted manifests deterministically and enforces hard ceilings", () => {
    const left = createSnapshotManifest({
      entries: [
        { bytes: 1, mode: "regular", path: "b.txt", sha256: digest("b") },
        { bytes: 1, mode: "executable", path: "a.sh", sha256: digest("a") },
      ],
      omitted: [{ category: "ignored", count: 2 }],
    });
    const right = createSnapshotManifest({
      entries: [...left.entries].reverse(),
      omitted: [{ category: "ignored", count: 2 }],
    });
    expect(right.sha256).toBe(left.sha256);
    expect(right.entries.map(({ path }) => path)).toEqual(["a.sh", "b.txt"]);
    expect(() =>
      createSnapshotManifest({
        entries: [
          { bytes: 2, mode: "regular", path: "large", sha256: digest("xx") },
        ],
        limits: { maxFileBytes: 1, maxTotalBytes: 2 },
      }),
    ).toThrow("per-file limit");
    expect(() =>
      resolveSnapshotLimits({ maxTotalBytes: 1024 * 1024 * 1024 + 1 }),
    ).toThrow("hard policy limit");
  });

  it("fails planning when source state changes around enumeration", async () => {
    let digestRead = 0;
    const adapter: WorkspaceSnapshotPlanningAdapter = {
      enumerateSourceEntries: async () => [file("src/a.ts", "a")],
      readSourceStateSha256: async () =>
        (digestRead++ === 0 ? "1" : "2").repeat(64),
    };
    await expect(new WorkspaceSnapshotPlanner(adapter).plan()).rejects.toThrow(
      "workspace changed while planning",
    );
  });
});

class MemorySource implements SnapshotSourceAdapter {
  readonly bytes = new Map<string, Uint8Array>();
  stateSha256 = "3".repeat(64);

  public constructor(readonly entries: readonly SnapshotSourceEntry[]) {}

  async enumerateSourceEntries(): Promise<readonly SnapshotSourceEntry[]> {
    return this.entries;
  }

  async readFile(relativePath: string): Promise<Uint8Array> {
    const bytes = this.bytes.get(relativePath);
    if (bytes === undefined) throw new Error("missing fake source bytes");
    return bytes;
  }

  async readSourceStateSha256(): Promise<string> {
    return this.stateSha256;
  }

  async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}

class MemorySink implements SnapshotSinkAdapter {
  completed = false;
  discarded = false;
  readonly files = new Map<string, Uint8Array>();
  readonly handle: SnapshotSinkHandle = { opaqueId: "snapshot:opaque-1" };

  async complete(): Promise<void> {
    this.completed = true;
  }

  async createExclusive(): Promise<SnapshotSinkHandle> {
    return this.handle;
  }

  async discard(): Promise<void> {
    this.discarded = true;
  }

  async writeFile(
    _handle: SnapshotSinkHandle,
    relativePath: string,
    bytes: Uint8Array,
  ): Promise<void> {
    this.files.set(relativePath, bytes);
  }
}

describe("Phase 13 snapshot adapter boundary", () => {
  it("copies only approved bytes into an opaque disposable sink", async () => {
    const entries = [
      file("src/a.ts", "approved"),
      file(".env", "secret"),
    ];
    const source = new MemorySource(entries);
    source.bytes.set("src/a.ts", Buffer.from("approved"));
    source.bytes.set(".env", Buffer.from("secret"));
    const approved = planSnapshotEntries({
      entries,
      sourceStateSha256: source.stateSha256,
    });
    const sink = new MemorySink();
    const materialized = await new WorkspaceSnapshotter(
      source,
      sink,
    ).materializeApproved(approved);

    expect(materialized).toMatchObject({
      opaqueSinkId: "snapshot:opaque-1",
      sourceStateSha256: source.stateSha256,
    });
    expect(sink.completed).toBe(true);
    expect(sink.discarded).toBe(false);
    expect([...sink.files.keys()]).toEqual(["src/a.ts"]);
    expect(sink.files.has(".env")).toBe(false);
  });

  it("discards a partial snapshot when approved bytes change during copy", async () => {
    const entries = [file("src/a.ts", "approved")];
    const source = new MemorySource(entries);
    source.bytes.set("src/a.ts", Buffer.from("changed"));
    const approved = planSnapshotEntries({
      entries,
      sourceStateSha256: source.stateSha256,
    });
    const sink = new MemorySink();

    await expect(
      new WorkspaceSnapshotter(source, sink).materializeApproved(approved),
    ).rejects.toThrow(SnapshotPolicyError);
    expect(sink.completed).toBe(false);
    expect(sink.discarded).toBe(true);
  });
});
