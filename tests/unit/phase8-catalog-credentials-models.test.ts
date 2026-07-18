import { describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import {
  createPhase8ModelCatalog,
  PI_AI_PACKAGE_VERSION,
} from "../../src/providers/pi/pi-model-catalog.js";
import { CredentialResolver } from "../../src/security/credential-resolver.js";
import {
  OLLAMA_LOCAL_CATALOG_TIMEOUT_MS,
  OllamaLocalCatalogError,
} from "../../src/providers/pi/ollama-local-catalog-port.js";
import { createMemoryIO, createRuntime } from "../helpers.js";

describe("Phase 8 local catalog and credential routing", () => {
  it("lists only the audited provider/model allowlist", () => {
    const catalog = createPhase8ModelCatalog();

    expect(catalog.entries).toHaveLength(3);
    expect(catalog.find("openai", "gpt-5.6-terra")).toMatchObject({
      evidenceStatus: "contract_verified",
      sourcePackageVersion: PI_AI_PACKAGE_VERSION,
    });
    expect(catalog.find("anthropic", "claude-sonnet-5")).toBeDefined();
    expect(catalog.find("ollama", "qwen3:1.7b")).toMatchObject({
      evidenceStatus: "not_run_by_policy",
    });
    expect(catalog.find("openai", "unknown-model")).toBeUndefined();
  });

  it("reads only the selected provider key", () => {
    const reads: string[] = [];
    const environment = new Proxy<Record<string, string | undefined>>(
      {
        ANTHROPIC_API_KEY: "anthropic-sentinel-never-in-process-env",
        OPENAI_API_KEY: "openai-sentinel-never-in-process-env",
      },
      {
        get: (target, property, receiver) => {
          reads.push(String(property));
          return Reflect.get(target, property, receiver) as string | undefined;
        },
      },
    );
    const resolver = new CredentialResolver(environment);

    const openai = resolver.resolve("openai");
    expect(openai.status).toBe("configured");
    expect(reads).toEqual(["OPENAI_API_KEY"]);
    expect(JSON.stringify(openai)).not.toContain("openai-sentinel");

    reads.length = 0;
    expect(resolver.resolve("ollama")).toEqual({
      status: "not_required",
      variableName: null,
    });
    expect(reads).toEqual([]);
  });

  it("treats absent remote credentials as an expected local status", () => {
    const resolver = new CredentialResolver({});

    expect(resolver.resolve("openai")).toEqual({
      status: "missing",
      variableName: "OPENAI_API_KEY",
    });
    expect(resolver.resolve("anthropic")).toEqual({
      status: "missing",
      variableName: "ANTHROPIC_API_KEY",
    });
  });
});

describe("born models", () => {
  it("prints the static catalog without needing remote credentials", async () => {
    const memory = createMemoryIO();
    const refreshLocalModelCatalog = vi.fn(async () => []);
    const exitCode = await runCli(
      ["models"],
      memory.io,
      createRuntime({ env: {}, refreshLocalModelCatalog }),
    );

    expect(exitCode).toBe(0);
    expect(memory.readStdout()).toContain("OPENAI_API_KEY (not_read)");
    expect(memory.readStdout()).toContain("ANTHROPIC_API_KEY (not_read)");
    expect(memory.readStdout()).toContain("disabled_by_policy");
    expect(memory.readStdout()).toContain("none (local)");
    expect(memory.readStdout()).toContain("contract_verified");
    expect(memory.readStdout()).toContain("not_run_by_policy");
    expect(memory.readStderr()).toBe("");
    expect(refreshLocalModelCatalog).not.toHaveBeenCalled();
  });

  it("emits versioned JSON with zero catalog requests and no secret", async () => {
    const memory = createMemoryIO();
    const sentinel = "do-not-print-this-sentinel";
    const exitCode = await runCli(
      ["models", "--provider", "openai", "--json"],
      memory.io,
      createRuntime({ env: { OPENAI_API_KEY: sentinel } }),
    );

    expect(exitCode).toBe(0);
    expect(memory.readStdout()).not.toContain(sentinel);
    const document = JSON.parse(memory.readStdout()) as {
      catalog: { remoteCatalogRequestCount: number; version: string };
      models: Array<{
        credentialStatus: string;
        provider: string;
      }>;
      schemaVersion: number;
    };
    expect(document).toMatchObject({
      catalog: {
        remoteCatalogRequestCount: 0,
        version: PI_AI_PACKAGE_VERSION,
      },
      schemaVersion: 1,
    });
    expect(document.models).toEqual([
      expect.objectContaining({
        credentialStatus: "not_read",
        policyStatus: "disabled_by_policy",
        provider: "openai",
      }),
    ]);
  });

  it("rejects an unknown provider locally with exit 2", async () => {
    const memory = createMemoryIO();
    const exitCode = await runCli(
      ["models", "--provider", "unknown"],
      memory.io,
      createRuntime({ env: {} }),
    );

    expect(exitCode).toBe(2);
    expect(memory.readStdout()).toBe("");
    expect(memory.readStderr()).toContain("provider must be one of");
  });

  it("refreshes local tags only when explicitly requested", async () => {
    const memory = createMemoryIO();
    const digest = `sha256:${"a".repeat(64)}`;
    const refreshLocalModelCatalog = vi.fn(async () => [
      { digest, tag: "qwen3:1.7b" },
    ]);
    const exitCode = await runCli(
      ["models", "--provider", "ollama", "--refresh-local", "--json"],
      memory.io,
      createRuntime({
        env: { BORN_OLLAMA_BASE_URL: "http://127.0.0.1:11434/" },
        refreshLocalModelCatalog,
      }),
    );

    expect(exitCode).toBe(0);
    expect(refreshLocalModelCatalog).toHaveBeenCalledWith({
      baseURL: "http://127.0.0.1:11434",
      timeoutMs: OLLAMA_LOCAL_CATALOG_TIMEOUT_MS,
    });
    const document = JSON.parse(memory.readStdout()) as {
      catalog: {
        localCatalogRequestCount: number;
        remoteCatalogRequestCount: number;
      };
      localDiscovery: {
        evidenceStatus: string;
        models: Array<{ digest: string; tag: string }>;
        refreshRequested: boolean;
      };
      models: Array<{ evidenceStatus: string; provider: string }>;
    };
    expect(document.catalog).toEqual(
      expect.objectContaining({
        localCatalogRequestCount: 1,
        remoteCatalogRequestCount: 0,
      }),
    );
    expect(document.localDiscovery).toEqual({
      endpointScope: "literal_loopback_only",
      evidenceStatus: "discovery_only_not_capability_evidence",
      models: [{ digest, tag: "qwen3:1.7b" }],
      refreshRequested: true,
    });
    expect(document.models).toEqual([
      expect.objectContaining({
        evidenceStatus: "not_run_by_policy",
        provider: "ollama",
      }),
    ]);
  });

  it("rejects remote refresh configuration before calling the port", async () => {
    const memory = createMemoryIO();
    const refreshLocalModelCatalog = vi.fn(async () => []);
    const exitCode = await runCli(
      ["models", "--refresh-local"],
      memory.io,
      createRuntime({
        env: { BORN_OLLAMA_BASE_URL: "http://ollama.example:11434" },
        refreshLocalModelCatalog,
      }),
    );

    expect(exitCode).toBe(2);
    expect(refreshLocalModelCatalog).not.toHaveBeenCalled();
    expect(memory.readStderr()).toContain("root HTTP loopback URL");
  });

  it("reports local refresh timeout without raw errors", async () => {
    const memory = createMemoryIO();
    const exitCode = await runCli(
      ["models", "--refresh-local"],
      memory.io,
      createRuntime({
        env: {},
        refreshLocalModelCatalog: async () => {
          throw new OllamaLocalCatalogError("local_catalog_timeout");
        },
      }),
    );

    expect(exitCode).toBe(3);
    expect(memory.readStdout()).toBe("");
    expect(memory.readStderr()).toBe(
      "local Ollama catalog refresh failed: local_catalog_timeout\n",
    );
  });
});
