import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

interface Ml5EvidenceManifest {
  readonly cases: readonly {
    readonly blocking: boolean;
    readonly file: string;
    readonly id: string;
    readonly platforms: readonly string[];
    readonly runner: string;
  }[];
  readonly manifestId: string;
  readonly releaseDemoFixture: string;
  readonly requiredCiJobs: readonly string[];
  readonly requiredLogMarker: string;
  readonly schemaVersion: number;
}

interface Ml5ReleaseFixture {
  readonly expected: {
    readonly maximumHistoricalRecords: number;
    readonly memoryAuthority: string;
    readonly remoteBillableRequests: number;
    readonly retractedRecordUses: number;
    readonly steps: number;
    readonly wrongRepositoryRecords: number;
  };
  readonly fixtureId: string;
  readonly schemaVersion: number;
}

const workspaceRoot = resolve(import.meta.dirname, "../..");

describe("Agent memory ML5 release evidence", () => {
  it("freezes one lightweight 11-step cross-platform release contract", async () => {
    const manifest = JSON.parse(await readFile(
      resolve(workspaceRoot, "tests/evidence/agent-memory-ml5-v1.json"),
      "utf8",
    )) as Ml5EvidenceManifest;
    const fixture = JSON.parse(await readFile(
      resolve(workspaceRoot, manifest.releaseDemoFixture),
      "utf8",
    )) as Ml5ReleaseFixture;

    expect(manifest).toMatchObject({
      manifestId: "agent-memory-ml5-v1",
      requiredCiJobs: ["memory-v1-linux", "memory-v1-windows"],
      requiredLogMarker: "memory_v1_release_demo_passed:",
      schemaVersion: 1,
    });
    expect(manifest.cases).toHaveLength(4);
    expect(new Set(manifest.cases.map(({ id }) => id)).size).toBe(4);
    expect(manifest.cases.every(({ blocking }) => blocking)).toBe(true);
    expect(manifest.cases.every(({ platforms }) =>
      JSON.stringify(platforms) === JSON.stringify(["linux", "win32"])
    )).toBe(true);
    await expect(Promise.all(manifest.cases.map(({ file }) =>
      access(resolve(workspaceRoot, file))
    ))).resolves.toEqual([undefined, undefined, undefined, undefined]);

    expect(fixture).toMatchObject({
      expected: {
        maximumHistoricalRecords: 3,
        memoryAuthority: "historical_only",
        remoteBillableRequests: 0,
        retractedRecordUses: 0,
        steps: 11,
        wrongRepositoryRecords: 0,
      },
      fixtureId: "agent-memory-ml5-unique-release-demo-v1",
      schemaVersion: 1,
    });
  });

  it("binds the packed demo to fresh processes, an exact CI SHA and credential-free local evidence", async () => {
    const pack = await readFile(resolve(workspaceRoot, "scripts/pack-smoke.mjs"), "utf8");
    const child = await readFile(resolve(
      workspaceRoot,
      "scripts/fixtures/memory-v1-release-agent-process.mjs",
    ), "utf8");

    expect(pack).toContain("memory_v1_release_demo_passed:");
    expect(pack).toContain("process.env.GITHUB_SHA ?? null");
    expect(pack).toContain("memory-v1-release-agent-process.mjs");
    expect(pack).toContain("stepsPassed: ml5Fixture.expected.steps");
    expect(child).toContain("memory-v1-release-fake");
    expect(child).toContain("remoteBillableRequests: 0");
    expect(child).toContain("disposeApplicationHostForStateRoot(stateRoot)");
    expect(child).toContain("delete process.env[key]");
  });

  it("keeps Memory v1 release evidence independent from unrelated monolithic gates", async () => {
    const workflow = (await readFile(resolve(workspaceRoot, ".github/workflows/ci.yml"), "utf8"))
      .replaceAll("\r\n", "\n");
    const start = workflow.indexOf("  memory-v1-release:\n");
    const end = workflow.indexOf("  quality:\n", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const releaseJob = workflow.slice(start, end);

    expect(releaseJob).toContain("name: memory-v1-${{ matrix.platform }}");
    expect(releaseJob).toContain("platform: linux");
    expect(releaseJob).toContain("platform: windows");
    expect(releaseJob).toContain("tests/unit/agent-memory-ml5-evidence.test.ts");
    expect(releaseJob).toContain("tests/integration/phase21a-application-service.test.ts");
    expect(releaseJob).toContain("name: Smoke packed Memory v1 release artifact");
    expect(releaseJob).toContain("run: pnpm pack:smoke");
    expect(releaseJob).not.toContain("pnpm check");
  });
});
