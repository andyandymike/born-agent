import { z } from "zod";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import {
  FAL_VP0_EXPERIMENT_ID,
  FAL_VP0_CONTEXT_TOKEN_LIMIT,
  FAL_VP0_PAYLOAD_TOKEN_LIMIT,
  identifierSchema,
  logicalIdentity,
  sha256Schema,
} from "./protocol.js";

const protocolContentSchema = z.object({
  schemaVersion: z.literal(1),
  experimentId: z.literal(FAL_VP0_EXPERIMENT_ID),
  milestone: z.literal("vp0a_mechanics"),
  remoteCallsAuthorized: z.literal(false),
  qualityRunAuthorized: z.literal(false),
  candidateLifecycle: z.literal("retained_disabled"),
  carrierPayloadTokenLimit: z.literal(FAL_VP0_PAYLOAD_TOKEN_LIMIT),
  carrierContextTokenLimit: z.literal(FAL_VP0_CONTEXT_TOKEN_LIMIT),
  canaryPackSha256: sha256Schema,
  publicSmokePackSha256: sha256Schema,
}).strict();

export const falVp0MechanicsProtocolSchema = protocolContentSchema.extend({
  protocolSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  if (value.protocolSha256 !== logicalIdentity(value, "protocolSha256")) {
    context.addIssue({ code: "custom", message: "mechanics protocol logical hash mismatch" });
  }
});

const publicSmokeActorConfigSchema = z.object({
  actorImplementationId: identifierSchema,
  runtimePortId: identifierSchema,
  providerId: z.literal("in_process_fake"),
  modelId: z.literal("deterministic_structural_actor"),
  endpointId: z.literal("none"),
  systemInstructionId: identifierSchema,
  toolIds: z.tuple([
    z.literal("repository.read"),
    z.literal("workspace.edit"),
    z.literal("command.exact_argv"),
    z.literal("task.finish"),
  ]),
  casePolicyAdapterId: identifierSchema,
  runtimePolicy: z.object({
    network: z.literal("none"),
    approval: z.literal("none"),
    effects: z.literal("deny_pending_or_unknown"),
  }).strict(),
  budget: z.object({
    maximumModelCalls: z.literal(0),
    maximumTotalTokens: z.literal(0),
    maximumEstimatedCostUsdMicros: z.literal(0),
  }).strict(),
  temperatureMode: z.literal("provider_default_not_exposed"),
  seedControl: z.literal("unsupported"),
  maxRetries: z.literal(0),
  usageCapability: z.literal("not_reported"),
}).strict();

const publicSmokePackContentSchema = z.object({
  schemaVersion: z.literal(1),
  experimentId: z.literal(FAL_VP0_EXPERIMENT_ID),
  lane: z.literal("in_process_fake"),
  qualityEvidenceEligible: z.literal(false),
  taskId: z.literal("public_smoke_nonlineage_v1"),
  requiredCapabilities: z.tuple([
    z.literal("repository_read"),
    z.literal("edit_persisted"),
    z.literal("exact_verifier_argv"),
    z.literal("finish_task"),
    z.literal("fresh_completion_evidence"),
  ]),
  exactVerifierArgv: z.array(z.string().min(1).max(256)).min(1).max(16),
  exactVerifierArgvSha256: sha256Schema,
  actorConfig: publicSmokeActorConfigSchema,
}).strict().superRefine((value, context) => {
  if (value.exactVerifierArgvSha256 !== sha256Canonical(value.exactVerifierArgv)) {
    context.addIssue({ code: "custom", message: "public smoke verifier argv hash mismatch" });
  }
});

export const falVp0PublicSmokePackSchema = publicSmokePackContentSchema.extend({
  packSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  if (value.packSha256 !== logicalIdentity(value, "packSha256")) {
    context.addIssue({ code: "custom", message: "public smoke pack logical hash mismatch" });
  }
});

export type FalVp0MechanicsProtocol = Readonly<
  z.infer<typeof falVp0MechanicsProtocolSchema>
>;
export type FalVp0PublicSmokePack = Readonly<
  z.infer<typeof falVp0PublicSmokePackSchema>
>;

export function withFalVp0MechanicsProtocolHash(
  content: z.input<typeof protocolContentSchema>,
): FalVp0MechanicsProtocol {
  return falVp0MechanicsProtocolSchema.parse({
    ...content,
    protocolSha256: sha256Canonical(content),
  });
}

export function withFalVp0PublicSmokePackHash(
  content: z.input<typeof publicSmokePackContentSchema>,
): FalVp0PublicSmokePack {
  return falVp0PublicSmokePackSchema.parse({
    ...content,
    packSha256: sha256Canonical(content),
  });
}
