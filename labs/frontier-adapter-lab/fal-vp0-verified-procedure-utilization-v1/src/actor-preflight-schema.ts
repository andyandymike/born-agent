import { z } from "zod";

import { canonicalJson, sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { parseStrictJson } from "../../../../src/system/strict-json.js";
import {
  identifierSchema,
  isStrictlySortedUnique,
  logicalIdentity,
  nonnegativeIntegerSchema,
  rawSha256,
  relativeArtifactRefSchema,
  sha256Schema,
} from "./protocol.js";

export const falVp0EvidenceSliceSchema = z.object({
  artifactId: identifierSchema,
  startByte: nonnegativeIntegerSchema,
  endByte: nonnegativeIntegerSchema,
  rawSpanSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  if (value.endByte <= value.startByte) {
    context.addIssue({ code: "custom", message: "evidence slice must be non-empty" });
  }
});

export const falVp0SmokeEvidenceArtifactSchema = z.object({
  artifactId: identifierSchema,
  kind: z.enum([
    "actor_event_log",
    "initial_workspace_manifest",
    "final_workspace_manifest",
    "completion_evidence",
    "run_report",
    "fresh_verifier_observation",
  ]),
  relativeRef: relativeArtifactRefSchema,
  bytes: nonnegativeIntegerSchema,
  rawFileSha256: sha256Schema,
  logicalSha256: sha256Schema.nullable(),
}).strict();

const publicSmokeObservationContentSchema = z.object({
  schemaVersion: z.literal(1),
  runId: identifierSchema,
  publicSmokePackSha256: sha256Schema,
  actorConfigSha256: sha256Schema,
  toolCallsObserved: nonnegativeIntegerSchema,
  completionMode: z.string().min(1).max(128).nullable(),
  pendingOrUnknownEffects: nonnegativeIntegerSchema,
  usageCapabilityObserved: z.enum(["complete", "not_reported"]),
  initialWorkspaceSha256: sha256Schema,
  finalWorkspaceSha256: sha256Schema,
  completionEvidenceSha256: sha256Schema.nullable(),
  runReportSha256: sha256Schema.nullable(),
  evidenceArtifacts: z.array(falVp0SmokeEvidenceArtifactSchema).min(3).max(32),
  actorEventRange: falVp0EvidenceSliceSchema,
}).strict();

export const falVp0PublicSmokeObservationSchema = publicSmokeObservationContentSchema.extend({
  observationSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  if (value.observationSha256 !== logicalIdentity(value, "observationSha256")) {
    context.addIssue({ code: "custom", message: "public smoke observation hash mismatch" });
  }
  const ids = value.evidenceArtifacts.map((entry) => entry.artifactId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "public smoke evidence artifact IDs must be unique" });
  }
  if (!ids.includes(value.actorEventRange.artifactId)) {
    context.addIssue({ code: "custom", message: "actor event range must bind an evidence artifact" });
  }
  const byKind = new Map(value.evidenceArtifacts.map((entry) => [entry.kind, entry]));
  for (const required of [
    "actor_event_log",
    "initial_workspace_manifest",
    "final_workspace_manifest",
  ] as const) {
    if (!byKind.has(required)) {
      context.addIssue({ code: "custom", message: `public smoke is missing ${required}` });
    }
  }
  if (byKind.get("initial_workspace_manifest")?.logicalSha256 !== value.initialWorkspaceSha256 ||
      byKind.get("final_workspace_manifest")?.logicalSha256 !== value.finalWorkspaceSha256) {
    context.addIssue({ code: "custom", message: "workspace manifest logical hashes do not match observation" });
  }
  if ((value.completionEvidenceSha256 === null) !== !byKind.has("completion_evidence") ||
      (value.runReportSha256 === null) !== !byKind.has("run_report")) {
    context.addIssue({ code: "custom", message: "completion/report artifacts and observation hashes must be paired" });
  }
  if (value.completionEvidenceSha256 !== null &&
      byKind.get("completion_evidence")?.logicalSha256 !== value.completionEvidenceSha256) {
    context.addIssue({ code: "custom", message: "completion evidence logical hash mismatch" });
  }
  if (value.runReportSha256 !== null && byKind.get("run_report")?.logicalSha256 !== value.runReportSha256) {
    context.addIssue({ code: "custom", message: "run report logical hash mismatch" });
  }
});

