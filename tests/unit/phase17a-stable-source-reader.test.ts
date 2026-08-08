import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RepositoryIntelligenceError } from "../../src/repository-intelligence/repository-intelligence-error.js";
import { StableSourceReader } from "../../src/repository-intelligence/stable-source-reader.js";
import { WorkspacePathPolicy } from "../../src/tools/workspace-path-policy.js";

const temporaryDirectories: string[] = [];

async function workspace(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "bornagent-phase17a-reader-"));
  temporaryDirectories.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Phase 17A stable source reader", () => {
  it("returns exact bytes and hash from one stable open handle", async () => {
    const root = await workspace();
    const content = "export const café = true;\n";
    await writeFile(join(root, "source.ts"), content, "utf8");
    const reader = new StableSourceReader(await WorkspacePathPolicy.create(root));
    const result = await reader.read("source.ts", { maxBytes: 1024, signal: new AbortController().signal });
    expect(Buffer.from(result.bytes).toString("utf8")).toBe(content);
    expect(result).toMatchObject({ byteLength: Buffer.byteLength(content), textEncoding: "utf8" });
    expect(result.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("distinguishes cancellation and size bounds", async () => {
    const root = await workspace();
    await writeFile(join(root, "large.ts"), "123456789", "utf8");
    const reader = new StableSourceReader(await WorkspacePathPolicy.create(root));
    await expect(reader.read("large.ts", { maxBytes: 8, signal: new AbortController().signal })).rejects.toEqual(
      expect.objectContaining({ code: "source_too_large", exitCode: 7 }),
    );
    const controller = new AbortController();
    controller.abort();
    await expect(reader.read("large.ts", { maxBytes: 10, signal: controller.signal })).rejects.toEqual(
      expect.objectContaining({ code: "source_unstable", exitCode: 130 }),
    );
  });

  it("denies linked source paths when the host permits creating one", async () => {
    const root = await workspace();
    await writeFile(join(root, "target.ts"), "target\n", "utf8");
    try {
      await symlink(join(root, "target.ts"), join(root, "linked.ts"), "file");
    } catch {
      return;
    }
    const reader = new StableSourceReader(await WorkspacePathPolicy.create(root));
    await expect(reader.read("linked.ts", { maxBytes: 1024, signal: new AbortController().signal })).rejects.toBeInstanceOf(
      RepositoryIntelligenceError,
    );
    await expect(reader.read("linked.ts", { maxBytes: 1024, signal: new AbortController().signal })).rejects.toEqual(
      expect.objectContaining({ code: "source_link_denied" }),
    );
  });
});
