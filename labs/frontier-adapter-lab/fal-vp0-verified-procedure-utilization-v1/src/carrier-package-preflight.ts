import { z } from "zod";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import type { FalVp0MaterializedCarrier } from "./procedure-skill-materializer.js";
import {
  logicalIdentity,
  nonnegativeIntegerSchema,
  sha256Schema,
} from "./protocol.js";

const carrierIdentitySchema = z.object({
  arm: z.enum(["baseline_source_evidence_dossier", "candidate_frozen_verified_procedure"]),
  selector: z.string().min(1).max(256).regex(/^[A-Za-z0-9._:@/#-]+$/u),
  qualifiedId: z.string().min(1).max(512).regex(/^[A-Za-z0-9._:@/#-]+$/u),
  componentSha256: sha256Schema,
  pluginSha256: sha256Schema,
  skillJsonRawSha256: sha256Schema,
  supportSetSha256: sha256Schema,
  contentSha256: sha256Schema,
  contentArtifactSha256: sha256Schema,
  contextItemCanonicalSha256: sha256Schema,
  carrierBytes: nonnegativeIntegerSchema,
  estimatedTokens: nonnegativeIntegerSchema,
  payloadEstimatedTokens: nonnegativeIntegerSchema,
  authority: z.literal("untrusted_content"),
  priority: z.literal("high"),
  role: z.literal("system"),
  visibility: z.literal("provider_context"),
  protectedCategory: z.null(),
  runtimeSelectedBy: z.literal("user"),
  supervisorSelection: z.literal("pre_registered"),
  skillArgumentsPresent: z.literal(false),
  resourcesMaterialized: z.literal(0),
}).strict();

const carrierPairPreflightContentSchema = z.object({
  schemaVersion: z.literal(1),
  baseline: carrierIdentitySchema,
  candidate: carrierIdentitySchema,
  equalSelector: z.boolean(),
  equalQualifiedId: z.boolean(),
  equalComponentSha256: z.boolean(),
  equalSkillJsonRawSha256: z.boolean(),
  equalSupportSetSha256: z.boolean(),
  equalAuthorityEnvelope: z.boolean(),
  distinctContentSha256: z.boolean(),
  distinctPluginSha256: z.boolean(),
  status: z.enum(["passed", "failed"]),
}).strict();

export const falVp0CarrierPairPreflightSchema = carrierPairPreflightContentSchema.extend({
  preflightSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const passed = value.equalSelector &&
    value.equalQualifiedId &&
    value.equalComponentSha256 &&
    value.equalSkillJsonRawSha256 &&
    value.equalSupportSetSha256 &&
    value.equalAuthorityEnvelope &&
    value.distinctContentSha256 &&
    value.distinctPluginSha256;
  if ((value.status === "passed") !== passed) {
    context.addIssue({ code: "custom", message: "carrier pair preflight status is not derived" });
  }
  if (value.baseline.arm !== "baseline_source_evidence_dossier" ||
      value.candidate.arm !== "candidate_frozen_verified_procedure") {
    context.addIssue({ code: "custom", message: "carrier pair arms are reversed" });
  }
  if (value.preflightSha256 !== logicalIdentity(value, "preflightSha256")) {
    context.addIssue({ code: "custom", message: "carrier pair preflight hash mismatch" });
  }
});

export type FalVp0CarrierPairPreflight = Readonly<
  z.infer<typeof falVp0CarrierPairPreflightSchema>
>;

function identity(carrier: FalVp0MaterializedCarrier): z.input<typeof carrierIdentitySchema> {
  if (
    carrier.contextItem.authority !== "untrusted_content" ||
    carrier.contextItem.priority !== "high" ||
    carrier.contextItem.role !== "system" ||
    carrier.contextItem.visibility !== "provider_context" ||
    carrier.contextItem.protectedCategory !== null
  ) {
    throw new Error("FAL-VP0 carrier authority envelope changed before pair preflight");
  }
  return {
    arm: carrier.arm,
    selector: carrier.selector,
    qualifiedId: carrier.qualifiedId,
    componentSha256: carrier.componentSha256,
    pluginSha256: carrier.pluginSha256,
    skillJsonRawSha256: carrier.skillJsonRawSha256,
    supportSetSha256: carrier.supportSetSha256,
    contentSha256: carrier.contentSha256,
    contentArtifactSha256: carrier.contentArtifactSha256,
    contextItemCanonicalSha256: carrier.contextItemCanonicalSha256,
    carrierBytes: carrier.carrierBytes,
    estimatedTokens: carrier.estimatedTokens,
    payloadEstimatedTokens: carrier.payloadEstimatedTokens,
    authority: carrier.contextItem.authority,
    priority: carrier.contextItem.priority,
    role: carrier.contextItem.role,
    visibility: carrier.contextItem.visibility,
    protectedCategory: null,
    runtimeSelectedBy: "user",
    supervisorSelection: "pre_registered",
    skillArgumentsPresent: false,
    resourcesMaterialized: 0,
  };
}

export function buildFalVp0CarrierPairPreflight(input: {
  readonly baseline: FalVp0MaterializedCarrier;
  readonly candidate: FalVp0MaterializedCarrier;
}): FalVp0CarrierPairPreflight {
  const baseline = carrierIdentitySchema.parse(identity(input.baseline));
  const candidate = carrierIdentitySchema.parse(identity(input.candidate));
  const authorityFields = ["authority", "priority", "role", "visibility", "protectedCategory"] as const;
  const content = {
    schemaVersion: 1 as const,
    baseline,
    candidate,
    equalSelector: baseline.selector === candidate.selector,
    equalQualifiedId: baseline.qualifiedId === candidate.qualifiedId,
    equalComponentSha256: baseline.componentSha256 === candidate.componentSha256,
    equalSkillJsonRawSha256: baseline.skillJsonRawSha256 === candidate.skillJsonRawSha256,
    equalSupportSetSha256: baseline.supportSetSha256 === candidate.supportSetSha256,
    equalAuthorityEnvelope: authorityFields.every((field) => baseline[field] === candidate[field]),
    distinctContentSha256: baseline.contentSha256 !== candidate.contentSha256,
    distinctPluginSha256: baseline.pluginSha256 !== candidate.pluginSha256,
    status: "failed" as "passed" | "failed",
  };
  content.status = content.equalSelector &&
    content.equalQualifiedId &&
    content.equalComponentSha256 &&
    content.equalSkillJsonRawSha256 &&
    content.equalSupportSetSha256 &&
    content.equalAuthorityEnvelope &&
    content.distinctContentSha256 &&
    content.distinctPluginSha256
    ? "passed"
    : "failed";
  return falVp0CarrierPairPreflightSchema.parse({
    ...content,
    preflightSha256: sha256Canonical(content),
  });
}
