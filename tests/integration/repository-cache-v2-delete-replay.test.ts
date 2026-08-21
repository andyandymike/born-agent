import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DefaultRepositoryNavigationService } from "../../src/repository-intelligence/navigation-service.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("RIC4 repository cache deletion and exact rebuild", () => {
  it("deletes only v2 derived bytes and rebuilds the same generation and query results", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-ric4-delete-replay-"));
    temporary.push(root);
    await writeFile(join(root, "library.ts"), [
      "export function answer(): number { return 42; }",
      "export const result = answer();",
      "",
    ].join("\n"), "utf8");
    const signal = new AbortController().signal;
    const first = await DefaultRepositoryNavigationService.create(root);
    const generation = await first.rebuild(signal);
    const firstOutline = await first.outline({ limit: 100, max_depth: 2 }, signal);
    const firstSymbols = await first.findSymbols({ limit: 20, query: "answer" }, signal);
    const firstReferences = await first.findReferences({
      limit: 50,
      symbol_id: firstSymbols.result[0]!.symbolId,
    }, signal);
    const cacheRoot = join(root, ".bornagent", "cache", "repository-intelligence");
    const parentKey = await readFile(join(cacheRoot, "navigation-integrity.key"));
    const legacyKey = await readFile(join(cacheRoot, "v1", "navigation-integrity.key"));

    await rm(join(cacheRoot, "v2"), { force: true, recursive: true });

    const second = await DefaultRepositoryNavigationService.create(root);
    const rebuilt = await second.ensureCurrent({ allowBuild: true, signal });
    const secondOutline = await second.outline({ limit: 100, max_depth: 2 }, signal);
    const secondSymbols = await second.findSymbols({ limit: 20, query: "answer" }, signal);
    const secondReferences = await second.findReferences({
      limit: 50,
      symbol_id: secondSymbols.result[0]!.symbolId,
    }, signal);

    expect(rebuilt.stored.generation.generationSha256).toBe(generation.stored.generation.generationSha256);
    expect(secondOutline).toEqual(firstOutline);
    expect(secondSymbols).toEqual(firstSymbols);
    expect(secondReferences).toEqual(firstReferences);
    expect(await readFile(join(cacheRoot, "navigation-integrity.key"))).toEqual(parentKey);
    expect(await readFile(join(cacheRoot, "v1", "navigation-integrity.key"))).toEqual(legacyKey);
  });
});
