import {
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { parseStrictJson } from "../../../../src/system/strict-json.js";
import {
  loadMemE0ActorQualificationFixture,
  MEM_E0_ACTOR_QUALIFICATION_CONFIG_RELATIVE_PATH,
  MEM_E0_ACTOR_QUALIFICATION_POLICY_RELATIVE_PATH,
  parseMemE0ActorQualificationConfig,
} from "../src/actor-qualification-fixture.js";
import { memE0RawSha256 } from "../src/fixture.js";

const EXPERIMENT_ID = "fal-mem-e0-agent-memory-task-effect-v1";
const FIXTURE_DIRECTORY = resolve(
  "fixtures",
  "frontier-adapter-lab",
  EXPERIMENT_ID,
);

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("test value must be an object");
  }
  return value as Record<string, unknown>;
}

function resealConfig(value: Record<string, unknown>): Record<string, unknown> {
  const content = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "configSha256"),
  );
  return {
    ...content,
    configSha256: sha256Canonical(content),
  };
}

async function copyFixture(): Promise<Readonly<{
  fixtureDirectory: string;
  repositoryRoot: string;
}>> {
  const repositoryRoot = await mkdtemp(
    join(tmpdir(), "bornagent-mem-e0-qualification-"),
  );
  const fixtureDirectory = join(
    repositoryRoot,
    "fixtures",
    "frontier-adapter-lab",
    EXPERIMENT_ID,
  );
  await cp(FIXTURE_DIRECTORY, fixtureDirectory, { recursive: true });
  return Object.freeze({ fixtureDirectory, repositoryRoot });
}

