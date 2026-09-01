import { readFile } from "node:fs/promises";

import Ajv2020Module, { type ValidateFunction } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { sha256Canonical } from "../../src/completion/canonical-json.js";
import {
  dockerArtifactLockRawSchema,
} from "../../src/execution/docker/acquisition/docker-artifact-schema.js";
import {
  canonicalPolicyProfileData,
  parseRuntimePolicyProfile,
  runtimePolicyProfileRawSchema,
} from "../../src/policy/runtime-policy-schema.js";

const root = new URL("../../", import.meta.url);

async function json(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(relativePath, root), "utf8"));
}

function compile(schema: unknown): ValidateFunction {
  const Ajv2020 = Ajv2020Module as unknown as new (options: {
    readonly allErrors: boolean;
    readonly strict: boolean;
  }) => { compile(value: unknown): ValidateFunction };
  return new Ajv2020({ allErrors: true, strict: true }).compile(schema);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function remoteProfile(): Record<string, unknown> {
  return {
    schema_version: 1,
    id: "remote-openai-contract",
    mode: "remote_explicit",
    model_access: {
      kind: "remote_explicit",
      providers: [
        {
          provider: "openai",
          models: ["gpt-contract-v1"],
          base_urls: ["https://api.openai.com/v1"],
        },
      ],
      credential_access: "selected_provider_only",
      limits: {
        max_provider_requests_per_run: 2,
        max_output_tokens_per_request: 256,
        max_reported_total_tokens_per_run: 2_000,
      },
    },
    eval_access: {
      allowed_suites: ["targeted", "smoke"],
      max_attempts_per_run: 2,
    },
    docker_acquisition: { kind: "deny" },
  };
}

function deepSeekRemoteProfile(): Record<string, unknown> {
  const profile = remoteProfile();
  profile.id = "remote-deepseek-contract";
  const access = profile.model_access as {
    providers: Array<Record<string, unknown>>;
  };
  access.providers = [
    {
      provider: "deepseek",
      models: ["deepseek-v4-flash"],
      base_urls: ["https://api.deepseek.com"],
    },
  ];
  return profile;
}

function allRemoteProvidersProfile(): Record<string, unknown> {
  const profile = remoteProfile();
  profile.id = "remote-all-providers-contract";
  const access = profile.model_access as {
    providers: Array<Record<string, unknown>>;
  };
  access.providers = [
    ...access.providers,
    {
      provider: "anthropic",
      models: ["claude-contract-v1"],
      base_urls: ["https://api.anthropic.com"],
    },
    {
      provider: "deepseek",
      models: ["deepseek-v4-flash"],
      base_urls: ["https://api.deepseek.com"],
    },
  ];
  return profile;
}

describe("Phase 15 published schema and runtime parser parity", () => {
  it("accepts and rejects the same policy fixtures", async () => {
    const builtIn = await json("policies/local-free-v1.json");
    const validate = compile(await json("policies/policy-schema-v1.json"));
    const fixtures: readonly {
      readonly expected: boolean;
      readonly mutate?: (value: Record<string, unknown>) => void;
      readonly source: Record<string, unknown>;
    }[] = [
      { expected: true, source: builtIn as Record<string, unknown> },
      { expected: true, source: remoteProfile() },
      { expected: true, source: deepSeekRemoteProfile() },
      { expected: true, source: allRemoteProvidersProfile() },
      {
        expected: false,
        source: builtIn as Record<string, unknown>,
        mutate: (value) => { value.unknown_escape_hatch = true; },
      },
      {
        expected: false,
        source: builtIn as Record<string, unknown>,
        mutate: (value) => {
          (value.model_access as Record<string, unknown>).ollama = {
            endpoint: "http://localhost:11434",
            default_model: "qwen3:1.7b",
            require_installed_digest: true,
          };
        },
      },
      {
        expected: false,
        source: builtIn as Record<string, unknown>,
        mutate: (value) => {
          (value.model_access as Record<string, unknown>).allowed_sources = [
            "in_process_test",
          ];
        },
      },
      {
        expected: false,
        source: remoteProfile(),
        mutate: (value) => {
          const access = value.eval_access as Record<string, unknown>;
          access.allowed_suites = ["targeted", "full"];
        },
      },
      {
        expected: false,
        source: remoteProfile(),
        mutate: (value) => {
          const access = value.model_access as {
            providers: Array<Record<string, unknown>>;
          };
          access.providers[0]!.base_urls = ["https://example.invalid/v1"];
        },
      },
      {
        expected: false,
        source: remoteProfile(),
        mutate: (value) => {
          const access = value.model_access as {
            providers: Array<Record<string, unknown>>;
          };
          access.providers[0]!.models = ["gpt-latest"];
        },
      },
      {
        expected: false,
        source: deepSeekRemoteProfile(),
        mutate: (value) => {
          const access = value.model_access as {
            providers: Array<Record<string, unknown>>;
          };
          access.providers[0]!.base_urls = ["https://api.deepseek.com/v1"];
        },
      },
    ];

    for (const fixture of fixtures) {
      const value = clone(fixture.source);
      fixture.mutate?.(value);
      const jsonSchemaAccepted = validate(value);
      const runtimeAccepted = runtimePolicyProfileRawSchema.safeParse(value).success;
      expect(jsonSchemaAccepted).toBe(fixture.expected);
      expect(runtimeAccepted).toBe(fixture.expected);
    }
  });

  it("accepts and rejects the same Docker lock fixtures", async () => {
    const lock = await json(
      "docker/artifacts/bornagent-sandbox-node-v1.lock.json",
    ) as Record<string, unknown>;
    const validate = compile(
      await json("docker/artifacts/artifact-schema-v1.json"),
    );
    const fixtures: readonly {
      readonly expected: boolean;
      readonly mutate?: (value: Record<string, unknown>) => void;
    }[] = [
      { expected: true },
      {
        expected: false,
        mutate: (value) => { value.registry_credentials = "inherit"; },
      },
      {
        expected: false,
        mutate: (value) => {
          (value.pull as Record<string, unknown>).image = "node:latest";
        },
      },
      {
        expected: false,
        mutate: (value) => {
          (value.build as Record<string, unknown>).network = "default";
        },
      },
      {
        expected: false,
        mutate: (value) => {
          const build = value.build as Record<string, unknown>;
          build.base_images = [
            (build.base_images as readonly string[])[0],
            (build.base_images as readonly string[])[0],
          ];
        },
      },
      {
        expected: false,
        mutate: (value) => {
          const contract = value.runtime_contract as Record<string, unknown>;
          const labels = contract.required_labels as Record<string, unknown>;
          delete labels["org.bornagent.exec-wrapper-sha256"];
        },
      },
    ];

    for (const fixture of fixtures) {
      const value = clone(lock);
      fixture.mutate?.(value);
      const jsonSchemaAccepted = validate(value);
      const runtimeAccepted = dockerArtifactLockRawSchema.safeParse(value).success;
      expect(jsonSchemaAccepted).toBe(fixture.expected);
      expect(runtimeAccepted).toBe(fixture.expected);
    }
  });

  it("pins deterministic canonical hashes for the published assets", async () => {
    const policy = parseRuntimePolicyProfile(
      await json("policies/local-free-v1.json"),
    );
    const lock = dockerArtifactLockRawSchema.parse(
      await json("docker/artifacts/bornagent-sandbox-node-v1.lock.json"),
    );

    expect(sha256Canonical(canonicalPolicyProfileData(policy))).toBe(
      "424958376462d24fbe83e2c267ad50902b83b18f709e62a6a9e395b5ce8e89eb",
    );
    expect(sha256Canonical(lock)).toBe(
      "8323658171fe7b3400aadbb22f5f994776fc7efba3f1f7524c26c0581ad54054",
    );
  });
});
