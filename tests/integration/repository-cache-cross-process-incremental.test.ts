import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { TypeScriptLanguageServiceAdapter } from "../../src/repository-intelligence/engines/typescript-language-service-adapter.js";
import { buildIndexGeneration } from "../../src/repository-intelligence/index-generation.js";
import { RepositoryIndexV2Store } from "../../src/repository-intelligence/index-v2-store.js";
import { RepositorySourceSnapshotter } from "../../src/repository-intelligence/source-snapshotter.js";

const execFileAsync = promisify(execFile);
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function runIndex(workspace: string): Promise<{ readonly buildMode: string; readonly generationSha256: string }> {
  const worker = fileURLToPath(new URL(
    "../../src/repository-intelligence/benchmark/repository-cache-writer-worker.ts",
    import.meta.url,
  ));
  const result = await execFileAsync(process.execPath, [
    "--import", import.meta.resolve("tsx"), worker, workspace, "v2", "true",
  ], {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env },
    timeout: 30_000,
    windowsHide: true,
  });
  return JSON.parse(result.stdout.trim()) as { readonly buildMode: string; readonly generationSha256: string };
}

describe("RIC3 repository cache cross-process incremental facts", () => {
  it("uses portable facts after restart and remains exact with a clean full oracle", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-ric3-cross-process-"));
    temporary.push(root);
    await writeFile(join(root, "value.ts"), "export const value = 1;\n", "utf8");
    await writeFile(join(root, "use.ts"), 'import { value } from "./value.js";\nexport const answer = value;\n', "utf8");
    await writeFile(join(root, "other.ts"), "export const other = true;\n", "utf8");
    expect((await runIndex(root)).buildMode).toBe("cold");

    await writeFile(join(root, "other.ts"), "export const other = true;\n// implementation-only change\n", "utf8");
    const updated = await runIndex(root);
    expect(updated.buildMode).toBe("incremental");

    const store = await RepositoryIndexV2Store.openExisting(root);
    const current = await store!.readCurrent();
    const snapshot = await (await RepositorySourceSnapshotter.create(root)).snapshot();
    const engine = new TypeScriptLanguageServiceAdapter();
    const clean = buildIndexGeneration({
      engineIdentitySha256: engine.identity.identitySha256,
      records: await engine.build(root, snapshot, new AbortController().signal),
      ruleManifestSha256: current!.generation.ruleManifestSha256,
      sourceCoverage: snapshot.snapshot.coverage,
      sourceStateSha256: snapshot.snapshot.sourceStateSha256,
    });
    expect(current!.generation).toEqual(clean.generation);
    expect(current!.records).toEqual(clean.records);
    expect(updated.generationSha256).toBe(clean.generation.generationSha256);
    expect((await runIndex(root)).buildMode).toBe("reused");
  }, 40_000);
});
