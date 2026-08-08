import { realpath } from "node:fs/promises";

import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";
import { formatQualifiedCapabilityId } from "./capability-id.js";
import { CapabilityError } from "./capability-errors.js";
import type {
  CapabilityCatalog,
  CapabilitySnapshotV1,
  FrozenPluginRecord,
  PersistedCapabilitySnapshotBindingV1,
} from "./capability-types.js";
import {
  CAPABILITY_PLATFORM_SCHEMA_SHA256,
  capabilityRelativePathSchema,
  componentSchema,
  pluginManifestSchema,
} from "./plugin-manifest-schema.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const source = z.enum(["builtin", "user_install", "workspace"]);
const kind = z.enum(["skill", "hook", "mcp_server"]);
const requestedEffect = z.enum([
  "workspace_read",
  "workspace_write",
  "process_spawn",
  "network",
]);
const sourceRevisionsSchema = z
  .object({
    builtin: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    user_install: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    workspace: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const identitySchema = z
  .object({
    componentId: z.string().min(1).max(80),
    componentSha256: sha256,
    kind,
    pluginId: z.string().min(1).max(80),
    pluginSha256: sha256,
    pluginVersion: z.string().min(1).max(64),
    qualifiedId: z.string().min(1).max(512),
    source,
  })
  .strict();
const inventoryEntrySchema = z
  .object({
    byteLength: z.number().int().nonnegative().max(16 * 1024 * 1024),
    mediaType: z.string().min(1).max(128),
    path: capabilityRelativePathSchema,
    sha256,
  })
  .strict();
const capabilityRecordSchema = z
  .object({
    componentPath: capabilityRelativePathSchema,
    description: z.string().min(1).max(512),
    displayName: z.string().min(1).max(120),
    enabled: z.literal(true),
    identity: identitySchema,
    metadata: componentSchema,
    requestedEffects: z.array(requestedEffect).max(8),
    sourceRef: z.string().min(1).max(1024),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.metadata.kind !== value.identity.kind ||
      value.metadata.component_id !== value.identity.componentId ||
      value.identity.qualifiedId !== formatQualifiedCapabilityId({
        componentId: value.identity.componentId,
        componentSha256: value.identity.componentSha256,
        kind: value.identity.kind,
        pluginId: value.identity.pluginId,
        pluginVersion: value.identity.pluginVersion,
        source: value.identity.source,
      })
    ) {
      context.addIssue({
        code: "custom",
        message: "frozen component metadata does not match its identity",
      });
    }
  });
const pluginRecordSchema = z
  .object({
    components: z.array(capabilityRecordSchema).max(128),
    description: z.string().min(1).max(512),
    displayName: z.string().min(1).max(120),
    enabled: z.literal(true),
    inventory: z.array(inventoryEntrySchema).min(1).max(512),
    inventorySha256: sha256,
    manifest: pluginManifestSchema,
    manifestSha256: sha256,
    pluginId: z.string().min(1).max(80),
    pluginSha256: sha256,
    pluginVersion: z.string().min(1).max(64),
    source,
    sourceRef: z.string().min(1).max(1024),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.manifest.plugin_id !== value.pluginId ||
      value.manifest.plugin_version !== value.pluginVersion ||
      value.manifest.display_name !== value.displayName ||
      value.manifest.description !== value.description
    ) {
      context.addIssue({
        code: "custom",
        message: "frozen manifest does not match its package identity",
      });
    }
    if (
      value.inventorySha256 !== sha256Canonical({
        files: value.inventory,
        schemaVersion: 1,
      }) ||
      value.pluginSha256 !== sha256Canonical({
        files: value.inventory,
        manifestSha256: value.manifestSha256,
        schemaVersion: 1,
      })
    ) {
      context.addIssue({
        code: "custom",
        message: "frozen package digest does not match its inventory",
      });
    }
    const paths = value.inventory.map((entry) => entry.path);
    if (
      paths.join("\0") !== [...paths].sort().join("\0") ||
      new Set(paths.map((path) => path.toLowerCase())).size !== paths.length
    ) {
      context.addIssue({
        code: "custom",
        message: "frozen package inventory is not canonical",
      });
    }
    const inventory = new Map(value.inventory.map((entry) => [entry.path, entry]));
    for (const component of value.components) {
      const declared =
        component.identity.kind === "skill"
          ? value.manifest.components.skills
          : component.identity.kind === "hook"
            ? value.manifest.components.hooks
            : value.manifest.components.mcp_servers;
      if (
        declared?.includes(component.componentPath) !== true ||
        inventory.get(component.componentPath)?.sha256 !==
          component.identity.componentSha256 ||
        component.identity.pluginId !== value.pluginId ||
        component.identity.pluginVersion !== value.pluginVersion ||
        component.identity.pluginSha256 !== value.pluginSha256 ||
        component.identity.source !== value.source
      ) {
        context.addIssue({
          code: "custom",
          message: "frozen component is not bound to its manifest inventory",
        });
      }
    }
  });

