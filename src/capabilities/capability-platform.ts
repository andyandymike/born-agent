import type { FrozenCapabilityRegistry } from "./capability-registry.js";
import { CapabilityRegistryBuilder } from "./capability-registry.js";
import {
  BuiltinCapabilitySource,
  resolveCapabilityUserStateRoot,
  UserInstallCapabilitySource,
  WorkspaceCapabilitySource,
} from "./capability-source.js";
import { createCapabilitySnapshot } from "./capability-snapshot.js";
import { posix, resolve } from "node:path";

import { CapabilityError } from "./capability-errors.js";
import type {
  CapabilitySnapshotV1,
  FrozenCapabilityIdentity,
  FrozenCapabilityRecord,
  FrozenPluginRecord,
} from "./capability-types.js";
import { StablePackageReader } from "./stable-package-reader.js";
import type {
  CapabilityContentLease,
  CapabilityContentLeaseOwner,
  PluginLifecycleLike,
} from "../plugins/plugin-lifecycle.js";

export interface FrozenCapabilityContent {
  readonly absolutePath: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly packageRoot: string;
  readonly path: string;
  readonly sha256: string;
}

export interface FrozenCapabilityContentSource {
  readComponentFile(
    identity: FrozenCapabilityIdentity,
    declaredRelativePath: string,
  ): Promise<FrozenCapabilityContent>;
}

export interface CapabilityPlatformLike {
  acquireContentLeases?(
    snapshot: CapabilitySnapshotV1,
    owner: CapabilityContentLeaseOwner,
  ): Promise<readonly CapabilityContentLease[]>;
  buildRegistry(): Promise<FrozenCapabilityRegistry>;
  createContentSource(snapshot: CapabilitySnapshotV1): FrozenCapabilityContentSource;
  createSnapshot(timestamp: string): Promise<CapabilitySnapshotV1>;
}

function pluginForIdentity(
  snapshot: CapabilitySnapshotV1,
  identity: FrozenCapabilityIdentity,
): FrozenPluginRecord {
  const plugin = snapshot.plugins.find((candidate) =>
    candidate.source === identity.source &&
    candidate.pluginId === identity.pluginId &&
    candidate.pluginVersion === identity.pluginVersion &&
    candidate.pluginSha256 === identity.pluginSha256,
  );
  if (plugin === undefined) {
    throw new CapabilityError(
      "capability_snapshot_stale",
      "capability content identity is not present in the frozen run snapshot",
    );
  }
  return plugin;
}

function componentForIdentity(
  plugin: FrozenPluginRecord,
  identity: FrozenCapabilityIdentity,
): FrozenCapabilityRecord {
  const component = plugin.components.find((candidate) =>
    candidate.identity.qualifiedId === identity.qualifiedId &&
    candidate.identity.componentSha256 === identity.componentSha256,
  );
  if (component === undefined) {
    throw new CapabilityError(
      "capability_snapshot_stale",
      "capability component is not present in its frozen package",
    );
  }
  return component;
}

function sourceRelativePath(sourceRef: string, expectedSource: string): string {
  const prefix = `${expectedSource}:`;
  if (!sourceRef.startsWith(prefix)) {
    throw new CapabilityError(
      "capability_snapshot_stale",
      "frozen capability source reference is inconsistent",
    );
  }
  const value = sourceRef.slice(prefix.length);
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new CapabilityError(
      "capability_snapshot_stale",
      "frozen capability source reference is invalid",
    );
  }
  return value;
}

function mediaType(path: string): string {
  const extension = posix.extname(path).toLowerCase();
  if (extension === ".md") return "text/markdown; charset=utf-8";
  if (extension === ".txt" || extension === ".json") {
    return extension === ".json"
      ? "application/json; charset=utf-8"
      : "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

export class DefaultCapabilityPlatform implements CapabilityPlatformLike {
  constructor(
    private readonly options: {
      readonly builtinRoot: string;
      readonly env: Readonly<Record<string, string | undefined>>;
      readonly platform: NodeJS.Platform;
      readonly pluginLifecycle?: PluginLifecycleLike;
      readonly userStateRoot?: string;
      readonly workspace: string;
    },
  ) {}

  async acquireContentLeases(
    snapshot: CapabilitySnapshotV1,
    owner: CapabilityContentLeaseOwner,
  ): Promise<readonly CapabilityContentLease[]> {
    const digests = snapshot.plugins
      .filter((plugin) => plugin.source === "user_install")
      .map((plugin) => plugin.pluginSha256);
    return this.options.pluginLifecycle?.acquireLeases(digests, owner) ?? [];
  }

  async buildRegistry(): Promise<FrozenCapabilityRegistry> {
    return new CapabilityRegistryBuilder([
      new BuiltinCapabilitySource(this.options.builtinRoot),
      new UserInstallCapabilitySource(
        this.options.userStateRoot ?? resolveCapabilityUserStateRoot(this.options),
      ),
      new WorkspaceCapabilitySource(this.options.workspace),
    ]).build();
  }

  createContentSource(snapshot: CapabilitySnapshotV1): FrozenCapabilityContentSource {
    const userRoot = this.options.userStateRoot ?? resolveCapabilityUserStateRoot(this.options);
    const roots = Object.freeze({
      builtin: resolve(this.options.builtinRoot),
      user_install: resolve(userRoot),
      workspace: resolve(this.options.workspace),
    });
    return Object.freeze({
      readComponentFile: async (
        identity: FrozenCapabilityIdentity,
        declaredRelativePath: string,
      ): Promise<FrozenCapabilityContent> => {
        const plugin = pluginForIdentity(snapshot, identity);
        const component = componentForIdentity(plugin, identity);
        const packageRelative = sourceRelativePath(plugin.sourceRef, plugin.source);
        const packageRoot = resolve(roots[plugin.source], ...packageRelative.split("/"));
        const stable = await StablePackageReader.read(packageRoot);
        if (
          stable.pluginSha256 !== plugin.pluginSha256 ||
          stable.manifestSha256 !== plugin.manifestSha256 ||
          stable.inventorySha256 !== plugin.inventorySha256
        ) {
          throw new CapabilityError(
            "capability_snapshot_stale",
            "capability package bytes changed after the run snapshot was frozen",
          );
        }
        const componentDirectory = posix.dirname(component.componentPath);
        const path = componentDirectory === "."
          ? declaredRelativePath
          : posix.join(componentDirectory, declaredRelativePath);
        const expected = plugin.inventory.find((entry) => entry.path === path);
        const captured = stable.files.find((entry) => entry.path === path);
        if (
          expected === undefined ||
          captured === undefined ||
          expected.sha256 !== captured.sha256
        ) {
          throw new CapabilityError(
            "capability_snapshot_stale",
            "declared capability content does not match the frozen inventory",
          );
        }
        // PHASE18: selection is bound to run-frozen package bytes. A later
        // source edit can only make the action stale; it never hot-rebinds it.
        return Object.freeze({
          absolutePath: resolve(packageRoot, ...path.split("/")),
          bytes: Uint8Array.from(captured.bytes),
          mediaType: mediaType(path),
          packageRoot,
          path,
          sha256: captured.sha256,
        });
      },
    });
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
