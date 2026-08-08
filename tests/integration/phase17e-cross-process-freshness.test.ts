import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { DefaultRepositoryNavigationService } from "../../src/repository-intelligence/navigation-service.js";
import type {
  RepositoryIndexInvalidatedEventData,
  RepositoryIndexSelectedEventData,
} from "../../src/repository-intelligence/repository-intelligence-event-schema.js";

const execFileAsync = promisify(execFile);
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function externalWrite(path: string, value: string): Promise<void> {
  const script = [
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.argv[1], Buffer.from(process.argv[2], 'base64'));",
  ].join("");
  await execFileAsync(process.execPath, ["-e", script, path, Buffer.from(value, "utf8").toString("base64")], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
}

describe("Phase 17E cross-process source and rule freshness", () => {
  it("rejects old IDs/cursors and incrementally rebinds external source and nested-rule edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-phase17e-freshness-"));
    temporary.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "alpha.ts"), "export class Alpha {}\n", "utf8");
    await writeFile(
      join(root, "src", "consumer.ts"),
      'import { Alpha } from "./alpha.js";\nexport const current = new Alpha();\n',
      "utf8",
    );
    const invalidated: RepositoryIndexInvalidatedEventData[] = [];
    const selected: RepositoryIndexSelectedEventData[] = [];
    const service = await DefaultRepositoryNavigationService.create(root, {
      events: {
        indexInvalidated: async (data) => { invalidated.push(data); },
        indexSelected: async (data) => { selected.push(data); },
      },
    });

    const outline = await service.outline({ limit: 1, max_depth: 2 }, new AbortController().signal);
    const initial = await service.findSymbols({ limit: 5, query: "Alpha" }, new AbortController().signal);
    const oldSymbolId = initial.result[0]!.symbolId;
    const oldScope = initial.result[0]!.applicableRuleScopeSha256;

    await externalWrite(
      join(root, "src", "consumer.ts"),
      'import { Alpha } from "./alpha.js";\nexport const externallyChanged = new Alpha();\n',
    );
    await expect(
      service.findReferences({ limit: 20, symbol_id: oldSymbolId }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "repository_symbol_stale" });
    await expect(
      service.outline({ cursor: outline.nextCursor!, limit: 1, max_depth: 2 }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "repository_cursor_stale" });

    await externalWrite(join(root, "src", "AGENTS.md"), "# Nested rule\nOnly inspect src files.\n");
    const afterRules = await service.findSymbols({ limit: 5, query: "Alpha" }, new AbortController().signal);

    expect(afterRules.result[0]!.applicableRuleScopeSha256).not.toBe(oldScope);
    expect(selected.map((event) => event.build_mode)).toEqual(["cold", "incremental", "incremental"]);
    expect(new Set(selected.map((event) => event.generation_sha256)).size).toBe(3);
    expect(invalidated.map((event) => event.reason)).toEqual(["source_changed", "rules_changed"]);
    expect(invalidated.every((event) => event.old_generation_sha256.length === 64)).toBe(true);
  }, 30_000);
});