const smokeCapabilitySchema = z.object({
  status: z.enum(["passed", "failed"]),
  evidenceSlices: z.array(falVp0EvidenceSliceSchema).max(16),
  evidenceSha256s: z.array(sha256Schema).max(32),
}).strict().superRefine((value, context) => {
  if (!isStrictlySortedUnique(value.evidenceSha256s)) {
    context.addIssue({ code: "custom", message: "smoke capability evidence must be sorted and unique" });
  }
  if (value.status === "passed" &&
      (value.evidenceSha256s.length === 0 || value.evidenceSlices.length === 0)) {
    context.addIssue({ code: "custom", message: "passed smoke capability requires evidence" });
  }
  if (value.status === "failed" &&
      (value.evidenceSha256s.length !== 0 || value.evidenceSlices.length !== 0)) {
    context.addIssue({ code: "custom", message: "failed smoke capability cannot claim evidence" });
  }
});

const publicSmokeVerificationContentSchema = z.object({
  schemaVersion: z.literal(1),
  publicSmokeObservationRef: relativeArtifactRefSchema,
  publicSmokeObservationSha256: sha256Schema,
  verifierImplementationSha256: sha256Schema,
  capabilities: z.object({
    repositoryRead: smokeCapabilitySchema,
    editPersisted: smokeCapabilitySchema,
    exactVerifierArgv: smokeCapabilitySchema,
    finishTask: smokeCapabilitySchema,
    freshCompletionEvidence: smokeCapabilitySchema,
  }).strict(),
  freshVerifierImplementationSha256: sha256Schema,
  freshVerifierObservationSha256: sha256Schema,
  toolCallsObserved: nonnegativeIntegerSchema,
  completionMode: z.string().min(1).max(128).nullable(),
  pendingOrUnknownEffects: nonnegativeIntegerSchema,
  status: z.enum(["passed", "failed"]),
}).strict();

export const falVp0PublicSmokeVerificationSchema = publicSmokeVerificationContentSchema.extend({
  verifierObservationSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const passed = Object.values(value.capabilities).every((entry) => entry.status === "passed") &&
    value.toolCallsObserved > 0 &&
    value.completionMode === "verified_finish_task" && value.pendingOrUnknownEffects === 0;
  if ((value.status === "passed") !== passed) {
    context.addIssue({ code: "custom", message: "public smoke verification status is not derived" });
  }
  if (value.verifierObservationSha256 !== logicalIdentity(value, "verifierObservationSha256")) {
    context.addIssue({ code: "custom", message: "public smoke verification hash mismatch" });
  }
});

const actorPreflightContentSchema = z.object({
  schemaVersion: z.literal(1),
  actorImplementationSha256: sha256Schema,
  runtimePortSha256: sha256Schema,
  providerModelEndpointSha256: sha256Schema,
  modelArtifactSha256: sha256Schema.nullable(),
  systemInstructionSha256: sha256Schema,
  toolCatalogSha256: sha256Schema,
  casePolicyAdapterSha256: sha256Schema,
  runtimePolicySha256: sha256Schema,
  budgetSha256: sha256Schema,
  temperatureControl: z.object({
    mode: z.enum(["override_zero", "provider_default_not_exposed"]),
    providerDefaultsEvidenceSha256: sha256Schema,
  }).strict(),
  maxRetries: z.literal(0),
  seedControl: z.enum(["fixed", "unsupported"]),
  publicSmokePackSha256: sha256Schema,
  publicSmokeObservationRef: relativeArtifactRefSchema,
  publicSmokeObservationSha256: sha256Schema,
  publicSmokeVerifierImplementationSha256: sha256Schema,
  publicSmokeVerifierObservationRef: relativeArtifactRefSchema,
  publicSmokeVerifierObservationSha256: sha256Schema,
  usageCapability: z.enum(["complete", "not_reported"]),
  status: z.enum(["passed", "failed"]),
}).strict();

export const falVp0ActorPreflightSchema = actorPreflightContentSchema.extend({
  preflightSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  if (value.preflightSha256 !== logicalIdentity(value, "preflightSha256")) {
    context.addIssue({ code: "custom", message: "actor preflight hash mismatch" });
  }
});

export const falVp0PublicSmokeEventSchema = z.object({
  eventId: identifierSchema,
  kind: z.enum([
    "repository_read",
    "workspace_edit",
    "verifier_command",
    "finish_task",
    "fresh_verifier",
  ]),
  status: z.enum(["passed", "failed"]),
  argvSha256: sha256Schema.nullable(),
  evidenceSha256: sha256Schema,
}).strict();

