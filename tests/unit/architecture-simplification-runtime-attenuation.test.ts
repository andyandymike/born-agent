import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ActiveOwnerRouter } from "../../src/control-plane/active-owner-router.js";
import { taskMutationContext } from "../../src/coordination/task-mutation-host.js";

const ROOT = resolve("src");

async function typescriptFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  }));
  return nested.flat();
}

describe("AS2.2 runtime capability attenuation", () => {
  it("keeps domain owners children and workers free of CliRuntime and surface imports", async () => {
    const coreDirectories = ["agent", "background", "delegation", "scheduling", "worktrees"];
    const violations: string[] = [];
    for (const directory of coreDirectories) {
      for (const path of await typescriptFiles(join(ROOT, directory))) {
        const name = relative(ROOT, path).replaceAll("\\", "/");
        const source = await readFile(path, "utf8");
        if (/\bCliRuntime\b/u.test(source)) violations.push(`${name}:CliRuntime`);
        if (/from\s+["'][^"']*(?:\/cli\/|\/commands\/|\/tui\/)/u.test(source)) {
          violations.push(`${name}:surface-import`);
        }
      }
    }
    for (const path of await typescriptFiles(join(ROOT, "control-plane", "adapters"))) {
      const name = relative(ROOT, path).replaceAll("\\", "/");
      const source = await readFile(path, "utf8");
      if (/from\s+["'][^"']*(?:\/commands\/|\/tui\/)/u.test(source)) {
        violations.push(`${name}:reverse-surface-import`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("reads only the narrow task mutation Host capability slice", () => {
    const reads: PropertyKey[] = [];
    const host = new Proxy({
      cwd: "D:/repository",
      randomUUID: () => "10000000-0000-4000-8000-000000000022",
      timestamp: () => "2026-08-13T00:00:00.000Z",
    }, {
      get(target, property, receiver) {
        reads.push(property);
        return Reflect.get(target, property, receiver);
      },
    });

    expect(taskMutationContext(host, "20000000-0000-4000-8000-000000000022")).toEqual({
      inputSurface: "cli",
      now: host.timestamp,
      randomUuid: host.randomUUID,
      sessionId: "20000000-0000-4000-8000-000000000022",
      workspace: "D:/repository",
    });
    expect(new Set(reads)).toEqual(new Set(["cwd", "randomUUID", "timestamp"]));

    const router = new ActiveOwnerRouter("D:/state");
    const release = router.foregroundGraphs.register(
      "30000000-0000-4000-8000-000000000022",
      Object.freeze({
        graphRevision: 1,
        graphSha256: "a".repeat(64),
        ownerApplicationOperationId: "40000000-0000-4000-8000-000000000022",
        ownerPreparedActionSha256: "b".repeat(64),
        requestCancel: async () => undefined,
        requestHostEmergencyStop: () => undefined,
      }),
    );
    expect(router.foregroundGraphs.active("50000000-0000-4000-8000-000000000022")).toBeNull();
    release();
    router.dispose();
  });
});
