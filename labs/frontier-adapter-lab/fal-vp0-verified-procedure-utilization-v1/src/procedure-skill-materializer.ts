import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ArtifactSessionRuntime } from "../../../../src/artifacts/artifact-session-runtime.js";
import { DefaultCapabilityPlatform } from "../../../../src/capabilities/capability-platform.js";
import { StablePackageReader } from "../../../../src/capabilities/stable-package-reader.js";
import { canonicalJson, sha256Canonical } from "../../../../src/completion/canonical-json.js";
import {
  contextItemCanonicalValue,
  createContextItem,
  type ContextItem,
} from "../../../../src/context/context-item.js";
import { DeterministicTokenEstimator } from "../../../../src/context/token-estimator.js";
import { SkillRuntime } from "../../../../src/skills/skill-runtime.js";
import type { FalVp0RenderedCarrier } from "./carrier-renderer.js";
import {
  FAL_VP0_CONTEXT_TOKEN_LIMIT,
  FAL_VP0_PAYLOAD_TOKEN_LIMIT,
  rawSha256,
} from "./protocol.js";

const PLUGIN_ID = "bornagent.fal-vp0" as const;
const PLUGIN_VERSION = "1.0.0" as const;
const COMPONENT_ID = "procedure-carrier" as const;
const SELECTOR = `${PLUGIN_ID}/${COMPONENT_ID}` as const;

const estimator = new DeterministicTokenEstimator({
  bytesPerToken: 3,
  itemOverheadTokens: 8,
  model: "fal-vp0-structural",
  provider: "host",
  tokenizer: "deterministic-byte-estimator",
  version: "1",
});

export const FAL_VP0_TOKEN_ESTIMATOR_SHA256 = estimator.estimatorId;

export interface FalVp0MaterializedCarrier {
  readonly activationEventIds: readonly string[];
  readonly arm: "baseline_source_evidence_dossier" | "candidate_frozen_verified_procedure";
  readonly carrierBytes: number;
  readonly componentSha256: string;
  readonly contentArtifactSha256: string;
  readonly contentSha256: string;
  readonly contextItem: ContextItem;
  readonly contextItemCanonicalSha256: string;
  readonly estimatedTokens: number;
  readonly pluginSha256: string;
  readonly payloadEstimatedTokens: number;
  readonly qualifiedId: string;
  readonly selector: typeof SELECTOR;
  readonly skillJsonRawSha256: string;
  readonly supportSetSha256: string;
}

async function writeNew(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf8", flag: "wx" });
}

