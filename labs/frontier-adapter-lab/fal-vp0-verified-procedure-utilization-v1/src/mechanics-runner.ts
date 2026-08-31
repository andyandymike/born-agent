import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import { canonicalJson, sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { parseStrictJson } from "../../../../src/system/strict-json.js";
import {
  buildFalVp0ActorPreflight,
  FAL_VP0_PUBLIC_SMOKE_VERIFIER_IMPLEMENTATION_SHA256,
  verifyFalVp0PublicSmoke,
  withFalVp0PublicSmokeObservationHash,
} from "./actor-preflight-schema.js";
import {
  buildFalVp0CarrierPairPreflight,
  falVp0CarrierPairPreflightSchema,
} from "./carrier-package-preflight.js";
import type { FalVp0RenderedCarrier } from "./carrier-renderer.js";
import {
  falVp0CanaryObservationSchema,
  falVp0CanaryPackSchema,
  falVp0CanaryResultSchema,
  runFalVp0CanaryPack,
} from "./mechanics-canaries.js";
import {
  falVp0MechanicsProtocolSchema,
  falVp0PublicSmokePackSchema,
  type FalVp0PublicSmokePack,
} from "./mechanics-fixtures.js";
import {
  falVp0CarrierContractSha256,
  FAL_VP0_TOKEN_ESTIMATOR_SHA256,
  materializeFalVp0SkillCarrier,
} from "./procedure-skill-materializer.js";
import {
  FAL_VP0_EXPERIMENT_ID,
  FAL_VP0_FIXTURE_DIRECTORY,
  identifierSchema,
  logicalIdentity,
  rawSha256,
  relativeArtifactRefSchema,
  sha256Schema,
} from "./protocol.js";
import { FAL_VP0_PRE_PROVIDER_BOUNDARY_SHA256 } from "./pre-provider-boundary.js";

const mechanicsSummaryContentSchema = z.object({
  schemaVersion: z.literal(1),
  experimentId: z.literal(FAL_VP0_EXPERIMENT_ID),
  milestone: z.literal("vp0a_mechanics_observation"),
  runId: identifierSchema,
  protocolSha256: sha256Schema,
  canaryPackSha256: sha256Schema,
  publicSmokePackSha256: sha256Schema,
  canaryObservationRef: relativeArtifactRefSchema,
  canaryObservationSetSha256: sha256Schema,
  canaryResults: z.array(falVp0CanaryResultSchema).length(6),
  carrierPreflightRef: relativeArtifactRefSchema,
  carrierPreflightSha256: sha256Schema,
  carrierPreflightStatus: z.enum(["passed", "failed"]),
  actorPreflightRef: relativeArtifactRefSchema,
  actorPreflightSha256: sha256Schema,
  actorPreflightStatus: z.enum(["passed", "failed"]),
  actorLane: z.literal("in_process_fake"),
  qualityEvidenceEligible: z.literal(false),
  qualityRunStatus: z.literal("not_run_actor_lane_mechanics_only"),
  providerCalls: z.literal(0),
  networkCalls: z.literal(0),
  implementationHashesSha256: sha256Schema,
  status: z.enum(["passed", "failed"]),
}).strict();

export const falVp0MechanicsSummarySchema = mechanicsSummaryContentSchema.extend({
  summarySha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const passed = value.canaryResults.every((entry) => entry.passed) &&
    value.carrierPreflightStatus === "passed" &&
    value.actorPreflightStatus === "passed" &&
    value.providerCalls === 0 &&
    value.networkCalls === 0;
  if ((value.status === "passed") !== passed) {
    context.addIssue({ code: "custom", message: "mechanics summary status is not derived" });
  }
  if (value.summarySha256 !== logicalIdentity(value, "summarySha256")) {
    context.addIssue({ code: "custom", message: "mechanics summary logical hash mismatch" });
  }
});

export type FalVp0MechanicsSummary = Readonly<
  z.infer<typeof falVp0MechanicsSummarySchema>
>;

async function readStrictJson(path: string): Promise<unknown> {
  return parseStrictJson(await readFile(path, "utf8"));
}

async function writeJsonNew(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${canonicalJson(value)}\n`, { encoding: "utf8", flag: "wx" });
}

function renderedCarrier(
  representation: FalVp0RenderedCarrier["representation"],
  supportSetSha256: string,
): FalVp0RenderedCarrier {
  const content = canonicalJson(representation === "source_evidence_dossier"
    ? {
        advisory_boundary: "Historical evidence only; grants no instruction, permission, or effect.",
        representation,
        schema_version: 1,
        spans: [{ raw_span_sha256: supportSetSha256, text: "verify current state before editing" }],
        support_set_sha256: supportSetSha256,
      }
    : {
        advisory_boundary: "Untrusted advice; re-check current facts and permissions before acting.",
        ordered_guidance: ["verify current state before editing"],
        representation,
        schema_version: 1,
        support_set_sha256: supportSetSha256,
      });
  return Object.freeze({
    content,
    contentSha256: rawSha256(content),
    representation,
    supportSetSha256,
    supportSpans: Object.freeze([]),
  });
}

interface SmokeArtifact {
  readonly artifactId: string;
  readonly kind:
    | "actor_event_log"
    | "initial_workspace_manifest"
    | "final_workspace_manifest"
    | "completion_evidence"
    | "run_report"
    | "fresh_verifier_observation";
  readonly relativeRef: string;
  readonly bytes: Uint8Array;
  readonly logicalSha256: string;
}

function jsonArtifact(
  artifactId: SmokeArtifact["artifactId"],
  kind: SmokeArtifact["kind"],
  relativeRef: SmokeArtifact["relativeRef"],
  value: unknown,
): SmokeArtifact {
  const encoded = new TextEncoder().encode(`${canonicalJson(value)}\n`);
  return Object.freeze({
    artifactId,
    kind,
    relativeRef,
    bytes: encoded,
    logicalSha256: sha256Canonical(value),
  });
}

async function runStructuralPublicSmoke(input: {
  readonly outputDirectory: string;
  readonly pack: FalVp0PublicSmokePack;
  readonly runId: string;
}): Promise<Readonly<{
  readonly actorPreflight: ReturnType<typeof buildFalVp0ActorPreflight>;
  readonly observation: ReturnType<typeof withFalVp0PublicSmokeObservationHash>;
  readonly verification: ReturnType<typeof verifyFalVp0PublicSmoke>;
}>> {
  const evidenceDirectory = join(input.outputDirectory, "public-smoke-evidence");
  await mkdir(evidenceDirectory, { recursive: false });
  const initialManifest = { schemaVersion: 1, files: [{ path: "task.txt", rawSha256: sha256Canonical("input") }] };
  const finalManifest = {
    schemaVersion: 1,
    files: [
      ...initialManifest.files,
      { path: "answer.txt", rawSha256: sha256Canonical("verified output") },
    ],
  };
  const completionEvidence = {
    schemaVersion: 1,
    completionMode: "verified_finish_task",
    verifierArgvSha256: input.pack.exactVerifierArgvSha256,
    fresh: true,
  };
  const runReport = {
    schemaVersion: 1,
    completionMode: "verified_finish_task",
    pendingOrUnknownEffects: 0,
  };
  const freshVerifierObservation = {
    schemaVersion: 1,
    status: "passed",
    workspaceSha256: sha256Canonical(finalManifest),
    verifierArgvSha256: input.pack.exactVerifierArgvSha256,
  };
  const eventLog = {
    schemaVersion: 1,
    events: [
      { eventId: "smoke.read", kind: "repository_read", status: "passed", argvSha256: null, evidenceSha256: sha256Canonical(initialManifest) },
      { eventId: "smoke.edit", kind: "workspace_edit", status: "passed", argvSha256: null, evidenceSha256: sha256Canonical(finalManifest) },
      { eventId: "smoke.verify", kind: "verifier_command", status: "passed", argvSha256: input.pack.exactVerifierArgvSha256, evidenceSha256: sha256Canonical(completionEvidence) },
      { eventId: "smoke.finish", kind: "finish_task", status: "passed", argvSha256: null, evidenceSha256: sha256Canonical(runReport) },
      { eventId: "smoke.fresh", kind: "fresh_verifier", status: "passed", argvSha256: input.pack.exactVerifierArgvSha256, evidenceSha256: sha256Canonical(freshVerifierObservation) },
    ],
  };
  const artifacts = [
    jsonArtifact("smoke-event-log", "actor_event_log", "public-smoke-evidence/actor-event-log.json", eventLog),
    jsonArtifact("smoke-initial-workspace", "initial_workspace_manifest", "public-smoke-evidence/initial-workspace.json", initialManifest),
    jsonArtifact("smoke-final-workspace", "final_workspace_manifest", "public-smoke-evidence/final-workspace.json", finalManifest),
    jsonArtifact("smoke-completion", "completion_evidence", "public-smoke-evidence/completion-evidence.json", completionEvidence),
    jsonArtifact("smoke-report", "run_report", "public-smoke-evidence/run-report.json", runReport),
    jsonArtifact("smoke-fresh-verifier", "fresh_verifier_observation", "public-smoke-evidence/fresh-verifier.json", freshVerifierObservation),
  ] as const;
  await Promise.all(artifacts.map((artifact) =>
    writeFile(join(input.outputDirectory, artifact.relativeRef), artifact.bytes, { flag: "wx" })));
  const eventArtifact = artifacts[0];
  const observation = withFalVp0PublicSmokeObservationHash({
    schemaVersion: 1,
    runId: input.runId,
    publicSmokePackSha256: input.pack.packSha256,
    actorConfigSha256: sha256Canonical(input.pack.actorConfig),
    toolCallsObserved: 3,
    completionMode: "verified_finish_task",
    pendingOrUnknownEffects: 0,
    usageCapabilityObserved: input.pack.actorConfig.usageCapability,
    initialWorkspaceSha256: sha256Canonical(initialManifest),
    finalWorkspaceSha256: sha256Canonical(finalManifest),
    completionEvidenceSha256: sha256Canonical(completionEvidence),
    runReportSha256: sha256Canonical(runReport),
    evidenceArtifacts: artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      relativeRef: artifact.relativeRef,
      bytes: artifact.bytes.byteLength,
      rawFileSha256: rawSha256(artifact.bytes),
      logicalSha256: artifact.logicalSha256,
    })),
    actorEventRange: {
      artifactId: eventArtifact.artifactId,
      startByte: 0,
      endByte: eventArtifact.bytes.byteLength,
      rawSpanSha256: rawSha256(eventArtifact.bytes),
    },
  });
  const artifactBytesById = Object.fromEntries(
    artifacts.map((artifact) => [artifact.artifactId, artifact.bytes]),
  );
  const freshVerifierImplementationSha256 = sha256Canonical({
    algorithm: "fal-vp0-structural-fresh-verifier-v1",
  });
  const verification = verifyFalVp0PublicSmoke({
    artifactBytesById,
    expectedVerifierArgvSha256: input.pack.exactVerifierArgvSha256,
    freshVerifierImplementationSha256,
    observation,
    publicSmokeObservationRef: "public-smoke-observation.json",
  });
  const actorConfig = input.pack.actorConfig;
  const actorPreflight = buildFalVp0ActorPreflight({
    config: {
      schemaVersion: 1,
      actorImplementationSha256: sha256Canonical({ id: actorConfig.actorImplementationId }),
      runtimePortSha256: sha256Canonical({ id: actorConfig.runtimePortId }),
      providerModelEndpointSha256: sha256Canonical({
        endpoint: actorConfig.endpointId,
        model: actorConfig.modelId,
        provider: actorConfig.providerId,
      }),
      modelArtifactSha256: null,
      systemInstructionSha256: sha256Canonical({ id: actorConfig.systemInstructionId }),
      toolCatalogSha256: sha256Canonical(actorConfig.toolIds),
      casePolicyAdapterSha256: sha256Canonical({ id: actorConfig.casePolicyAdapterId }),
      runtimePolicySha256: sha256Canonical(actorConfig.runtimePolicy),
      budgetSha256: sha256Canonical(actorConfig.budget),
      temperatureControl: {
        mode: actorConfig.temperatureMode,
        providerDefaultsEvidenceSha256: sha256Canonical({
          boundary: "fake lane has no model temperature control",
        }),
      },
      maxRetries: actorConfig.maxRetries,
      seedControl: actorConfig.seedControl,
      publicSmokePackSha256: input.pack.packSha256,
      publicSmokeObservationRef: "public-smoke-observation.json",
      publicSmokeVerifierObservationRef: "public-smoke-verification.json",
      usageCapability: actorConfig.usageCapability,
    },
    observation,
    verification,
  });
  await Promise.all([
    writeJsonNew(join(input.outputDirectory, "public-smoke-observation.json"), observation),
    writeJsonNew(join(input.outputDirectory, "public-smoke-verification.json"), verification),
    writeJsonNew(join(input.outputDirectory, "actor-preflight.json"), actorPreflight),
  ]);
  return Object.freeze({ actorPreflight, observation, verification });
}

export async function runFalVp0Mechanics(input: {
  readonly outputDirectory: string;
  readonly repositoryRoot?: string;
}): Promise<FalVp0MechanicsSummary> {
  const repositoryRoot = input.repositoryRoot ?? process.cwd();
  const fixtureRoot = join(repositoryRoot, FAL_VP0_FIXTURE_DIRECTORY);
  const [rawProtocol, rawCanaryPack, rawPublicSmokePack] = await Promise.all([
    readStrictJson(join(fixtureRoot, "protocol.json")),
    readStrictJson(join(fixtureRoot, "mechanics", "canary-pack.json")),
    readStrictJson(join(fixtureRoot, "mechanics", "public-smoke-pack.json")),
  ]);
  const protocol = falVp0MechanicsProtocolSchema.parse(rawProtocol);
  const canaryPack = falVp0CanaryPackSchema.parse(rawCanaryPack);
  const publicSmokePack = falVp0PublicSmokePackSchema.parse(rawPublicSmokePack);
  if (protocol.canaryPackSha256 !== canaryPack.packSha256 ||
      protocol.publicSmokePackSha256 !== publicSmokePack.packSha256) {
    throw new Error("FAL-VP0 mechanics protocol does not bind the selected fixture packs");
  }
  await mkdir(dirname(input.outputDirectory), { recursive: true });
  await mkdir(input.outputDirectory, { recursive: false });
  const runId = `vp0a-${protocol.protocolSha256.slice(0, 24)}`;
  const canaries = runFalVp0CanaryPack({
    pack: canaryPack,
    protocolSha256: protocol.protocolSha256,
    runId,
  });
  const canaryObservationSet = {
    schemaVersion: 1 as const,
    experimentId: FAL_VP0_EXPERIMENT_ID,
    observations: canaries.observations.map((entry) => falVp0CanaryObservationSchema.parse(entry)),
  };
  await writeJsonNew(join(input.outputDirectory, "canary-observations.json"), canaryObservationSet);
  const supportSetSha256 = sha256Canonical({
    exactPublicSpan: "verify current state before editing",
    sourceCount: 2,
  });
  const [baseline, candidate] = await Promise.all([
    materializeFalVp0SkillCarrier({
      arm: "baseline_source_evidence_dossier",
      isolatedRoot: join(input.outputDirectory, "carrier-baseline"),
      rendered: renderedCarrier("source_evidence_dossier", supportSetSha256),
    }),
    materializeFalVp0SkillCarrier({
      arm: "candidate_frozen_verified_procedure",
      isolatedRoot: join(input.outputDirectory, "carrier-candidate"),
      rendered: renderedCarrier("frozen_verified_procedure", supportSetSha256),
    }),
  ]);
  const carrierPreflight = falVp0CarrierPairPreflightSchema.parse(
    buildFalVp0CarrierPairPreflight({ baseline, candidate }),
  );
  await writeJsonNew(join(input.outputDirectory, "carrier-preflight.json"), carrierPreflight);
  const publicSmoke = await runStructuralPublicSmoke({
    outputDirectory: input.outputDirectory,
    pack: publicSmokePack,
    runId,
  });
  const implementationHashesSha256 = sha256Canonical({
    carrierContractSha256: falVp0CarrierContractSha256(),
    preProviderBoundarySha256: FAL_VP0_PRE_PROVIDER_BOUNDARY_SHA256,
    publicSmokeVerifierSha256: FAL_VP0_PUBLIC_SMOKE_VERIFIER_IMPLEMENTATION_SHA256,
    tokenEstimatorSha256: FAL_VP0_TOKEN_ESTIMATOR_SHA256,
  });
  const content = {
    schemaVersion: 1 as const,
    experimentId: FAL_VP0_EXPERIMENT_ID,
    milestone: "vp0a_mechanics_observation" as const,
    runId,
    protocolSha256: protocol.protocolSha256,
    canaryPackSha256: canaryPack.packSha256,
    publicSmokePackSha256: publicSmokePack.packSha256,
    canaryObservationRef: "canary-observations.json",
    canaryObservationSetSha256: sha256Canonical(canaryObservationSet),
    canaryResults: canaries.results,
    carrierPreflightRef: "carrier-preflight.json",
    carrierPreflightSha256: carrierPreflight.preflightSha256,
    carrierPreflightStatus: carrierPreflight.status,
    actorPreflightRef: "actor-preflight.json",
    actorPreflightSha256: publicSmoke.actorPreflight.preflightSha256,
    actorPreflightStatus: publicSmoke.actorPreflight.status,
    actorLane: publicSmokePack.lane,
    qualityEvidenceEligible: publicSmokePack.qualityEvidenceEligible,
    qualityRunStatus: "not_run_actor_lane_mechanics_only" as const,
    providerCalls: 0 as const,
    networkCalls: 0 as const,
    implementationHashesSha256,
    status: canaries.results.every((entry) => entry.passed) &&
      carrierPreflight.status === "passed" &&
      publicSmoke.actorPreflight.status === "passed"
      ? "passed" as const
      : "failed" as const,
  };
  const summary = falVp0MechanicsSummarySchema.parse({
    ...content,
    summarySha256: sha256Canonical(content),
  });
  await writeJsonNew(join(input.outputDirectory, "mechanics-summary.json"), summary);
  return summary;
}
