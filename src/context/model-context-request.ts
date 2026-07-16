import { createHash } from "node:crypto";

import type {
  ModelBackend,
  ModelCanonicalContextPayload,
  ModelContextPlanReference,
  ModelTurnRequest,
  PreparedModelTurnRequest,
} from "../model/model-backend.js";
import type { ContextPlan } from "./context-plan-schema.js";
import type { MaterializedCanonicalContext } from "./context-planner.js";

const SHA256 = /^[0-9a-f]{64}$/u;
const STABLE_IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

export function modelContextPlanReference(
  plan: ContextPlan,
): ModelContextPlanReference {
  return Object.freeze({
    canonicalContextSha256: plan.canonicalContextSha256,
    epoch: plan.epoch,
    estimatedInputTokens: plan.estimatedInputTokens,
    includedItemIds: plan.includedItemIds,
    plannerVersion: plan.plannerVersion,
    protectedFactIds: plan.protectedFactIds,
  });
}

export function modelCanonicalContextPayload(
  materialized: MaterializedCanonicalContext,
  conversationMode: ModelCanonicalContextPayload["conversationMode"] = "augment",
): ModelCanonicalContextPayload {
  return Object.freeze({
    conversationMode,
    encoding: "bornagent.context.v1+json",
    sha256: materialized.sha256,
    text: materialized.text,
  });
}

export function prepareContextBoundModelRequest(
  backend: ModelBackend,
  request: ModelTurnRequest,
): PreparedModelTurnRequest {
  const contextPlan = request.contextPlan;
  const canonicalContext = request.canonicalContext;
  if (
    contextPlan === undefined ||
    canonicalContext === undefined ||
    !SHA256.test(contextPlan.canonicalContextSha256) ||
    !["augment", "replace"].includes(canonicalContext.conversationMode) ||
    canonicalContext.encoding !== "bornagent.context.v1+json" ||
    canonicalContext.sha256 !== contextPlan.canonicalContextSha256 ||
    createHash("sha256").update(canonicalContext.text, "utf8").digest("hex") !==
      canonicalContext.sha256 ||
    !Number.isSafeInteger(contextPlan.epoch) ||
    contextPlan.epoch < 0
  ) {
    throw new TypeError("model request requires a valid durable context plan");
  }
  const prepared: PreparedModelTurnRequest = backend.prepareTurnRequest?.(request) ??
    Object.freeze({
      adapterEncodingVersion: `${backend.identity.adapter}-${backend.identity.adapterVersion}`,
      request,
    });
  if (
    !STABLE_IDENTIFIER.test(prepared.adapterEncodingVersion) ||
    (prepared.encodedRequestSha256 !== undefined &&
      !SHA256.test(prepared.encodedRequestSha256)) ||
    prepared.request.contextPlan?.canonicalContextSha256 !==
      contextPlan.canonicalContextSha256 ||
    prepared.request.canonicalContext?.sha256 !== canonicalContext.sha256 ||
    prepared.request.canonicalContext?.text !== canonicalContext.text
  ) {
    throw new TypeError("backend request encoding did not preserve context authority");
  }
  return Object.freeze({
    adapterEncodingVersion: prepared.adapterEncodingVersion,
    ...(prepared.encodedRequestSha256 === undefined
      ? {}
      : { encodedRequestSha256: prepared.encodedRequestSha256 }),
    request: prepared.request,
  });
}
