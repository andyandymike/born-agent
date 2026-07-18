import type { CliIO } from "../cli/types.js";
import {
  createPhase8ModelCatalog,
  isKnownProviderId,
  KNOWN_PROVIDER_IDS,
  MODEL_CATALOG_SCHEMA_VERSION,
  PI_AI_PACKAGE_NAME,
  PI_AI_PACKAGE_VERSION,
  type ModelCatalogEntry,
} from "../providers/pi/pi-model-catalog.js";
import {
  CredentialResolver,
  type CredentialResolution,
} from "../security/credential-resolver.js";
import {
  DEFAULT_OLLAMA_LOCAL_CATALOG_BASE_URL,
  OLLAMA_LOCAL_CATALOG_TIMEOUT_MS,
  OllamaLocalCatalogError,
  type OllamaLocalCatalogRefreshRequest,
  type OllamaLocalModelDiscovery,
} from "../providers/pi/ollama-local-catalog-port.js";
import { resolveLoopbackOllamaURL } from "../security/loopback-ollama-url.js";
import { loadRuntimePolicyRegistry } from "../policy/policy-config-loader.js";
import { RuntimePolicyError } from "../policy/policy-errors.js";
import {
  resolveEffectiveRuntimePolicy,
  resolveProviderPolicyRequest,
  type EffectiveRuntimePolicy,
} from "../policy/policy-resolver.js";
import { persistRuntimePolicyEvidence } from "../policy/policy-evidence.js";

export interface ModelsCommandOptions {
  readonly json: boolean;
  readonly policyConfig?: string | undefined;
  readonly policyProfile?: string | undefined;
  readonly provider: string | undefined;
  readonly refreshLocal: boolean;
}

export interface ModelsRuntime {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  refreshLocalModelCatalog(
    request: OllamaLocalCatalogRefreshRequest,
  ): Promise<readonly OllamaLocalModelDiscovery[]>;
}

interface ListedModel extends ModelCatalogEntry {
  readonly credentialStatus: CredentialResolution["status"] | "not_read";
  readonly policyStatus: "enabled" | "disabled_by_policy";
}

function displayCredential(model: ListedModel): string {
  return model.credentialVariable === null
    ? "none (local)"
    : `${model.credentialVariable} (${model.credentialStatus})`;
}

function renderTable(models: readonly ListedModel[]): string {
  const headings = [
    "PROVIDER",
    "MODEL",
    "TOOLS",
    "STREAM",
    "USAGE",
    "POLICY",
    "CREDENTIAL",
    "EVIDENCE",
  ] as const;
  const rows = models.map((model) => [
    model.provider,
    model.modelId,
    model.capabilities.tools === "none" ? "no" : "yes",
    model.capabilities.streaming ? "yes" : "no",
    model.capabilities.usage,
    model.policyStatus,
    displayCredential(model),
    model.evidenceStatus,
  ]);
  const widths = headings.map((heading, index) =>
    Math.max(
      heading.length,
      ...rows.map((row) => row[index]?.length ?? 0),
    ),
  );
  const renderRow = (row: readonly string[]) =>
    row
      .map((value, index) => value.padEnd(widths[index] ?? value.length))
      .join("  ")
      .trimEnd();
  return `${renderRow(headings)}\n${rows.map(renderRow).join("\n")}\n`;
}

function renderLocalDiscovery(
  models: readonly OllamaLocalModelDiscovery[],
): string {
  const heading =
    "LOCAL OLLAMA DISCOVERY (tag presence only; capabilities/evidence unchanged)";
  if (models.length === 0) return `${heading}\n(no local tags)\n`;
  const tagWidth = Math.max("TAG".length, ...models.map((model) => model.tag.length));
  return `${heading}\n${"TAG".padEnd(tagWidth)}  DIGEST\n${models
    .map((model) => `${model.tag.padEnd(tagWidth)}  ${model.digest}`)
    .join("\n")}\n`;
}

