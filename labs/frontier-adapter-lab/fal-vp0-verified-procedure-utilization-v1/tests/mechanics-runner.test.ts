import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  falVp0ActorPreflightSchema,
  falVp0PublicSmokeObservationSchema,
  falVp0PublicSmokeVerificationSchema,
  verifyFalVp0PublicSmoke,
} from "../src/actor-preflight-schema.js";
import { falVp0CarrierPairPreflightSchema } from "../src/carrier-package-preflight.js";
import { falVp0PublicSmokePackSchema } from "../src/mechanics-fixtures.js";
import {
  falVp0MechanicsSummarySchema,
  runFalVp0Mechanics,
} from "../src/mechanics-runner.js";

const temporaryRoots: string[] = [];

async function temporaryRun(name: string) {
  const root = await mkdtemp(join(tmpdir(), `bornagent-vp0-${name}-`));
  temporaryRoots.push(root);
  const outputDirectory = join(root, "run");
  const summary = await runFalVp0Mechanics({
    outputDirectory,
    repositoryRoot: process.cwd(),
  });
  return { outputDirectory, summary };
}

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { force: true, recursive: true })));
});

describe("FAL-VP0 mechanics runner", () => {
  it("replays twelve canaries and real equal-authority Skill carriers with zero provider calls", async () => {
    const first = await temporaryRun("first");
    const second = await temporaryRun("second");
    expect(falVp0MechanicsSummarySchema.parse(first.summary)).toEqual(first.summary);
    expect(first.summary.summarySha256).toBe(second.summary.summarySha256);
    expect(first.summary).toMatchObject({
      actorLane: "in_process_fake",
      actorPreflightStatus: "passed",
      carrierPreflightStatus: "passed",
      networkCalls: 0,
      providerCalls: 0,
      qualityEvidenceEligible: false,
      qualityRunStatus: "not_run_actor_lane_mechanics_only",
      status: "passed",
    });
    expect(first.summary.canaryResults.every((entry) => entry.passed)).toBe(true);

    const carrier = falVp0CarrierPairPreflightSchema.parse(JSON.parse(await readFile(
      join(first.outputDirectory, "carrier-preflight.json"),
      "utf8",
    )));
    expect(carrier).toMatchObject({
      distinctContentSha256: true,
      distinctPluginSha256: true,
      equalAuthorityEnvelope: true,
      equalComponentSha256: true,
      equalQualifiedId: true,
      equalSelector: true,
      equalSkillJsonRawSha256: true,
      equalSupportSetSha256: true,
      status: "passed",
    });
    expect(carrier.baseline.payloadEstimatedTokens).toBeLessThanOrEqual(800);
    expect(carrier.candidate.payloadEstimatedTokens).toBeLessThanOrEqual(800);
    expect(carrier.baseline.estimatedTokens).toBeLessThanOrEqual(1_800);
    expect(carrier.candidate.estimatedTokens).toBeLessThanOrEqual(1_800);
  });

  it("replays public-smoke evidence and rejects one-byte tampering", async () => {
    const run = await temporaryRun("smoke");
    const observation = falVp0PublicSmokeObservationSchema.parse(JSON.parse(await readFile(
      join(run.outputDirectory, "public-smoke-observation.json"),
      "utf8",
    )));
    const storedVerification = falVp0PublicSmokeVerificationSchema.parse(JSON.parse(await readFile(
      join(run.outputDirectory, "public-smoke-verification.json"),
      "utf8",
    )));
    const pack = falVp0PublicSmokePackSchema.parse(JSON.parse(await readFile(
      "fixtures/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/mechanics/public-smoke-pack.json",
      "utf8",
    )));
    const artifactBytesById = Object.fromEntries(await Promise.all(
      observation.evidenceArtifacts.map(async (artifact) => [
        artifact.artifactId,
        await readFile(join(run.outputDirectory, artifact.relativeRef)),
      ]),
    ));
    const replay = verifyFalVp0PublicSmoke({
      artifactBytesById,
      expectedVerifierArgvSha256: pack.exactVerifierArgvSha256,
      freshVerifierImplementationSha256: storedVerification.freshVerifierImplementationSha256,
      observation,
      publicSmokeObservationRef: "public-smoke-observation.json",
    });
    expect(replay).toEqual(storedVerification);

    const tampered = { ...artifactBytesById };
    const firstId = observation.evidenceArtifacts[0]!.artifactId;
    tampered[firstId] = Buffer.from("tampered");
    expect(() => verifyFalVp0PublicSmoke({
      artifactBytesById: tampered,
      expectedVerifierArgvSha256: pack.exactVerifierArgvSha256,
      freshVerifierImplementationSha256: storedVerification.freshVerifierImplementationSha256,
      observation,
      publicSmokeObservationRef: "public-smoke-observation.json",
    })).toThrow(/failed replay/u);
  });

  it("refuses to overwrite an existing run directory", async () => {
    const run = await temporaryRun("exclusive");
    await expect(runFalVp0Mechanics({
      outputDirectory: run.outputDirectory,
      repositoryRoot: process.cwd(),
    })).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("replays the tracked public-smoke freeze byte-for-byte", async () => {
    const freezeRoot = "fixtures/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/freezes";
    const observation = falVp0PublicSmokeObservationSchema.parse(JSON.parse(await readFile(
      join(freezeRoot, "public-smoke-observation.json"),
      "utf8",
    )));
    const storedVerification = falVp0PublicSmokeVerificationSchema.parse(JSON.parse(await readFile(
      join(freezeRoot, "public-smoke-verification.json"),
      "utf8",
    )));
    const actorPreflight = falVp0ActorPreflightSchema.parse(JSON.parse(await readFile(
      join(freezeRoot, "actor-preflight.json"),
      "utf8",
    )));
    const pack = falVp0PublicSmokePackSchema.parse(JSON.parse(await readFile(
      "fixtures/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/mechanics/public-smoke-pack.json",
      "utf8",
    )));
    const artifactBytesById = Object.fromEntries(await Promise.all(
      observation.evidenceArtifacts.map(async (artifact) => [
        artifact.artifactId,
        await readFile(join(freezeRoot, artifact.relativeRef)),
      ]),
    ));
    const replay = verifyFalVp0PublicSmoke({
      artifactBytesById,
      expectedVerifierArgvSha256: pack.exactVerifierArgvSha256,
      freshVerifierImplementationSha256: storedVerification.freshVerifierImplementationSha256,
      observation,
      publicSmokeObservationRef: "public-smoke-observation.json",
    });
    expect(replay).toEqual(storedVerification);
    expect(actorPreflight).toMatchObject({
      preflightSha256: "805562db11eb52537d87ee587c2f1384f2100ebd64f4016c1f36f3adb17c3af0",
      status: "passed",
    });
  });
});
