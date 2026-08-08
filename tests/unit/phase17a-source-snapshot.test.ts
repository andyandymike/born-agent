import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { repositorySourceSnapshotSchema } from "../../src/repository-intelligence/source-snapshot.js";
import { RepositorySourceSnapshotter } from "../../src/repository-intelligence/source-snapshotter.js";

const temporaryDirectories: string[] = [];

async function workspace(prefix = "bornagent-phase17a-snapshot-"): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Phase 17A repository source snapshot", () => {
  it("is deterministic and independent of absolute workspace location and timestamps", async () => {
    const first = await workspace();
    const second = await workspace();
    for (const root of [first, second]) {
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "hello.ts"), "export const hello = '世界';\n", "utf8");
      await writeFile(join(root, "README.md"), "# Example\n", "utf8");
    }

    const leftSnapshotter = await RepositorySourceSnapshotter.create(first);
    const rightSnapshotter = await RepositorySourceSnapshotter.create(second);
    const left = await leftSnapshotter.snapshot();
    const repeated = await leftSnapshotter.snapshot();
    const right = await rightSnapshotter.snapshot();

    expect(left.snapshot).toEqual(repeated.snapshot);
    expect(left.snapshot.sourceKind).toBe("filesystem");
    expect(left.snapshot.coverage).toBe("complete");
    expect(left.snapshot.sourceStateSha256).toBe(right.snapshot.sourceStateSha256);
    expect(JSON.stringify(left.snapshot)).not.toContain(first);
    expect(repositorySourceSnapshotSchema.parse(left.snapshot)).toEqual(left.snapshot);
    expect(left.snapshot.entries.map((entry) => entry.relativePath)).toEqual(["README.md", "src/hello.ts"]);
    expect(left.snapshot.entries[1]).toMatchObject({
      languageHint: "typescript",
      parseEligibility: "eligible",
      textEncoding: "utf8",
    });
  });

  it("changes source identity for bytes and policy while reporting soft bounds honestly", async () => {
    const root = await workspace();
    await writeFile(join(root, "source.ts"), "export const value = 1;\n", "utf8");
    const ordinary = await RepositorySourceSnapshotter.create(root);
    const before = await ordinary.snapshot();
    await writeFile(join(root, "source.ts"), "export const value = 2;\n", "utf8");
    const after = await ordinary.snapshot();
    expect(after.snapshot.entriesSha256).not.toBe(before.snapshot.entriesSha256);
    expect(after.snapshot.sourceStateSha256).not.toBe(before.snapshot.sourceStateSha256);

    const bounded = await RepositorySourceSnapshotter.create(root, { bounds: { maxFileBytes: 8 } });
    const partial = await bounded.snapshot();
    expect(partial.snapshot).toMatchObject({ coverage: "partial", skipped: { source_too_large: 1 } });
    expect(partial.snapshot.inventoryPolicySha256).not.toBe(after.snapshot.inventoryPolicySha256);
    expect(() => repositorySourceSnapshotSchema.parse({ ...partial.snapshot, coverage: "complete" })).toThrow();
  });

  it("classifies binary and unknown text without treating an unknown extension as binary", async () => {
    const root = await workspace();
    await writeFile(join(root, "notes.weird"), "plain text\n", "utf8");
    await writeFile(join(root, "asset.bin"), Buffer.from([0, 1, 2, 3]));
    const result = await (await RepositorySourceSnapshotter.create(root)).snapshot();
    expect(result.snapshot.entries.find((entry) => entry.relativePath === "notes.weird")).toMatchObject({
      languageHint: "unknown",
      parseEligibility: "unsupported",
      textEncoding: "utf8",
    });
    expect(result.snapshot.entries.find((entry) => entry.relativePath === "asset.bin")).toMatchObject({
      parseEligibility: "binary",
      textEncoding: "binary",
    });
  });
});
