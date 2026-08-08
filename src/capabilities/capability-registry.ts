import { formatQualifiedCapabilityId } from "./capability-id.js";
import { CapabilityError } from "./capability-errors.js";
import { sha256Canonical } from "../completion/canonical-json.js";
import type {
  CapabilityCatalog,
  CapabilityCatalogDiagnostic,
  CapabilityKind,
  CapabilitySource,
  CapabilitySourceKind,
  FrozenCapabilityIdentity,
  FrozenCapabilityRecord,
  FrozenPluginRecord,
  StableCapabilityPackage,
} from "./capability-types.js";
import { StablePackageReader } from "./stable-package-reader.js";

const MAX_CANDIDATES = 32;
const MAX_ELIGIBLE_PLUGINS = 16;
const KIND_LIMITS: Readonly<Record<CapabilityKind, number>> = Object.freeze({
  hook: 32,
  mcp_server: 8,
  skill: 64,
});

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freezeIdentity(
  source: CapabilitySourceKind,
  plugin: StableCapabilityPackage,
  component: StableCapabilityPackage["components"][number],
): FrozenCapabilityIdentity {
  return Object.freeze({
    componentId: component.componentId,
    componentSha256: component.componentSha256,
    kind: component.kind,
    pluginId: plugin.pluginId,
    pluginSha256: plugin.pluginSha256,
    pluginVersion: plugin.pluginVersion,
    qualifiedId: formatQualifiedCapabilityId({
      componentId: component.componentId,
      componentSha256: component.componentSha256,
      kind: component.kind,
      pluginId: plugin.pluginId,
      pluginVersion: plugin.pluginVersion,
      source,
    }),
    source,
  });
}

function pluginRecord(input: {
  readonly enabled: boolean;
  readonly package: StableCapabilityPackage;
  readonly source: CapabilitySourceKind;
  readonly sourceRef: string;
}): FrozenPluginRecord {
  const components: readonly FrozenCapabilityRecord[] = Object.freeze(
    input.package.components.map((component) => Object.freeze({
      componentPath: component.componentPath,
      description: component.description,
      displayName: component.displayName,
      enabled: input.enabled,
      identity: freezeIdentity(input.source, input.package, component),
      metadata: component.metadata,
      requestedEffects: Object.freeze([...component.requestedEffects]),
      sourceRef: input.sourceRef,
    })),
  );
  return Object.freeze({
    components,
    description: input.package.description,
    displayName: input.package.displayName,
    enabled: input.enabled,
    inventory: input.package.inventory,
    inventorySha256: input.package.inventorySha256,
    manifest: input.package.manifest,
    manifestSha256: input.package.manifestSha256,
    pluginId: input.package.pluginId,
    pluginSha256: input.package.pluginSha256,
    pluginVersion: input.package.pluginVersion,
    source: input.source,
    sourceRef: input.sourceRef,
  });
}

function samePluginIdentity(left: FrozenPluginRecord, right: FrozenPluginRecord): boolean {
  return left.source === right.source &&
    left.pluginId === right.pluginId &&
    left.pluginVersion === right.pluginVersion &&
    left.pluginSha256 === right.pluginSha256;
}

function conflictKey(plugin: FrozenPluginRecord): string {
  return `${plugin.source}:${plugin.pluginId}@${plugin.pluginVersion}`;
}

function allRecords(catalog: CapabilityCatalog): readonly FrozenCapabilityRecord[] {
  return Object.freeze(catalog.plugins.flatMap((plugin) => plugin.components));
}

function discoveryIdentity(
  discoveries: readonly Awaited<ReturnType<CapabilitySource["discover"]>>[],
): string {
  return sha256Canonical(discoveries.map((discovery) => ({
    candidates: discovery.candidates.map((candidate) => ({
      enabled: candidate.enabled,
      enablementRevision: candidate.enablementRevision,
      expectedPluginId: candidate.expectedPluginId,
      expectedPluginSha256: candidate.expectedPluginSha256,
      expectedPluginVersion: candidate.expectedPluginVersion,
      packageRoot: candidate.packageRoot,
      source: candidate.source,
      sourceRef: candidate.sourceRef,
    })),
    revision: discovery.revision,
    source: discovery.source,
  })));
}

export class FrozenCapabilityRegistry {
  readonly catalog: CapabilityCatalog;
  readonly #records: readonly FrozenCapabilityRecord[];

  constructor(catalog: CapabilityCatalog) {
    this.catalog = catalog;
    this.#records = allRecords(catalog);
    Object.freeze(this);
  }

  list(kind?: CapabilityKind, enabledOnly = false): readonly FrozenCapabilityRecord[] {
    return Object.freeze(
      this.#records.filter((record) =>
        (kind === undefined || record.identity.kind === kind) &&
        (!enabledOnly || record.enabled),
      ),
    );
  }

  getExact(qualifiedId: string): FrozenCapabilityRecord {
    const matches = this.#records.filter((record) => record.identity.qualifiedId === qualifiedId);
    if (matches.length === 0) {
      throw new CapabilityError("capability_not_found", "capability ID is not in the current catalog");
    }
    if (matches.length !== 1) {
      throw new CapabilityError("capability_conflict", "exact capability ID is ambiguous");
    }
    return matches[0]!;
  }

  resolveUniqueReadOnly(selector: string): FrozenCapabilityRecord {
    const matches = this.#records.filter((record) => {
      const identity = record.identity;
      return identity.qualifiedId === selector ||
        identity.componentId === selector ||
        `${identity.pluginId}/${identity.componentId}` === selector ||
        `${identity.pluginId}/${identity.kind}/${identity.componentId}` === selector;
    });
    if (matches.length === 0) {
      throw new CapabilityError("capability_not_found", "capability selector has no match");
    }
    if (matches.length !== 1) {
      // PHASE18: source order is never an authority rule. A short selector must
      // fail instead of letting workspace/user content shadow another package.
      throw new CapabilityError(
        "capability_conflict",
        "capability selector is ambiguous; use the fully qualified ID",
      );
    }
    return matches[0]!;
  }
}