export async function materializeFalVp0SkillCarrier(input: {
  readonly arm: FalVp0MaterializedCarrier["arm"];
  readonly isolatedRoot: string;
  readonly rendered: FalVp0RenderedCarrier;
}): Promise<FalVp0MaterializedCarrier> {
  const builtinRoot = join(input.isolatedRoot, "builtin");
  const userRoot = join(input.isolatedRoot, "user");
  const packageRoot = join(userRoot, "carrier");
  const workspace = join(input.isolatedRoot, "workspace");
  await mkdir(input.isolatedRoot, { recursive: false });
  await Promise.all([
    mkdir(builtinRoot, { recursive: false }),
    mkdir(packageRoot, { recursive: true }),
    mkdir(workspace, { recursive: false }),
  ]);
  const manifest = canonicalJson({
    components: { skills: ["skill.json"] },
    description: "Isolated FAL-VP0 equal-authority carrier.",
    display_name: "FAL-VP0 carrier",
    plugin_id: PLUGIN_ID,
    plugin_version: PLUGIN_VERSION,
    schema_version: 1,
  });
  const skillJson = canonicalJson({
    component_id: COMPONENT_ID,
    context: {
      max_entry_bytes: 64 * 1024,
      max_resource_bytes: 1,
      max_total_resource_bytes: 1,
    },
    description: "One frozen, advisory-only, untrusted FAL-VP0 carrier.",
    display_name: "Verified procedure experiment carrier",
    entry: "SKILL.md",
    invocation: "user_only",
    kind: "skill",
    schema_version: 1,
  });
  await Promise.all([
    writeNew(join(builtinRoot, "index.json"), `${canonicalJson({
      packages: [],
      revision: 1,
      schema_version: 1,
    })}\n`),
    writeNew(join(packageRoot, "bornagent.plugin.json"), `${manifest}\n`),
    writeNew(join(packageRoot, "skill.json"), `${skillJson}\n`),
    writeNew(join(packageRoot, "SKILL.md"), `${input.rendered.content}\n`),
  ]);
  const stablePackage = await StablePackageReader.read(packageRoot);
  await writeNew(join(userRoot, "enablement.json"), `${canonicalJson({
    packages: [{
      enabled: true,
      expected_plugin_sha256: stablePackage.pluginSha256,
      path: "carrier",
      plugin_id: stablePackage.pluginId,
      plugin_version: stablePackage.pluginVersion,
    }],
    revision: 1,
    schema_version: 1,
  })}\n`);
  const platform = new DefaultCapabilityPlatform({
    builtinRoot,
    env: {},
    platform: process.platform,
    userStateRoot: userRoot,
    workspace,
  });
  const snapshot = await platform.createSnapshot("2026-08-30T00:00:00.000Z");
  const artifactEvents: unknown[] = [];
  const runId = input.arm.startsWith("baseline")
    ? "81000000-0000-4000-8000-000000000001"
    : "82000000-0000-4000-8000-000000000001";
  const sessionId = input.arm.startsWith("baseline")
    ? "71000000-0000-4000-8000-000000000001"
    : "72000000-0000-4000-8000-000000000001";
  const artifacts = await ArtifactSessionRuntime.create({
    eventAppender: {
      appendArtifactEvent: async (_runId, event) => void artifactEvents.push(event),
    },
    events: [],
    runId,
    sessionId,
    workspace,
  });
  const skillEvents: Array<{ readonly eventId: string; readonly type: string }> = [];
  let idCounter = 0;
  const randomUUID = () => {
    idCounter += 1;
    return `83000000-0000-4000-8000-${String(idCounter).padStart(12, "0")}`;
  };
  const runtime = new SkillRuntime({
    artifacts,
    content: platform.createContentSource(snapshot),
    events: {
      append: async (type, _data, eventId = randomUUID()) => {
        skillEvents.push({ eventId, type });
      },
    },
    randomUUID,
    recency: () => skillEvents.length,
    snapshot,
  });
  const activated = await runtime.activateUser(SELECTOR);
  if (activated.status !== "activated" || activated.selected_by !== "user") {
    throw new Error("FAL-VP0 Skill carrier did not activate through the frozen user-selection path");
  }
  const contexts = runtime.contextItems();
  if (contexts.length !== 1 || contexts[0]?.kind !== "skill_entry") {
    throw new Error("FAL-VP0 carrier must produce exactly one Skill entry context item");
  }
  const contextInput = contexts[0]!;
  if (
    contextInput.authority !== "untrusted_content" ||
    contextInput.priority !== "high" ||
    contextInput.role !== "system" ||
    contextInput.protectedCategory !== undefined ||
    contextInput.visibility !== "provider_context"
  ) {
    throw new Error("FAL-VP0 carrier authority contract changed");
  }
  const contextItem = createContextItem(contextInput, estimator);
  const canonicalContext = canonicalJson(contextItemCanonicalValue(contextItem));
  const payloadEstimate = estimator.estimateText(input.rendered.content);
  if (payloadEstimate.estimatedTokens > FAL_VP0_PAYLOAD_TOKEN_LIMIT) {
    throw new Error(
      `FAL-VP0 carrier payload exceeds the 800-token limit: ${String(payloadEstimate.estimatedTokens)} tokens`,
    );
  }
  if (contextItem.estimatedTokens > FAL_VP0_CONTEXT_TOKEN_LIMIT) {
    throw new Error(
      `FAL-VP0 full ContextItem exceeds the 1800-token limit: ${String(contextItem.estimatedTokens)} tokens / ${String(Buffer.byteLength(canonicalContext, "utf8"))} bytes`,
    );
  }
  const component = snapshot.plugins[0]?.components[0];
  if (component === undefined || component.identity.kind !== "skill") {
    throw new Error("FAL-VP0 carrier snapshot lacks its exact Skill component");
  }
  return Object.freeze({
    activationEventIds: Object.freeze(skillEvents.map((entry) => entry.eventId)),
    arm: input.arm,
    carrierBytes: Buffer.byteLength(canonicalContext, "utf8"),
    componentSha256: component.identity.componentSha256,
    contentArtifactSha256: String(activated.content_artifact_id).replace(/^sha256:/u, ""),
    contentSha256: input.rendered.contentSha256,
    contextItem,
    contextItemCanonicalSha256: rawSha256(canonicalContext),
    estimatedTokens: contextItem.estimatedTokens,
    pluginSha256: component.identity.pluginSha256,
    payloadEstimatedTokens: payloadEstimate.estimatedTokens,
    qualifiedId: component.identity.qualifiedId,
    selector: SELECTOR,
    skillJsonRawSha256: rawSha256(`${skillJson}\n`),
    supportSetSha256: input.rendered.supportSetSha256,
  });
}

export function falVp0CarrierContractSha256(): string {
  return sha256Canonical({
    componentId: COMPONENT_ID,
    estimatorId: estimator.estimatorId,
    pluginId: PLUGIN_ID,
    pluginVersion: PLUGIN_VERSION,
    selector: SELECTOR,
    contextTokenLimit: FAL_VP0_CONTEXT_TOKEN_LIMIT,
    payloadTokenLimit: FAL_VP0_PAYLOAD_TOKEN_LIMIT,
  });
}
