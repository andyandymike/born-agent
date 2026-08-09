import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";

const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const gitObject = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nodeId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const relativeRef = z.string().min(1).max(1024).refine((value) =>
  !value.startsWith("/") && !value.includes("\\") &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  "must be a canonical relative reference",
);

function withoutIdentityField(
  value: Readonly<Record<string, unknown>>,
  field: string,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value).filter(([candidate]) => candidate !== field),
  );
}

export const repositoryIdentitySchema = z.object({
  baseCommit: gitObject,
  gitCommonDirSha256: sha256,
  objectFormat: z.enum(["sha1", "sha256"]),
  originRootSha256: sha256,
  repositoryId: sha256,
  schemaVersion: z.literal(1),
}).strict();

export const managedWorktreeIdentitySchema = z.object({
  allocationPlanSha256: sha256,
  baseCommit: gitObject,
  graphId: uuid,
  managedPathSha256: sha256,
  managedRelativeRef: relativeRef,
  repositoryId: sha256,
  sourceNodeId: nodeId,
  workspaceId: uuid,
}).strict();

export const baselineEntrySchema = z.object({
  bytes: nonnegative.max(16 * 1024 * 1024),
  mode: z.enum(["100644", "100755"]),
  path: relativeRef,
  sha256,
}).strict();

export const workspaceBaselineManifestSchema = z.object({
  baseCommit: gitObject,
  entries: z.array(baselineEntrySchema).max(25_000),
  manifestSha256: sha256,
  originStatusSha256: sha256,
  schemaVersion: z.literal(1),
  totalBytes: nonnegative.max(512 * 1024 * 1024),
}).strict().superRefine((value, context) => {
  const identity = sha256Canonical({
    baseCommit: value.baseCommit,
    entries: value.entries,
    originStatusSha256: value.originStatusSha256,
    schemaVersion: value.schemaVersion,
    totalBytes: value.totalBytes,
  });
  if (identity !== value.manifestSha256) context.addIssue({ code: "custom", message: "baseline manifest SHA-256 is inconsistent" });
  if (value.totalBytes !== value.entries.reduce((sum, entry) => sum + entry.bytes, 0)) {
    context.addIssue({ code: "custom", message: "baseline byte total is inconsistent" });
  }
  if (new Set(value.entries.map((entry) => entry.path.toLocaleLowerCase("en-US"))).size !== value.entries.length) {
    context.addIssue({ code: "custom", message: "baseline paths contain a case-fold collision" });
  }
});

export const baselineOverlayEntrySchema = z.object({
  baseSha256: sha256.nullable(),
  bytes: nonnegative.max(16 * 1024 * 1024),
  currentSha256: sha256.nullable(),
  path: relativeRef,
  status: z.enum(["tracked_modified", "tracked_deleted", "untracked"]),
}).strict().superRefine((value, context) => {
  if (value.status === "tracked_deleted" && value.currentSha256 !== null) {
    context.addIssue({ code: "custom", message: "deleted overlay entry requires a null current hash" });
  }
  if (value.status === "untracked" && value.baseSha256 !== null) {
    context.addIssue({ code: "custom", message: "untracked overlay entry requires a null base hash" });
  }
});

export const baselineOverlaySchema = z.object({
  baseCommit: gitObject,
  entries: z.array(baselineOverlayEntrySchema).max(25_000),
  originSnapshotSha256: sha256,
  overlaySha256: sha256,
  schemaVersion: z.literal(1),
}).strict().superRefine((value, context) => {
  const identityContent = withoutIdentityField(value, "overlaySha256");
  if (sha256Canonical(identityContent) !== value.overlaySha256) {
    context.addIssue({ code: "custom", message: "baseline overlay SHA-256 is inconsistent" });
  }
});

