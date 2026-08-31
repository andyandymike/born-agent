import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { afterAll, describe, expect, it } from "vitest";

import { falVp0CarrierPairPreflightSchema } from "../src/carrier-package-preflight.js";
import { verifyFalVp0MechanicsFreeze } from "../src/mechanics-freeze.js";
import { runFalVp0Mechanics } from "../src/mechanics-runner.js";
import { verifyFalVp0PackIsolation } from "../src/pack-isolation.js";
import {
  buildFalVp0MechanicsReceipt,
  falVp0MechanicsReceiptSchema,
} from "../src/receipt-schema.js";

const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { force: true, recursive: true })));
});

describe("FAL-VP0 milestone receipt", () => {
  it("closes mechanics without manufacturing VP0b or VP0c claims", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-vp0-receipt-"));
    temporaryRoots.push(root);
    const output = join(root, "run");
    const mechanicsSummary = await runFalVp0Mechanics({
      outputDirectory: output,
      repositoryRoot: process.cwd(),
    });
    const carrierPreflight = falVp0CarrierPairPreflightSchema.parse(JSON.parse(await readFile(
      join(output, "carrier-preflight.json"),
      "utf8",
    )));
    const freezeEvidence = {
      mechanicsFreezeCommit: "a".repeat(40),
      mechanicsParentCommit: "b".repeat(40),
      actorPreflightCommit: "a".repeat(40),
      mechanicsTreeSha256: sha256Canonical({ tree: 1 }),
      actorPreflightSha256: mechanicsSummary.actorPreflightSha256,
      ancestryEvidenceSha256: sha256Canonical({ ancestry: 1 }),
    };
    const packEvidence = sha256Canonical({ package: "zero-delta" });
    const first = buildFalVp0MechanicsReceipt({
      actualFocusedMinutes: 10,
      carrierPreflight,
      freezeEvidence,
      mechanicsSummary,
      packIsolation: {
        evidenceSha256: packEvidence,
        packedArtifactDeltaBytes: 0,
        status: "passed",
      },
      storageBytes: 26_536,
    });
    const second = buildFalVp0MechanicsReceipt({
      actualFocusedMinutes: 999,
      carrierPreflight,
      freezeEvidence,
      mechanicsSummary,
      packIsolation: {
        evidenceSha256: packEvidence,
        packedArtifactDeltaBytes: 0,
        status: "passed",
      },
      storageBytes: 26_536,
    });

    expect(falVp0MechanicsReceiptSchema.parse(first)).toEqual(first);
    expect(first.receiptSha256).toBe(second.receiptSha256);
    expect(first).toMatchObject({
      evidenceValidity: "valid",
      implementationFidelity: "verified",
      productFit: "not_assessed",
      promotion: "blocked",
      direction: "revise",
      candidateLifecycle: "retained_disabled",
    });
    expect(first.claimResults.find((entry) => entry.claimId === "held_out_full_pass_utility"))
      .toMatchObject({ result: "not_run", reasonCode: "actor_blocked" });
    expect(first.claimResults.find((entry) => entry.claimId === "fallback_equivalence"))
      .toMatchObject({ result: "supported", reasonCode: "twelve_canaries_zero_effect" });
  });
});

describe("FAL-VP0 production isolation", () => {
  it("keeps lab code and experiment fixtures outside production build and package roots", async () => {
    const buildConfig = JSON.parse(await readFile("tsconfig.build.json", "utf8")) as {
      readonly include?: readonly string[];
    };
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      readonly files?: readonly string[];
    };
    const files = packageJson.files ?? [];
    expect(buildConfig.include).toEqual(["src/**/*.ts"]);
    expect(files.some((entry) => entry === "labs" || entry.startsWith("labs/"))).toBe(false);
    expect(files.some((entry) => entry.includes("fal-vp0-verified-procedure-utilization-v1")))
      .toBe(false);
  });

  it("derives zero packed delta from the live pnpm inventory", async () => {
    const evidence = await verifyFalVp0PackIsolation(process.cwd());
    expect(evidence).toMatchObject({
      commandSucceeded: true,
      experimentFixtureEntryCount: 0,
      labEntryCount: 0,
      packedArtifactDeltaBytes: 0,
      productionSourceMarkerCount: 0,
      staticPolicyPassed: true,
      status: "passed",
    });
  });
});

describe("FAL-VP0 exact mechanics freeze", () => {
  it("derives commit, parent and protected tree evidence and rejects dirty bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-vp0-git-"));
    temporaryRoots.push(root);
    const runGit = async (...args: string[]) => execFileAsync("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    await runGit("init", "--quiet");
    await runGit("config", "user.name", "FAL VP0 Test");
    await runGit("config", "user.email", "fal-vp0@example.invalid");
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    await runGit("add", "base.txt");
    await runGit("commit", "--quiet", "-m", "base");
    await writeFile(join(root, "actor-preflight.json"), "{\"schemaVersion\":1}\n", "utf8");
    await runGit("add", "actor-preflight.json");
    await runGit("commit", "--quiet", "-m", "mechanics freeze");
    const head = (await runGit("rev-parse", "HEAD")).stdout.trim();
    const actorPreflightSha256 = sha256Canonical({ preflight: 1 });
    const evidence = await verifyFalVp0MechanicsFreeze({
      actorPreflightSha256,
      mechanicsFreezeCommit: head,
      protectedRelativeRefs: ["actor-preflight.json"],
      repositoryRoot: root,
    });
    expect(evidence).toMatchObject({
      actorPreflightCommit: head,
      actorPreflightSha256,
      mechanicsFreezeCommit: head,
    });

    await writeFile(join(root, "actor-preflight.json"), "{\"schemaVersion\":2}\n", "utf8");
    await expect(verifyFalVp0MechanicsFreeze({
      actorPreflightSha256,
      mechanicsFreezeCommit: head,
      protectedRelativeRefs: ["actor-preflight.json"],
      repositoryRoot: root,
    })).rejects.toThrow(/dirty or untracked/u);
  });
});
