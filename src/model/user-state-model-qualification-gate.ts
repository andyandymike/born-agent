import { ModelCapabilityRegistry } from "./model-capability-registry.js";
import type { ModelQualificationGate } from "./model-qualification-gate.js";
import { RegistryModelQualificationGate } from "./registry-model-qualification-gate.js";
import { resolvePiModelQualificationTarget } from "./model-qualification-target.js";
import { ModelQualificationStore } from "./model-qualification-store.js";
import type { OllamaLocalModelDiscovery } from "../providers/pi/ollama-local-catalog-port.js";

export class UserStateModelQualificationGate implements ModelQualificationGate {
  constructor(
    private readonly options: {
      readonly env: Readonly<Record<string, string | undefined>>;
      readonly platform: NodeJS.Platform;
      readonly refreshLocalModelCatalog: (request: {
        readonly baseURL: string;
        readonly timeoutMs: number;
      }) => Promise<readonly OllamaLocalModelDiscovery[]>;
      readonly storeRoot?: string | undefined;
    },
  ) {}

  async requireQualified(input: {
    readonly endpoint?: string | undefined;
    readonly mode: "plan" | "build";
    readonly model: string;
    readonly policyHash: string;
    readonly policyProfileId: string;
    readonly provider: string;
    readonly source?: "in_process_test" | "local_ollama" | "provider_network" | undefined;
  }): Promise<{ readonly evidenceSha256: string }> {
    const store = await ModelQualificationStore.create({
      env: this.options.env,
      platform: this.options.platform,
      ...(this.options.storeRoot === undefined
        ? {}
        : { root: this.options.storeRoot }),
    });
    const registry = new ModelCapabilityRegistry(store);
    return new RegistryModelQualificationGate(registry, async (request) => {
      const target = await resolvePiModelQualificationTarget({
        endpoint: request.endpoint,
        model: request.model,
        policyProfileId: request.policyProfileId,
        policyProfileSha256: request.policyHash,
        provider: request.provider,
        refreshLocalModelCatalog: this.options.refreshLocalModelCatalog,
      });
      return target.identity;
    }).requireQualified(input);
  }
}
