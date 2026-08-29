import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { parseStrictJson } from "../../../../src/system/strict-json.js";

import {
  evaluationCommitmentSchema,
  SHARED_MEMORY_BENCHMARK_ID,
  SHARED_MEMORY_FIXTURE_DIRECTORY,
  sharedExecutorPackSchema,
  sharedFamilyRegistrySchema,
  sharedGoldenPackSchema,
  sharedPublicManifestSchema,
} from "../src/benchmark-schema.js";
import {
  buildSharedSplit,
  canonicalPrettyJson,
  rawTextIdentity,
} from "../src/pack-builder.js";
import {
  sharedMemoryCandidateFreeze,
  sharedMemoryProtocol,
} from "../src/protocol.js";
import {
  calibrationScenarioSeeds,
  developmentScenarioSeeds,
} from "./public-scenario-seeds.js";

const repositoryRoot = process.cwd();
const outputDirectory = join(repositoryRoot, SHARED_MEMORY_FIXTURE_DIRECTORY);
const hiddenCommitmentPath = join(
  repositoryRoot,
  ".cache/frontier-adapter-lab/fal-memory-shared-v1/public-evaluation-commitment.json",
);

const development = buildSharedSplit("development", developmentScenarioSeeds);
const calibration = buildSharedSplit("calibration", calibrationScenarioSeeds);
sharedExecutorPackSchema.parse(development.executor);
sharedGoldenPackSchema.parse(development.goldens);
sharedExecutorPackSchema.parse(calibration.executor);
sharedGoldenPackSchema.parse(calibration.goldens);
const familyRegistry = sharedFamilyRegistrySchema.parse({
  schemaVersion: 1,
  benchmarkId: SHARED_MEMORY_BENCHMARK_ID,
  cards: [...development.registry.cards, ...calibration.registry.cards],
});

const protocolText = canonicalPrettyJson(sharedMemoryProtocol);
const freezeText = canonicalPrettyJson(sharedMemoryCandidateFreeze);
const commitment = evaluationCommitmentSchema.parse(parseStrictJson(
  await readFile(hiddenCommitmentPath, "utf8"),
));
if (commitment.protocolSha256 !== rawTextIdentity(protocolText).sha256 ||
    commitment.candidateFreezeSha256 !== rawTextIdentity(freezeText).sha256) {
  throw new Error("sealed evaluation commitment does not bind current protocol/freeze bytes");
}

const files = Object.freeze({
  "protocol.json": protocolText,
  "candidate-freeze.json": freezeText,
  "family-registry.json": canonicalPrettyJson(familyRegistry),
  "development-inputs.json": canonicalPrettyJson(development.executor),
  "development-goldens.json": canonicalPrettyJson(development.goldens),
  "calibration-inputs.json": canonicalPrettyJson(calibration.executor),
  "calibration-goldens.json": canonicalPrettyJson(calibration.goldens),
  "evaluation-commitment.json": canonicalPrettyJson(commitment),
});

await mkdir(outputDirectory, { recursive: true });
for (const [path, text] of Object.entries(files)) {
  await writeFile(join(outputDirectory, path), text, "utf8");
}

const manifestContent = Object.freeze({
  schemaVersion: 1 as const,
  benchmarkId: SHARED_MEMORY_BENCHMARK_ID,
  evidenceState: "public_dev_calibration_with_unrevealed_evaluation_commitment" as const,
  createdAt: "2026-08-29T05:30:00.000Z",
  files: Object.fromEntries(Object.entries(files).map(([path, text]) => [
    path,
    rawTextIdentity(text),
  ])),
});
const manifest = sharedPublicManifestSchema.parse({
  ...manifestContent,
  manifestSha256: sha256Canonical(manifestContent),
});
await writeFile(
  join(outputDirectory, "manifest.json"),
  canonicalPrettyJson(manifest),
  "utf8",
);

process.stdout.write(`${JSON.stringify({
  benchmarkId: SHARED_MEMORY_BENCHMARK_ID,
  calibrationProbes: calibration.executor.timelines.length * 10,
  developmentProbes: development.executor.timelines.length * 10,
  evaluationCommitment: commitment.saltedPackCommitmentSha256,
  publicManifestSha256: manifest.manifestSha256,
})}\n`);
