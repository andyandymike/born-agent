import type {
  ParsedCapabilityComponent,
  ParsedPluginManifest,
} from "./plugin-manifest-schema.js";

export type CapabilityKind = "hook" | "mcp_server" | "skill";
export type CapabilitySourceKind = "builtin" | "user_install" | "workspace";
export type RequestedEffect =
  | "network"
  | "process_spawn"
  | "workspace_read"
  | "workspace_write";

export interface PackageInventoryEntry {
  readonly byteLength: number;
  readonly mediaType: string;
  readonly path: string;
  readonly sha256: string;
}

export interface CapabilityComponentMetadata {
  readonly componentId: string;
  readonly componentPath: string;
  readonly componentSha256: string;
  readonly description: string;
  readonly displayName: string;
  readonly kind: CapabilityKind;
  readonly metadata: ParsedCapabilityComponent;
  readonly requestedEffects: readonly RequestedEffect[];
}

export interface StableCapabilityPackage {
  readonly components: readonly CapabilityComponentMetadata[];
  readonly description: string;
  readonly displayName: string;
  readonly inventory: readonly PackageInventoryEntry[];
  readonly inventorySha256: string;
  readonly manifestBytes: Uint8Array;
  readonly manifest: ParsedPluginManifest;
  readonly manifestSha256: string;
  readonly packageRoot: string;
  readonly pluginId: string;
  readonly pluginSha256: string;
  readonly pluginVersion: string;
}

export interface CapabilityPackageCandidate {
  readonly enabled: boolean;
  readonly enablementRevision: number;
  readonly expectedPluginId: string;
  readonly expectedPluginSha256: string;
  readonly expectedPluginVersion: string;
  readonly packageRoot: string;
  readonly source: CapabilitySourceKind;
  readonly sourceRef: string;
}

export interface CapabilitySourceDiscovery {
  readonly candidates: readonly CapabilityPackageCandidate[];
  readonly revision: number;
  readonly source: CapabilitySourceKind;
}

export interface CapabilitySource {
  discover(): Promise<CapabilitySourceDiscovery>;
}

export interface FrozenCapabilityIdentity {
  readonly componentId: string;
  readonly componentSha256: string;
  readonly kind: CapabilityKind;
  readonly pluginId: string;
  readonly pluginSha256: string;
  readonly pluginVersion: string;
  readonly qualifiedId: string;
  readonly source: CapabilitySourceKind;
}

export interface FrozenCapabilityRecord {
  readonly componentPath: string;
  readonly description: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly identity: FrozenCapabilityIdentity;
  readonly metadata: ParsedCapabilityComponent;
  readonly requestedEffects: readonly RequestedEffect[];
  readonly sourceRef: string;
}

export interface FrozenPluginRecord {
  readonly components: readonly FrozenCapabilityRecord[];
  readonly description: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly inventorySha256: string;
  readonly inventory: readonly PackageInventoryEntry[];
  readonly manifest: ParsedPluginManifest;
  readonly manifestSha256: string;
  readonly pluginId: string;
  readonly pluginSha256: string;
  readonly pluginVersion: string;
  readonly source: CapabilitySourceKind;
  readonly sourceRef: string;
}

export interface CapabilityCatalogDiagnostic {
  readonly code: string;
  readonly identity?: string;
  readonly level: "warning";
  readonly message: string;
}

export interface CapabilityCatalog {
  readonly diagnostics: readonly CapabilityCatalogDiagnostic[];
  readonly enablementRevision: number;
  readonly plugins: readonly FrozenPluginRecord[];
  readonly sourceRevisions: Readonly<Record<CapabilitySourceKind, number>>;
}

export interface CapabilitySnapshotV1 {
  readonly capabilitySchemaSha256: string;
  readonly createdAt: string;
  readonly enablementRevision: number;
  readonly plugins: readonly FrozenPluginRecord[];
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly snapshotSha256: string;
  readonly sourceRevisions: Readonly<Record<CapabilitySourceKind, number>>;
  readonly workspaceIdentitySha256: string;
}

export interface PersistedCapabilitySnapshotBindingV1 {
  readonly artifact_id: `sha256:${string}`;
  readonly bytes: number;
  readonly capability_schema_sha256: string;
  readonly component_count: number;
  readonly eligible_plugin_count: number;
  readonly enablement_revision: number;
  readonly object_ref: string;
  readonly schema_version: 1;
  readonly sha256: string;
  readonly snapshot_id: string;
  readonly source_revisions: Readonly<Record<CapabilitySourceKind, number>>;
}
