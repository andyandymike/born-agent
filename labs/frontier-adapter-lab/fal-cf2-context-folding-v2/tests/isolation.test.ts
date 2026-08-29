import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { verifyCf2PackIsolation } from "../runner/run-cf2.js";

describe("CF2 production build and pack isolation", () => {
  it("keeps labs out of the production compiler and package inventory", async () => {
    const buildConfig = JSON.parse(await readFile("tsconfig.build.json", "utf8")) as {
      readonly include?: readonly string[];
    };
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      readonly files?: readonly string[];
    };
    expect(buildConfig.include).toEqual(["src/**/*.ts"]);
    expect(packageJson.files ?? []).not.toContain("labs");
    expect((packageJson.files ?? []).some((entry) =>
      entry.startsWith("labs/") || entry.includes("fal-cf2-context-folding-v2")))
      .toBe(false);
  });

  it("has no production source import of the candidate", async () => {
    const productionFiles = [
      "src/agent/agent-execution-service.ts",
      "src/context/agent-context-runtime.ts",
      "src/coordination/task-context-projection.ts",
      "src/delegation/receipts/parent-receipt-projector.ts",
    ];
    for (const path of productionFiles) {
      const source = await readFile(path, "utf8");
      expect(source).not.toContain("fal-cf2-context-folding-v2");
      expect(source).not.toContain("accepted_child_receipt_fold");
    }
  });

  it("derives pack isolation from the live pnpm inventory", async () => {
    await expect(verifyCf2PackIsolation(process.cwd())).resolves.toEqual({
      command: "pnpm pack --dry-run --json",
      commandSucceeded: true,
      labEntryCount: 0,
      candidateEntryCount: 0,
      packedContentMarkerCount: 0,
      productionSourceMarkerCount: 0,
      staticPolicyPassed: true,
      result: "passed",
    });
  });
});
