import { z } from "zod";

import {
  capabilityIdentifierSchema,
  capabilityRelativePathSchema,
  capabilityVersionSchema,
} from "../capabilities/plugin-manifest-schema.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true }).refine(
  (value) => value.endsWith("Z"),
  "timestamp must be UTC",
);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sourceDisplayName = z.string().min(1).max(200).refine(
  (value) => !value.includes("\0") && !value.includes("/") && !value.includes("\\"),
  "source display name must be a bounded logical label",
);

export const installedPluginRecordSchema = z.object({
  schemaVersion: z.literal(1),
  installedAt: timestamp,
  inventorySha256: sha256,
  manifestSha256: sha256,
  pluginId: capabilityIdentifierSchema,
  pluginSha256: sha256,
  pluginVersion: capabilityVersionSchema,
  source: z.object({
    displayName: sourceDisplayName,
    kind: z.literal("local_directory"),
    sourceSnapshotSha256: sha256,
  }).strict(),
}).strict();

export type InstalledPluginRecordV1 = z.infer<typeof installedPluginRecordSchema>;

export const installedPluginIndexEntrySchema = z.object({
  record: installedPluginRecordSchema,
  store_relative_path: capabilityRelativePathSchema,
}).strict();

export const installedPluginIndexSchema = z.object({
  plugins: z.array(installedPluginIndexEntrySchema).max(128).refine(
    (entries) => new Set(entries.map((entry) => entry.record.pluginSha256)).size === entries.length,
    "installed plugin digests must be unique",
  ),
  revision,
  schema_version: z.literal(1),
}).strict();

export type InstalledPluginIndexV1 = z.infer<typeof installedPluginIndexSchema>;

export const pluginEnablementEntrySchema = z.object({
  enabled: z.literal(true),
  expected_plugin_sha256: sha256,
  path: capabilityRelativePathSchema,
  plugin_id: capabilityIdentifierSchema,
  plugin_version: capabilityVersionSchema,
}).strict();

export const pluginEnablementStateSchema = z.object({
  packages: z.array(pluginEnablementEntrySchema).max(32).refine(
    (entries) => new Set(entries.map((entry) => entry.expected_plugin_sha256)).size === entries.length,
    "enabled plugin digests must be unique",
  ),
  revision,
  schema_version: z.literal(1),
}).strict();

export type PluginEnablementStateV1 = z.infer<typeof pluginEnablementStateSchema>;

export const pluginAuditEventSchema = z.object({
  event_id: uuid,
  next_enablement_revision: revision,
  occurred_at: timestamp,
  operation: z.enum(["installed", "enabled", "disabled", "removed", "gc_degraded"]),
  operation_id: uuid,
  plugin: z.object({
    plugin_id: capabilityIdentifierSchema,
    plugin_sha256: sha256,
    plugin_version: capabilityVersionSchema,
    source: z.literal("user_install"),
  }).strict(),
  previous_enablement_revision: revision,
  result: z.enum(["changed", "deduplicated", "degraded"]),
  schema_version: z.literal(1),
}).strict();

export type PluginAuditEventV1 = z.infer<typeof pluginAuditEventSchema>;

const pluginOperationStateTransitionSchema = z.object({
  after_enablement_revision: revision,
  after_installed_revision: revision,
  after_state_sha256: sha256,
  before_enablement_revision: revision,
  before_installed_revision: revision,
  before_state_sha256: sha256,
}).strict().refine(
  (value) => value.before_state_sha256 !== value.after_state_sha256,
  "Plugin operation state transition must change the exact state digest",
);

export const pluginOperationRecordSchema = z.object({
  audit_event_id: uuid.optional(),
  operation: z.enum(["install", "enable", "disable", "remove"]),
  operation_id: uuid,
  plugin_sha256: sha256.optional(),
  reconciliation: z.object({
    evidence_sha256: sha256,
    observed: z.enum(["applied_exact", "not_applied"]),
    reconciled_at: timestamp,
  }).strict().optional(),
  requested_at: timestamp,
  schema_version: z.literal(1),
  state_transition: pluginOperationStateTransitionSchema.optional(),
  state: z.enum(["requested", "completed"]),
}).strict().superRefine((value, context) => {
  if (value.state === "requested" && value.reconciliation !== undefined) {
    context.addIssue({ code: "custom", message: "requested operation cannot carry reconciliation" });
  }
  if (
    value.state === "requested" &&
    (value.audit_event_id === undefined || value.plugin_sha256 === undefined || value.state_transition === undefined)
  ) {
    context.addIssue({ code: "custom", message: "requested operation requires exact audit, digest, and state transition identities" });
  }
  const transition = value.state_transition;
  if (transition === undefined) return;
  const changesInstalled = value.operation === "install" || value.operation === "remove";
  const installedDelta = transition.after_installed_revision - transition.before_installed_revision;
  const enablementDelta = transition.after_enablement_revision - transition.before_enablement_revision;
  if (installedDelta !== (changesInstalled ? 1 : 0)) {
    context.addIssue({ code: "custom", message: "Plugin operation installed revision transition is invalid" });
  }
  if (enablementDelta !== (changesInstalled ? 0 : 1)) {
    context.addIssue({ code: "custom", message: "Plugin operation enablement revision transition is invalid" });
  }
});

export type PluginOperationRecordV1 = z.infer<typeof pluginOperationRecordSchema>;

const legacyCapabilityLeaseRecordSchema = z.object({
  acquired_at: timestamp,
  lease_id: uuid,
  plugin_sha256: sha256,
  run_id: uuid,
  schema_version: z.literal(1),
}).strict();

const durableCapabilityLeaseRecordSchema = z.object({
  acquired_at: timestamp,
  lease_id: uuid,
  plugin_sha256: sha256,
  run_id: uuid,
  schema_version: z.literal(2),
  session_id: uuid,
  session_lock_nonce_sha256: sha256,
}).strict();

export const capabilityLeaseRecordSchema = z.discriminatedUnion("schema_version", [
  legacyCapabilityLeaseRecordSchema,
  durableCapabilityLeaseRecordSchema,
]);

export type CapabilityLeaseRecordV1 = z.infer<typeof capabilityLeaseRecordSchema>;

export function exactPluginSelector(record: InstalledPluginRecordV1): string {
  return `user_install:${record.pluginId}@${record.pluginVersion}#sha256:${record.pluginSha256}`;
}