export class CapabilityRegistryBuilder {
  constructor(private readonly sources: readonly CapabilitySource[]) {}

  async build(): Promise<FrozenCapabilityRegistry> {
    const discoveries = await Promise.all(this.sources.map((source) => source.discover()));
    const sourceRevisions: Record<CapabilitySourceKind, number> = {
      builtin: 0,
      user_install: 0,
      workspace: 0,
    };
    const candidates = discoveries.flatMap((discovery) => {
      sourceRevisions[discovery.source] = discovery.revision;
      return discovery.candidates;
    });
    if (candidates.length > MAX_CANDIDATES) {
      throw new CapabilityError(
        "capability_limit_exceeded",
        "capability source candidate count exceeds its limit",
      );
    }
    const plugins: FrozenPluginRecord[] = [];
    const diagnostics: CapabilityCatalogDiagnostic[] = [];
    for (const candidate of candidates.sort((left, right) =>
      ordinal(`${left.source}:${left.sourceRef}`, `${right.source}:${right.sourceRef}`),
    )) {
      let stable: StableCapabilityPackage;
      try {
        stable = await StablePackageReader.read(candidate.packageRoot);
      } catch (error) {
        if (candidate.source === "builtin" && error instanceof CapabilityError) {
          throw new CapabilityError(
            "capability_state_invalid",
            "built-in capability package failed its release invariant",
            3,
            { cause: error },
          );
        }
        throw error;
      }
      if (stable.pluginSha256 !== candidate.expectedPluginSha256) {
        throw new CapabilityError(
          "plugin_tampered_or_conflicting",
          `${candidate.source} capability package does not match its expected digest`,
        );
      }
      if (
        stable.pluginId !== candidate.expectedPluginId ||
        stable.pluginVersion !== candidate.expectedPluginVersion
      ) {
        throw new CapabilityError(
          "plugin_tampered_or_conflicting",
          `${candidate.source} capability package identity does not match its exact enablement record`,
        );
      }
      if (candidate.enabled && stable.components.length === 0) {
        throw new CapabilityError(
          "capability_component_invalid",
          "an enabled capability package must contain at least one component",
        );
      }
      const record = pluginRecord({
        enabled: candidate.enabled,
        package: stable,
        source: candidate.source,
        sourceRef: candidate.sourceRef,
      });
      const sameKey = plugins.find((plugin) => conflictKey(plugin) === conflictKey(record));
      if (sameKey !== undefined) {
        if (!samePluginIdentity(sameKey, record)) {
          throw new CapabilityError(
            "plugin_tampered_or_conflicting",
            "one source contains the same plugin/version with different package bytes",
          );
        }
        diagnostics.push(Object.freeze({
          code: "capability_duplicate_exact_identity",
          identity: conflictKey(record),
          level: "warning",
          message: "duplicate exact package identity was deduplicated",
        }));
        continue;
      }
      if (record.source === "workspace") {
        diagnostics.push(Object.freeze({
          code: "capability_workspace_content_untrusted",
          identity: `${record.pluginId}@${record.pluginVersion}`,
          level: "warning",
          message: "workspace capability content remains untrusted even when enabled",
        }));
      }
      plugins.push(record);
    }

    const currentDiscoveries = await Promise.all(
      this.sources.map((source) => source.discover()),
    );
    if (discoveryIdentity(discoveries) !== discoveryIdentity(currentDiscoveries)) {
      throw new CapabilityError(
        "capability_source_unstable",
        "capability enablement changed while the registry was frozen",
      );
    }

    const eligible = plugins.filter((plugin) => plugin.enabled);
    if (eligible.length > MAX_ELIGIBLE_PLUGINS) {
      throw new CapabilityError(
        "capability_limit_exceeded",
        "enabled plugin count exceeds the per-run limit",
      );
    }
    for (const kind of Object.keys(KIND_LIMITS) as CapabilityKind[]) {
      const count = eligible.reduce(
        (total, plugin) => total + plugin.components.filter((component) => component.identity.kind === kind).length,
        0,
      );
      if (count > KIND_LIMITS[kind]) {
        throw new CapabilityError(
          "capability_limit_exceeded",
          `enabled ${kind} component count exceeds its per-run limit`,
        );
      }
    }
    const sortedPlugins = Object.freeze(plugins.sort((left, right) =>
      ordinal(
        `${left.source}:${left.pluginId}@${left.pluginVersion}:${left.pluginSha256}`,
        `${right.source}:${right.pluginId}@${right.pluginVersion}:${right.pluginSha256}`,
      ),
    ));
    const catalog: CapabilityCatalog = Object.freeze({
      diagnostics: Object.freeze(diagnostics.sort((left, right) =>
        ordinal(
          `${left.code}:${left.identity ?? ""}:${left.message}`,
          `${right.code}:${right.identity ?? ""}:${right.message}`,
        ),
      )),
      enablementRevision: sourceRevisions.user_install,
      plugins: sortedPlugins,
      sourceRevisions: Object.freeze({ ...sourceRevisions }),
    });
    return new FrozenCapabilityRegistry(catalog);
  }
}