export async function executeModels(
  options: ModelsCommandOptions,
  runtime: ModelsRuntime,
  io: CliIO,
): Promise<0 | 1 | 2 | 3> {
  const selectedProvider = options.provider?.trim().toLowerCase();
  if (
    selectedProvider !== undefined &&
    !isKnownProviderId(selectedProvider)
  ) {
    io.stderr.write(
      `usage/config error: provider must be one of: ${KNOWN_PROVIDER_IDS.join(", ")}\n`,
    );
    return 2;
  }
  if (options.refreshLocal && selectedProvider !== undefined && selectedProvider !== "ollama") {
    io.stderr.write(
      "usage/config error: --refresh-local can only be used with --provider ollama\n",
    );
    return 2;
  }

  let effectivePolicy: EffectiveRuntimePolicy;
  try {
    effectivePolicy = resolveEffectiveRuntimePolicy(
      await loadRuntimePolicyRegistry({
        ...(options.policyConfig === undefined
          ? {}
          : { configPath: options.policyConfig }),
        env: runtime.env,
        platform: runtime.platform,
        workspace: runtime.cwd,
      }),
      options.policyProfile,
    );
  } catch (error) {
    if (error instanceof RuntimePolicyError) {
      io.stderr.write(`${error.code}: ${error.message}\n`);
      return error.exitCode === 1 ? 1 : 2;
    }
    io.stderr.write("runtime policy internal error\n");
    return 1;
  }

  let localDiscovery: readonly OllamaLocalModelDiscovery[] = [];
  if (options.refreshLocal) {
    const baseURL = resolveLoopbackOllamaURL(
      runtime.env.BORN_OLLAMA_BASE_URL ??
        DEFAULT_OLLAMA_LOCAL_CATALOG_BASE_URL,
    );
    if (!baseURL.ok) {
      io.stderr.write(`usage/config error: ${baseURL.error}\n`);
      return 2;
    }
    try {
      resolveProviderPolicyRequest(effectivePolicy, {
        endpoint: baseURL.value,
        model: "qwen3:1.7b",
        provider: "ollama",
      });
    } catch (error) {
      if (error instanceof RuntimePolicyError) {
        io.stderr.write(`${error.code}: ${error.message}\n`);
        return 2;
      }
      return 1;
    }
    try {
      localDiscovery = await runtime.refreshLocalModelCatalog({
        baseURL: baseURL.value,
        timeoutMs: OLLAMA_LOCAL_CATALOG_TIMEOUT_MS,
      });
    } catch (error) {
      const code =
        error instanceof OllamaLocalCatalogError
          ? error.code
          : "local_catalog_http_error";
      io.stderr.write(`local Ollama catalog refresh failed: ${code}\n`);
      return 3;
    }
  }

  const entries = createPhase8ModelCatalog().list(selectedProvider);
  const listed: ListedModel[] = entries.map((entry) => {
    let enabled = true;
    try {
      resolveProviderPolicyRequest(effectivePolicy, {
        model: entry.modelId,
        provider: entry.provider,
      });
    } catch (error) {
      if (!(error instanceof RuntimePolicyError)) throw error;
      enabled = false;
    }
    // PHASE15: catalog inspection is not provider selection. A remote key is
    // read only when the caller selected both a remote profile and one exact
    // provider filter; disabled rows always report not_read.
    const credentialStatus =
      entry.credentialVariable === null
        ? "not_required"
        : enabled &&
            effectivePolicy.entry.profile.mode === "remote_explicit" &&
            selectedProvider === entry.provider
          ? new CredentialResolver(runtime.env).resolve(entry.provider).status
          : "not_read";
    return {
      ...entry,
      credentialStatus,
      policyStatus: enabled ? "enabled" : "disabled_by_policy",
    };
  });

  if (options.json) {
    // PHASE8: the model list is a versioned local manifest. It reports
    // contract evidence and credential presence independently and performs no
    // provider/catalog request, even when a key happens to be configured.
    io.stdout.write(
      `${JSON.stringify(
        {
          catalog: {
            localCatalogRequestCount: options.refreshLocal ? 1 : 0,
            mayBeStale: true,
            package: PI_AI_PACKAGE_NAME,
            remoteCatalogRequestCount: 0,
            version: PI_AI_PACKAGE_VERSION,
          },
          localDiscovery: {
            endpointScope: "literal_loopback_only",
            evidenceStatus: "discovery_only_not_capability_evidence",
            models: localDiscovery,
            refreshRequested: options.refreshLocal,
          },
          models: listed,
          runtimePolicy: persistRuntimePolicyEvidence(effectivePolicy.evidence),
          schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    io.stdout.write(renderTable(listed));
    if (options.refreshLocal) {
      io.stdout.write(renderLocalDiscovery(localDiscovery));
    }
  }
  return 0;
}