export const falVp0PublicSmokeEventLogSchema = z.object({
  schemaVersion: z.literal(1),
  events: z.array(falVp0PublicSmokeEventSchema).max(128),
}).strict();

export type FalVp0PublicSmokeObservation = Readonly<
  z.infer<typeof falVp0PublicSmokeObservationSchema>
>;
export type FalVp0PublicSmokeVerification = Readonly<
  z.infer<typeof falVp0PublicSmokeVerificationSchema>
>;
export type FalVp0ActorPreflight = Readonly<z.infer<typeof falVp0ActorPreflightSchema>>;

export const FAL_VP0_PUBLIC_SMOKE_VERIFIER_IMPLEMENTATION_SHA256 = sha256Canonical({
  algorithm: "fal-vp0-public-smoke-verifier-v1",
  requiredCapabilities: [
    "repository_read",
    "workspace_edit",
    "verifier_command",
    "finish_task",
    "fresh_verifier",
  ],
});

function capability(
  events: readonly z.infer<typeof falVp0PublicSmokeEventSchema>[],
  kind: z.infer<typeof falVp0PublicSmokeEventSchema>["kind"],
  eventRange: z.infer<typeof falVp0EvidenceSliceSchema>,
  selectedLogBytes: Uint8Array,
  extra: (event: z.infer<typeof falVp0PublicSmokeEventSchema>) => boolean = () => true,
): z.infer<typeof smokeCapabilitySchema> {
  const matched = events.filter((entry) => entry.kind === kind && entry.status === "passed" && extra(entry));
  const evidenceSlices = matched.map((entry) => {
    const encodedEvent = new TextEncoder().encode(canonicalJson(entry));
    const offset = Buffer.from(selectedLogBytes).indexOf(Buffer.from(encodedEvent));
    if (offset < 0) throw new Error(`FAL-VP0 public smoke event ${entry.eventId} lacks an exact byte slice`);
    return {
      artifactId: eventRange.artifactId,
      startByte: eventRange.startByte + offset,
      endByte: eventRange.startByte + offset + encodedEvent.byteLength,
      rawSpanSha256: rawSha256(encodedEvent),
    };
  });
  return smokeCapabilitySchema.parse({
    status: matched.length > 0 ? "passed" : "failed",
    evidenceSlices,
    evidenceSha256s: [...new Set(matched.map((entry) => entry.evidenceSha256))].sort(),
  });
}