export const workspaceSnapshotManifestSchema = z.object({
  baselineManifestSha256: sha256,
  entries: z.array(baselineEntrySchema).max(25_000),
  schemaVersion: z.literal(1),
  snapshotSha256: sha256,
  totalBytes: nonnegative.max(512 * 1024 * 1024),
  workspaceId: uuid,
}).strict().superRefine((value, context) => {
  const identityContent = withoutIdentityField(value, "snapshotSha256");
  if (sha256Canonical(identityContent) !== value.snapshotSha256) {
    context.addIssue({ code: "custom", message: "workspace snapshot SHA-256 is inconsistent" });
  }
  if (value.totalBytes !== value.entries.reduce((sum, entry) => sum + entry.bytes, 0)) {
    context.addIssue({ code: "custom", message: "workspace snapshot byte total is inconsistent" });
  }
  if (new Set(value.entries.map((entry) => entry.path.toLocaleLowerCase("en-US"))).size !== value.entries.length) {
    context.addIssue({ code: "custom", message: "workspace snapshot paths contain a case-fold collision" });
  }
});

export const workspaceAllocationPlanSchema = z.object({
  baseCommit: gitObject,
  baselineManifestSha256: sha256,
  dirtyOverlaySha256: sha256.nullable(),
  graph: z.object({ graphId: uuid, graphRevision: positive, graphSha256: sha256 }).strict(),
  managedRelativeRef: relativeRef,
  nodeIds: z.array(nodeId).min(1).max(32),
  operationId: uuid,
  originStatusSha256: sha256,
  repository: repositoryIdentitySchema,
  repositoryRulesSha256: sha256,
  requestedBytes: nonnegative.max(512 * 1024 * 1024),
  requestedFiles: nonnegative.max(25_000),
  schemaVersion: z.literal(1),
  workspaceId: uuid,
}).strict();

export const promotionBundleEntrySchema = z.object({
  bytes: nonnegative.max(16 * 1024 * 1024),
  kind: z.enum(["add", "delete", "modify"]),
  mode: z.enum(["100644", "100755"]),
  path: relativeRef,
  postSha256: sha256.nullable(),
  preSha256: sha256.nullable(),
}).strict().superRefine((value, context) => {
  if ((value.kind === "add") !== (value.preSha256 === null)) context.addIssue({ code: "custom", message: "add requires a null preimage" });
  if ((value.kind === "delete") !== (value.postSha256 === null)) context.addIssue({ code: "custom", message: "delete requires a null postimage" });
});

export const promotionBundleSchema = z.object({
  attemptId: uuid,
  baselineManifestSha256: sha256,
  bundleSha256: sha256,
  entries: z.array(promotionBundleEntrySchema).min(1).max(256),
  graphId: uuid,
  graphRevision: positive,
  graphSha256: sha256,
  nodeId,
  schemaVersion: z.literal(1),
  targetSnapshotSha256: sha256,
  totalBytes: nonnegative.max(16 * 1024 * 1024),
  workspaceId: uuid,
  workspaceSnapshotSha256: sha256,
}).strict().superRefine((value, context) => {
  const identityContent = withoutIdentityField(value, "bundleSha256");
  const identity = sha256Canonical(identityContent);
  if (identity !== value.bundleSha256) context.addIssue({ code: "custom", message: "promotion bundle SHA-256 is inconsistent" });
  if (value.totalBytes !== value.entries.reduce((sum, entry) => sum + entry.bytes, 0)) {
    context.addIssue({ code: "custom", message: "promotion bundle byte total is inconsistent" });
  }
});

export type RepositoryIdentityV1 = Readonly<z.infer<typeof repositoryIdentitySchema>>;
export type ManagedWorktreeIdentityV1 = Readonly<z.infer<typeof managedWorktreeIdentitySchema>>;
export type WorkspaceBaselineManifestV1 = Readonly<z.infer<typeof workspaceBaselineManifestSchema>>;
export type BaselineOverlayV1 = Readonly<z.infer<typeof baselineOverlaySchema>>;
export type WorkspaceSnapshotManifestV1 = Readonly<z.infer<typeof workspaceSnapshotManifestSchema>>;
export type WorkspaceAllocationPlanV1 = Readonly<z.infer<typeof workspaceAllocationPlanSchema>>;
export type PromotionBundleV1 = Readonly<z.infer<typeof promotionBundleSchema>>;
