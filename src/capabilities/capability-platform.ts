import type { FrozenCapabilityRegistry } from "./capability-registry.js";
import { CapabilityRegistryBuilder } from "./capability-registry.js";
import {
  BuiltinCapabilitySource,
  resolveCapabilityUserStateRoot,
  UserInstallCapabilitySource,
  WorkspaceCapabilitySource,
} from "./capability-source.js";
import { createCapabilitySnapshot } from "./capability-snapshot.js";
import type { CapabilitySnapshotV1 } from "./capability-types.js";

export interface CapabilityPlatformLike {
  buildRegistry(): Promise<FrozenCapabilityRegistry>;
  createSnapshot(timestamp: string): Promise<CapabilitySnapshotV1>;
}

export class DefaultCapabilityPlatform implements CapabilityPlatformLike {
  constructor(
    private readonly options: {
      readonly builtinRoot: string;
      readonly env: Readonly<Record<string, string | undefined>>;
      readonly platform: NodeJS.Platform;
      readonly userStateRoot?: string;
      readonly workspace: string;
    },
  ) {}

  async buildRegistry(): Promise<FrozenCapabilityRegistry> {
    return new CapabilityRegistryBuilder([
      new BuiltinCapabilitySource(this.options.builtinRoot),
      new UserInstallCapabilitySource(
        this.options.userStateRoot ?? resolveCapabilityUserStateRoot(this.options),
      ),
      new WorkspaceCapabilitySource(this.options.workspace),
    ]).build();
  }

  async createSnapshot(timestamp: string): Promise<CapabilitySnapshotV1> {
    const registry = await this.buildRegistry();
    return createCapabilitySnapshot({
      catalog: registry.catalog,
      platform: this.options.platform,
      timestamp,
      workspace: this.options.workspace,
    });
  }
}