export function verifyFalVp0PublicSmoke(input: {
  readonly artifactBytesById: Readonly<Record<string, Uint8Array>>;
  readonly expectedVerifierArgvSha256: string;
  readonly freshVerifierImplementationSha256: string;
  readonly observation: FalVp0PublicSmokeObservation;
  readonly publicSmokeObservationRef: string;
}): FalVp0PublicSmokeVerification {
  const observation = falVp0PublicSmokeObservationSchema.parse(input.observation);
  for (const artifact of observation.evidenceArtifacts) {
    const bytes = input.artifactBytesById[artifact.artifactId];
    if (bytes === undefined || bytes.byteLength !== artifact.bytes || rawSha256(bytes) !== artifact.rawFileSha256) {
      throw new Error(`FAL-VP0 public smoke artifact ${artifact.artifactId} failed replay`);
    }
    if (artifact.logicalSha256 !== null) {
      let decoded: unknown;
      try {
        decoded = parseStrictJson(new TextDecoder("utf8", { fatal: true }).decode(bytes));
      } catch (error) {
        throw new Error(`FAL-VP0 public smoke artifact ${artifact.artifactId} is not strict JSON`, {
          cause: error,
        });
      }
      if (sha256Canonical(decoded) !== artifact.logicalSha256) {
        throw new Error(`FAL-VP0 public smoke artifact ${artifact.artifactId} logical hash mismatch`);
      }
    }
  }
  const logBytes = input.artifactBytesById[observation.actorEventRange.artifactId];
  if (logBytes === undefined || observation.actorEventRange.endByte > logBytes.byteLength) {
    throw new Error("FAL-VP0 public smoke event range is unavailable");
  }
  const selected = logBytes.slice(
    observation.actorEventRange.startByte,
    observation.actorEventRange.endByte,
  );
  if (rawSha256(selected) !== observation.actorEventRange.rawSpanSha256) {
    throw new Error("FAL-VP0 public smoke event range hash mismatch");
  }
  let decodedText: string;
  try {
    decodedText = new TextDecoder("utf8", { fatal: true }).decode(selected);
  } catch (error) {
    throw new Error("FAL-VP0 public smoke event range is not UTF-8", { cause: error });
  }
  const eventLog = falVp0PublicSmokeEventLogSchema.parse(parseStrictJson(decodedText));
  const capabilities = {
    repositoryRead: capability(eventLog.events, "repository_read", observation.actorEventRange, selected),
    editPersisted: capability(
      eventLog.events,
      "workspace_edit",
      observation.actorEventRange,
      selected,
      () => observation.initialWorkspaceSha256 !== observation.finalWorkspaceSha256,
    ),
    exactVerifierArgv: capability(
      eventLog.events,
      "verifier_command",
      observation.actorEventRange,
      selected,
      (event) => event.argvSha256 === input.expectedVerifierArgvSha256,
    ),
    finishTask: capability(
      eventLog.events,
      "finish_task",
      observation.actorEventRange,
      selected,
      () => observation.completionMode === "verified_finish_task",
    ),
    freshCompletionEvidence: capability(
      eventLog.events,
      "fresh_verifier",
      observation.actorEventRange,
      selected,
      () => observation.completionEvidenceSha256 !== null && observation.runReportSha256 !== null,
    ),
  };
  const freshVerifier = eventLog.events.find((entry) =>
    entry.kind === "fresh_verifier" && entry.status === "passed");
  const content = {
    schemaVersion: 1 as const,
    publicSmokeObservationRef: input.publicSmokeObservationRef,
    publicSmokeObservationSha256: observation.observationSha256,
    verifierImplementationSha256: FAL_VP0_PUBLIC_SMOKE_VERIFIER_IMPLEMENTATION_SHA256,
    capabilities,
    freshVerifierImplementationSha256: input.freshVerifierImplementationSha256,
    freshVerifierObservationSha256: freshVerifier?.evidenceSha256 ?? sha256Canonical({ missing: "fresh_verifier" }),
    toolCallsObserved: observation.toolCallsObserved,
    completionMode: observation.completionMode,
    pendingOrUnknownEffects: observation.pendingOrUnknownEffects,
    status: Object.values(capabilities).every((entry) => entry.status === "passed") &&
      observation.toolCallsObserved > 0 &&
      observation.completionMode === "verified_finish_task" &&
      observation.pendingOrUnknownEffects === 0
      ? "passed" as const
      : "failed" as const,
  };
  return falVp0PublicSmokeVerificationSchema.parse({
    ...content,
    verifierObservationSha256: sha256Canonical(content),
  });
}

export function buildFalVp0ActorPreflight(input: {
  readonly config: Omit<z.input<typeof actorPreflightContentSchema>,
    "publicSmokeObservationSha256" |
    "publicSmokeVerifierImplementationSha256" |
    "publicSmokeVerifierObservationSha256" |
    "status">;
  readonly observation: FalVp0PublicSmokeObservation;
  readonly verification: FalVp0PublicSmokeVerification;
}): FalVp0ActorPreflight {
  if (
    input.config.publicSmokeObservationRef !== input.verification.publicSmokeObservationRef ||
    input.config.publicSmokeVerifierObservationRef.length === 0 ||
    input.observation.observationSha256 !== input.verification.publicSmokeObservationSha256 ||
    input.observation.publicSmokePackSha256 !== input.config.publicSmokePackSha256 ||
    input.observation.usageCapabilityObserved !== input.config.usageCapability
  ) {
    throw new Error("FAL-VP0 actor preflight inputs do not bind the same public smoke run");
  }
  const content = {
    ...input.config,
    publicSmokeObservationSha256: input.observation.observationSha256,
    publicSmokeVerifierImplementationSha256: input.verification.verifierImplementationSha256,
    publicSmokeVerifierObservationSha256: input.verification.verifierObservationSha256,
    status: input.verification.status,
  };
  return falVp0ActorPreflightSchema.parse({
    ...content,
    preflightSha256: sha256Canonical(content),
  });
}

export function withFalVp0PublicSmokeObservationHash(
  content: z.input<typeof publicSmokeObservationContentSchema>,
): FalVp0PublicSmokeObservation {
  return falVp0PublicSmokeObservationSchema.parse({
    ...content,
    observationSha256: sha256Canonical(content),
  });
}
