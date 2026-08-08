import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import ts from "typescript";
import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";
import { parseStrictJson } from "../system/strict-json.js";
import { repositoryEngineDecisionSchema, type RepositoryEngineDecisionV1 } from "./benchmark/engine-decision-schema.js";
import {
  repositoryEngineIdentityV1Schema,
  TYPESCRIPT_ENGINE_ASSET,
  type RepositoryEngineIdentityV1,
} from "./engine-identity.js";
import { RepositoryIntelligenceError } from "./repository-intelligence-error.js";

const assetLockSchema = z
  .object({
    assets: z.array(z.object({
      integrity: z.string().min(1),
      kind: z.literal("npm_package"),
      name: z.string().min(1),
      runtimeRole: z.literal("in_process_language_service"),
      version: z.string().min(1),
    }).strict()).length(1),
    networkRequired: z.literal(false),
    repositoryConfigAllowed: z.literal(false),
    repositoryPluginsAllowed: z.literal(false),
    schemaVersion: z.literal(1),
  })
  .strict();

export interface AcceptedRepositoryEngineDecision {
  readonly assetsLockSha256: string;
  readonly decision: RepositoryEngineDecisionV1;
  readonly identity: RepositoryEngineIdentityV1;
}

async function strictJsonFile(path: string): Promise<unknown> {
  try {
    const bytes = await readFile(path);
    if (bytes.byteLength === 0 || bytes.byteLength > 4 * 1024 * 1024) throw new Error("policy JSON size is invalid");
    return parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new RepositoryIntelligenceError(
      "repository_engine_decision_invalid",
      "repository engine policy failed strict decoding",
      2,
      { cause: error },
    );
  }
}

export async function loadAcceptedRepositoryEngineDecision(
  packageRoot: string,
): Promise<AcceptedRepositoryEngineDecision> {
  try {
    const policyRoot = resolve(packageRoot, "policies/repository-intelligence");
    const [decisionRaw, assetsRaw] = await Promise.all([
      strictJsonFile(resolve(policyRoot, "engine-v1.json")),
      strictJsonFile(resolve(policyRoot, "assets-lock-v1.json")),
    ]);
    const decision = repositoryEngineDecisionSchema.parse(decisionRaw);
    if (decision.status !== "accepted") throw new Error("repository engine decision is not accepted");
    const identity = repositoryEngineIdentityV1Schema.parse(decision.engineIdentity);
    const assets = assetLockSchema.parse(assetsRaw);
    const asset = assets.assets[0]!;
    if (
      asset.name !== TYPESCRIPT_ENGINE_ASSET.package ||
      asset.version !== TYPESCRIPT_ENGINE_ASSET.version ||
      asset.integrity !== TYPESCRIPT_ENGINE_ASSET.integrity ||
      ts.version !== TYPESCRIPT_ENGINE_ASSET.version ||
      identity.runtimeAssetsSha256 !== sha256Canonical(TYPESCRIPT_ENGINE_ASSET)
    ) {
      throw new RepositoryIntelligenceError(
        "repository_engine_asset_invalid",
        "repository engine runtime asset does not match its exact lock",
        3,
      );
    }
    return Object.freeze({ assetsLockSha256: sha256Canonical(assets), decision, identity });
  } catch (error) {
    if (error instanceof RepositoryIntelligenceError) throw error;
    throw new RepositoryIntelligenceError(
      "repository_engine_decision_invalid",
      "repository engine decision failed validation",
      2,
      { cause: error },
    );
  }
}