describe("FAL MEM-E0 DeepSeek actor qualification fixture", () => {
  it("loads the exact harm-control, policy, product entry, tools, and token caps offline", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("qualification fixture loading must not use the network");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const loaded = await loadMemE0ActorQualificationFixture(resolve("."));
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(loaded.case.definition.caseId).toBe("mem-e0-harm-control");
      expect(loaded.config.fixture.case).toMatchObject({
        caseSha256:
          "928fa58bc6c2a27d745e163f7ec4ae95a2292d0f6a214a19fadb49a6c2af42f2",
        hiddenVerifierImplementationRawSha256:
          "21d2ce078546f4f2843adbd76f176c514aaf00d3fb23da3f249e144eb792cf78",
        initialTargetRawSha256:
          "910d05972cb0b818c94a7b2ad4f882b3f76140da5202aa74a362442357a4d18e",
        publicVerifierRawSha256:
          "4f40867491ee5e0301a97d501afc53ff8cea1077ef86a4ea68befad20936727b",
        publicWorkspaceManifestSha256:
          "6cf3b7c88fbe4002e451d9d8d6afeb9cf3ef15f61b858d08b9646dfe1700de92",
        taskSha256:
          "26fb7b57c23946de755d5e4ad459956ee4fb4c4c019bbef65ebdd8bbac106b68",
      });
      expect(loaded.config.actor).toMatchObject({
        applicationServiceEntry: "executeAgentThroughApplicationService",
        orderedProductionToolNames: [
          "read_file",
          "apply_patch",
          "run_command",
          "finish_task",
        ],
        productEntrySha256:
          "140ccfd25738d669e7334a4437a6f5a7e87a44d43fa54f7d73dd7019fcbffaa5",
        toolAllowlistSha256:
          "08f2e864dda66452a5a70f5269bbb992abe01f1ceac090b142e2e547ca8bd8f7",
        toolCatalogSha256:
          "3c9f9b56c7b3c3392f2e41a00324393400b67c83872acb1b6558584eb6e8d508",
      });
      expect(loaded.config.provider).toEqual({
        endpoint: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        modelAliasMutable: true,
        provider: "deepseek",
        providerSource: "provider_network",
      });
      expect(loaded.config.budgets).toEqual({
        maximumAuthorizedCostUsdMicros: 33_609,
        maximumOutputTokensPerRequest: 2_048,
        maximumOutputTokensTotal: 8_192,
        maximumProviderRequests: 4,
        maximumReportedTotalTokens: 60_000,
        retries: 0,
      });
      expect(loaded.config.genericModelQualification).toMatchObject({
        evidenceKind: "model_capability_probe_suite",
        expectedIdentity: {
          adapterId: "pi-ai",
          adapterVersion: "0.80.7",
          endpointScope: {
            kind: "remote_explicit",
            originSha256:
              "9c1d6c22584ea0822e7a12d4533bde7800e01ac973446ee71db316ee0f68cb42",
          },
          policyProfileId: "fal-ds0-deepseek-remote-v1",
          policyProfileSha256:
            "e0aa62f5307506b757eccffaaa318cb2dc55bb13dfd843b209d9bbc81226c433",
          probeSuiteVersion: "phase18a-capability-registry-v1",
          probeToolSchemaSha256:
            "f8dc23bb22ce574ee60fa2bb210f7e1c80228f6021ab7fe7f3dd9304378aeb19",
        },
        recordEvidenceBinding: "run_local_authorization_only",
        recordReuseOnly: true,
        requiredQualifiedModes: ["build"],
        rerunProviderCallsAuthorized: false,
        usageRequirement: {
          availability: "complete",
          probeId: "usage_semantics_v1",
          status: "passed",
        },
      });
      expect(loaded.config.genericModelQualification).not.toHaveProperty(
        "evidenceSha256",
      );
      expect(loaded.policyProfile.id).toBe(
        "fal-mem-e0-deepseek-qualification-v1",
      );
      expect(loaded.policyProfile.modelAccess.kind).toBe("remote_explicit");
      expect(loaded.policyRawSha256).toBe(
        loaded.config.remotePolicy.rawSha256,
      );
      expect(Object.isFrozen(loaded.config.actor)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("strict-decodes and self-hashes the actor config, including exact tool order and caps", async () => {
    const raw = await readFile(
      join(FIXTURE_DIRECTORY, ...MEM_E0_ACTOR_QUALIFICATION_CONFIG_RELATIVE_PATH.split("/")),
      "utf8",
    );
    const config = asRecord(parseStrictJson(raw));
    expect(() => parseMemE0ActorQualificationConfig({
      ...config,
      unexpected: true,
    })).toThrow();
    expect(() => parseMemE0ActorQualificationConfig({
      ...config,
      qualificationRevision: 2,
    })).toThrow();

    const reordered = structuredClone(config);
    const reorderedActor = asRecord(reordered.actor);
    reorderedActor.orderedProductionToolNames = [
      "read_file",
      "run_command",
      "apply_patch",
      "finish_task",
    ];
    reorderedActor.toolAllowlistSha256 = sha256Canonical(
      reorderedActor.orderedProductionToolNames,
    );
    expect(() => parseMemE0ActorQualificationConfig(
      resealConfig(reordered),
    )).toThrow();

    const namesOnlyCatalog = structuredClone(config);
    asRecord(namesOnlyCatalog.actor).toolCatalogSha256 =
      "08f2e864dda66452a5a70f5269bbb992abe01f1ceac090b142e2e547ca8bd8f7";
    expect(() => parseMemE0ActorQualificationConfig(
      resealConfig(namesOnlyCatalog),
    )).toThrow();

    const widerBudget = structuredClone(config);
    asRecord(widerBudget.budgets).maximumProviderRequests = 5;
    expect(() => parseMemE0ActorQualificationConfig(
      resealConfig(widerBudget),
    )).toThrow();

    const pinnedHistoricalRecord = structuredClone(config);
    asRecord(pinnedHistoricalRecord.genericModelQualification)
      .evidenceSha256 = "a".repeat(64);
    expect(() => parseMemE0ActorQualificationConfig(
      resealConfig(pinnedHistoricalRecord),
    )).toThrow();
  });

  it("rejects a re-sealed config when the live system instruction identity drifts", async () => {
    const temporary = await copyFixture();
    try {
      const configPath = join(
        temporary.fixtureDirectory,
        ...MEM_E0_ACTOR_QUALIFICATION_CONFIG_RELATIVE_PATH.split("/"),
      );
      const config = asRecord(parseStrictJson(await readFile(configPath, "utf8")));
      asRecord(config.actor).systemInstructionSha256 = "f".repeat(64);
      await writeFile(
        configPath,
        `${JSON.stringify(resealConfig(config), null, 2)}\n`,
        "utf8",
      );
      await expect(
        loadMemE0ActorQualificationFixture(temporary.repositoryRoot),
      ).rejects.toThrow(/system instructions drifted/u);
    } finally {
      await rm(temporary.repositoryRoot, { force: true, recursive: true });
    }
  });

  it("passes remote-policy bytes through the product strict parser", async () => {
    const temporary = await copyFixture();
    try {
      const policyPath = join(
        temporary.fixtureDirectory,
        ...MEM_E0_ACTOR_QUALIFICATION_POLICY_RELATIVE_PATH.split("/"),
      );
      const policy = asRecord(
        parseStrictJson(await readFile(policyPath, "utf8")),
      );
      policy.unexpected = true;
      const policyRaw = `${JSON.stringify(policy, null, 2)}\n`;
      await writeFile(policyPath, policyRaw, "utf8");

      const configPath = join(
        temporary.fixtureDirectory,
        ...MEM_E0_ACTOR_QUALIFICATION_CONFIG_RELATIVE_PATH.split("/"),
      );
      const config = asRecord(parseStrictJson(await readFile(configPath, "utf8")));
      asRecord(config.remotePolicy).rawSha256 = memE0RawSha256(policyRaw);
      await writeFile(
        configPath,
        `${JSON.stringify(resealConfig(config), null, 2)}\n`,
        "utf8",
      );

      await expect(
        loadMemE0ActorQualificationFixture(temporary.repositoryRoot),
      ).rejects.toThrow(/policy_config_invalid|strict schema validation/u);
    } finally {
      await rm(temporary.repositoryRoot, { force: true, recursive: true });
    }
  });

  it("contains no environment or network access in the default loader", async () => {
    const source = await readFile(
      resolve(
        "labs/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/src/actor-qualification-fixture.ts",
      ),
      "utf8",
    );
    expect(source).not.toMatch(/\bprocess\.env\b/u);
    expect(source).not.toMatch(/\bfetch\s*\(/u);
  });
});