const snapshotBaseSchema = z
  .object({
    capabilitySchemaSha256: sha256,
    createdAt: z.string().datetime({ offset: true }).refine((value) => value.endsWith("Z")),
    enablementRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    plugins: z.array(pluginRecordSchema).max(16),
    schemaVersion: z.literal(1),
    snapshotId: z.string().regex(/^capability-snapshot:[a-f0-9]{64}$/u),
    snapshotSha256: sha256,
    sourceRevisions: sourceRevisionsSchema,
    workspaceIdentitySha256: sha256,
  })
  .strict();

function descriptor(input: Omit<CapabilitySnapshotV1, "createdAt" | "snapshotId" | "snapshotSha256">): unknown {
  return {
    capabilitySchemaSha256: input.capabilitySchemaSha256,
    enablementRevision: input.enablementRevision,
    plugins: input.plugins,
    schemaVersion: input.schemaVersion,
    sourceRevisions: input.sourceRevisions,
    workspaceIdentitySha256: input.workspaceIdentitySha256,
  };
}

export const capabilitySnapshotSchema = snapshotBaseSchema.superRefine((value, context) => {
  const snapshotSha256 = sha256Canonical(descriptor(value));
  if (
    value.capabilitySchemaSha256 !== CAPABILITY_PLATFORM_SCHEMA_SHA256 ||
    value.snapshotSha256 !== snapshotSha256 ||
    value.snapshotId !== `capability-snapshot:${snapshotSha256}`
  ) {
    context.addIssue({ code: "custom", message: "capability snapshot identity is inconsistent" });
  }
});

export const persistedCapabilitySnapshotBindingSchema = z
  .object({
    artifact_id: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    bytes: z.number().int().positive().max(16 * 1024 * 1024),
    capability_schema_sha256: sha256,
    component_count: z.number().int().nonnegative().max(128),
    eligible_plugin_count: z.number().int().nonnegative().max(16),
    enablement_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    object_ref: z.string().regex(/^artifacts\/[0-9a-f-]{36}\/objects\/[a-f0-9]{64}$/u),
    schema_version: z.literal(1),
    sha256,
    snapshot_id: z.string().regex(/^capability-snapshot:[a-f0-9]{64}$/u),
    source_revisions: sourceRevisionsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.artifact_id !== `sha256:${value.sha256}` ||
      !value.object_ref.endsWith(`/objects/${value.sha256}`) ||
      value.capability_schema_sha256 !== CAPABILITY_PLATFORM_SCHEMA_SHA256
    ) {
      context.addIssue({ code: "custom", message: "capability snapshot binding is inconsistent" });
    }
  });

function freezeEnabledPlugin(plugin: FrozenPluginRecord): FrozenPluginRecord {
  return Object.freeze({
    ...plugin,
    components: Object.freeze(plugin.components.map((component) => Object.freeze({
      ...component,
      enabled: true as const,
      identity: Object.freeze({ ...component.identity }),
      requestedEffects: Object.freeze([...component.requestedEffects]),
    }))),
    enabled: true,
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Readonly<Record<string, unknown>>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

export async function createCapabilitySnapshot(input: {
  readonly catalog: CapabilityCatalog;
  readonly platform: NodeJS.Platform;
  readonly timestamp: string;
  readonly workspace: string;
}): Promise<CapabilitySnapshotV1> {
  const root = (await realpath(input.workspace)).replaceAll("\\", "/").normalize("NFC");
  const workspaceIdentitySha256 = sha256Canonical({
    path: input.platform === "win32" ? root.toLowerCase() : root,
    platformPathSemantics: input.platform === "win32" ? "case_insensitive" : "case_sensitive",
    schemaVersion: 1,
  });
  const plugins = Object.freeze(
    // PHASE18: full canonical manifest/component metadata and inventory live
    // inside the snapshot artifact, so replay never consults current sources.
    input.catalog.plugins.filter((plugin) => plugin.enabled).map(freezeEnabledPlugin),
  );
  const unsigned = Object.freeze({
    capabilitySchemaSha256: CAPABILITY_PLATFORM_SCHEMA_SHA256,
    enablementRevision: input.catalog.enablementRevision,
    plugins,
    schemaVersion: 1 as const,
    sourceRevisions: Object.freeze({ ...input.catalog.sourceRevisions }),
    workspaceIdentitySha256,
  });
  const snapshotSha256 = sha256Canonical(descriptor(unsigned));
  try {
    return deepFreeze(capabilitySnapshotSchema.parse({
      ...unsigned,
      createdAt: input.timestamp,
      snapshotId: `capability-snapshot:${snapshotSha256}`,
      snapshotSha256,
    }));
  } catch (error) {
    throw new CapabilityError(
      "capability_state_invalid",
      "capability snapshot failed strict validation",
      1,
      { cause: error },
    );
  }
}

export function persistCapabilitySnapshotBinding(
  value: PersistedCapabilitySnapshotBindingV1,
): PersistedCapabilitySnapshotBindingV1 {
  return deepFreeze(
    persistedCapabilitySnapshotBindingSchema.parse(value),
  ) as PersistedCapabilitySnapshotBindingV1;
}
