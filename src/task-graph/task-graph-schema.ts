import { z } from "zod";

import { parseQualifiedCapabilityId } from "../capabilities/capability-id.js";
import { canonicalJson } from "../completion/canonical-json.js";
import { canonicalStoredTextSchema } from "../coordination/task-text-schema.js";
import { planItemIdSchema, sha256Schema } from "../plans/plan-schema.js";
import { TaskGraphError } from "./task-graph-errors.js";

export const MAX_TASK_GRAPH_BYTES = 256 * 1024;
export const MAX_TASK_GRAPH_NODES = 32;
export const MAX_TASK_GRAPH_EDGES = 128;
export const MAX_TASK_GRAPH_DEPTH = 16;
export const MAX_TASK_GRAPH_ATTEMPTS_PER_NODE = 3;

const uuid = z.string().uuid();
const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nodeId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const title = canonicalStoredTextSchema({
  maximumBytes: 256,
  maximumScalars: 256,
  minimumScalars: 1,
  nonblank: true,
});
const objective = canonicalStoredTextSchema({
  maximumBytes: 8 * 1024,
  maximumScalars: 8 * 1024,
  minimumScalars: 1,
  nonblank: true,
});
const purpose = canonicalStoredTextSchema({
  maximumBytes: 1024,
  maximumScalars: 1024,
  minimumScalars: 1,
  nonblank: true,
});

function noDuplicates(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

function portableRelativePath(value: string, allowRoot: boolean): boolean {
  if (allowRoot && value === ".") return true;
  if (
    value.length === 0 ||
    value.length > 1024 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) =>
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !containsControlCharacter(segment)
  );
}

export const taskGraphBindingSchema = z.object({
  sessionId: uuid,
  goalId: uuid,
  goalRevision: positiveSafeInteger,
  planId: uuid,
  planRevision: positiveSafeInteger,
  planSha256: sha256Schema,
}).strict();

export const taskGraphBudgetSchema = z.object({
  maxAttempts: positiveSafeInteger.max(MAX_TASK_GRAPH_NODES * MAX_TASK_GRAPH_ATTEMPTS_PER_NODE),
  maxDurationMs: positiveSafeInteger.max(24 * 60 * 60 * 1000),
  maxModelSteps: nonnegativeSafeInteger.max(100_000),
  maxCommandExecutions: nonnegativeSafeInteger.max(10_000),
  maxCommandOutputBytes: nonnegativeSafeInteger.max(1024 * 1024 * 1024),
  maxChangedFiles: nonnegativeSafeInteger.max(25_000),
  maxChangedBytes: nonnegativeSafeInteger.max(1024 * 1024 * 1024),
  maxArtifactBytes: nonnegativeSafeInteger.max(1024 * 1024 * 1024),
  maxReportedTokens: nonnegativeSafeInteger.max(1_000_000_000).nullable(),
}).strict();

export const taskNodeWorkspaceRequestSchema = z.object({
  mode: z.enum(["origin_read_only", "managed_worktree", "inherit_predecessor"]),
  declaredPathPrefixes: z.array(z.string()).max(32).superRefine((values, context) => {
    const folded = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (!portableRelativePath(value, true)) {
        context.addIssue({
          code: "custom",
          message: "path prefix must be canonical workspace-relative POSIX syntax",
          path: [index],
        });
      }
      const key = value.toLocaleLowerCase("en-US");
      if (folded.has(key)) {
        context.addIssue({
          code: "custom",
          message: "path prefixes must not contain case-fold duplicates",
          path: [index],
        });
      }
      folded.add(key);
    }
  }),
}).strict();

export const taskNodeRetrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(MAX_TASK_GRAPH_ATTEMPTS_PER_NODE),
  automaticOn: z.array(z.literal("pre_effect_infrastructure_failure")).max(1),
}).strict().superRefine((value, context) => {
  if (!noDuplicates(value.automaticOn)) {
    context.addIssue({ code: "custom", message: "automatic retry classes must be unique" });
  }
});

const qualifiedCapabilities = z.array(z.string().max(512)).max(16).superRefine((values, context) => {
  if (!noDuplicates(values)) {
    context.addIssue({ code: "custom", message: "required capabilities must be unique" });
  }
  for (const [index, value] of values.entries()) {
    try {
      parseQualifiedCapabilityId(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "capability must be a complete qualified Phase 18 identity",
        path: [index],
      });
    }
  }
});

const sharedNodeFields = {
  nodeId,
  sequence: z.number().int().min(1).max(MAX_TASK_GRAPH_NODES),
  title,
  objective,
  planItemIds: z.array(planItemIdSchema).min(1).max(16).refine(noDuplicates, "plan item ids must be unique"),
  dependsOn: z.array(nodeId).max(16).refine(noDuplicates, "dependencies must be unique"),
  workspace: taskNodeWorkspaceRequestSchema,
  requiredCapabilities: qualifiedCapabilities,
  budget: taskGraphBudgetSchema,
  retry: taskNodeRetrySchema,
} as const;

export const agentTaskNodeSchema = z.object({
  ...sharedNodeFields,
  kind: z.literal("agent"),
  agent: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("plan"), taskProfile: z.literal("read-only") }).strict(),
    z.object({ mode: z.literal("build"), taskProfile: z.literal("coding") }).strict(),
  ]),
}).strict();

const verificationArg = z.string().max(4096).refine(
  (value) => !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
  "verification argv entries must be bounded single-line NUL-free strings",
);

export const verificationTaskNodeSchema = z.object({
  ...sharedNodeFields,
  kind: z.literal("verification"),
  verification: z.object({
    argv: z.array(verificationArg).min(1).max(64).refine(
      (values) => Buffer.byteLength(canonicalJson(values), "utf8") <= 32 * 1024,
      "verification argv exceeds 32 KiB",
    ),
    cwd: z.string().max(1024).refine(
      (value) => portableRelativePath(value, true),
      "verification cwd must be canonical workspace-relative POSIX syntax",
    ),
    purpose,
  }).strict(),
}).strict();

export const taskNodeSpecSchema = z.discriminatedUnion("kind", [
  agentTaskNodeSchema,
  verificationTaskNodeSchema,
]);

function budgetFields(): readonly (keyof z.infer<typeof taskGraphBudgetSchema>)[] {
  return [
    "maxAttempts",
    "maxDurationMs",
    "maxModelSteps",
    "maxCommandExecutions",
    "maxCommandOutputBytes",
    "maxChangedFiles",
    "maxChangedBytes",
    "maxArtifactBytes",
    "maxReportedTokens",
  ];
}

function addIssue(context: z.RefinementCtx, message: string, path: PropertyKey[] = []): void {
  context.addIssue({ code: "custom", message, path });
}

function graphDepth(
  nodes: readonly { readonly nodeId: string; readonly dependsOn: readonly string[] }[],
): { readonly cycle: boolean; readonly depth: number } {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const visiting = new Set<string>();
  const memo = new Map<string, number>();
  let cycle = false;
  const visit = (id: string): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) {
      cycle = true;
      return MAX_TASK_GRAPH_DEPTH + 1;
    }
    visiting.add(id);
    const node = byId.get(id);
    const depth = node === undefined || node.dependsOn.length === 0
      ? 1
      : 1 + Math.max(...node.dependsOn.map(visit));
    visiting.delete(id);
    memo.set(id, depth);
    return depth;
  };
  return {
    cycle,
    depth: nodes.length === 0 ? 0 : Math.max(...nodes.map((node) => visit(node.nodeId))),
  };
}

export const taskGraphRevisionContentSchema = z.object({
  schemaVersion: z.literal(1),
  graphId: uuid,
  binding: taskGraphBindingSchema,
  title,
  nodes: z.array(taskNodeSpecSchema).min(1).max(MAX_TASK_GRAPH_NODES),
  graphBudget: taskGraphBudgetSchema,
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  const sequences = new Set<number>();
  for (const [index, node] of value.nodes.entries()) {
    if (ids.has(node.nodeId)) addIssue(context, "node ids must be unique", ["nodes", index, "nodeId"]);
    if (sequences.has(node.sequence)) addIssue(context, "node sequences must be unique", ["nodes", index, "sequence"]);
    ids.add(node.nodeId);
    sequences.add(node.sequence);
  }

  let edgeCount = 0;
  for (const [index, node] of value.nodes.entries()) {
    edgeCount += node.dependsOn.length;
    for (const dependency of node.dependsOn) {
      if (dependency === node.nodeId) addIssue(context, "node cannot depend on itself", ["nodes", index, "dependsOn"]);
      if (!ids.has(dependency)) addIssue(context, "dependency references an unknown node", ["nodes", index, "dependsOn"]);
    }
    if (node.workspace.mode === "inherit_predecessor" && node.dependsOn.length !== 1) {
      addIssue(context, "inherit_predecessor requires exactly one dependency", ["nodes", index, "workspace", "mode"]);
    }
    if (node.kind === "agent") {
      if (
        (node.workspace.mode === "origin_read_only") !==
        (node.agent.mode === "plan" && node.agent.taskProfile === "read-only")
      ) {
        addIssue(
          context,
          "origin_read_only is exclusive to plan/read-only agent nodes",
          ["nodes", index, "workspace", "mode"],
        );
      }
    } else if (node.workspace.mode === "origin_read_only") {
      addIssue(context, "verification nodes require a managed worktree lineage", ["nodes", index, "workspace", "mode"]);
    }
    if (node.retry.maxAttempts > node.budget.maxAttempts) {
      addIssue(context, "retry maxAttempts cannot exceed the node budget", ["nodes", index, "retry", "maxAttempts"]);
    }
    for (const field of budgetFields()) {
      const nodeLimit = node.budget[field];
      const graphLimit = value.graphBudget[field];
      if (nodeLimit !== null && graphLimit !== null && nodeLimit > graphLimit) {
        addIssue(context, `${field} node ceiling exceeds Graph ceiling`, ["nodes", index, "budget", field]);
      }
      if (nodeLimit !== null && graphLimit === null && field !== "maxReportedTokens") {
        addIssue(context, `${field} has an invalid nullable Graph ceiling`, ["graphBudget", field]);
      }
    }
  }
  if (edgeCount > MAX_TASK_GRAPH_EDGES) addIssue(context, "Graph has more than 128 edges", ["nodes"]);
  const topology = graphDepth(value.nodes);
  if (topology.cycle) addIssue(context, "Graph contains a dependency cycle", ["nodes"]);
  if (topology.depth > MAX_TASK_GRAPH_DEPTH) addIssue(context, "Graph dependency depth exceeds 16", ["nodes"]);
  const byId = new Map(value.nodes.map((node) => [node.nodeId, node]));
  const lineageMemo = new Map<string, string | null>();
  const lineage = (id: string): string | null => {
    if (lineageMemo.has(id)) return lineageMemo.get(id) ?? null;
    const node = byId.get(id);
    if (node === undefined || node.workspace.mode === "origin_read_only") return null;
    const result = node.workspace.mode === "managed_worktree"
      ? node.nodeId
      : lineage(node.dependsOn[0]!);
    lineageMemo.set(id, result);
    return result;
  };
  for (const [index, node] of value.nodes.entries()) {
    const predecessorLineages = new Set(node.dependsOn.map(lineage).filter((item): item is string => item !== null));
    if (node.workspace.mode === "inherit_predecessor" && lineage(node.nodeId) === null) {
      addIssue(context, "inherit_predecessor requires a managed predecessor lineage", ["nodes", index, "workspace", "mode"]);
    }
    if (node.workspace.mode !== "origin_read_only" && predecessorLineages.size > 1) {
      addIssue(context, "write node cannot merge multiple managed worktree lineages", ["nodes", index, "dependsOn"]);
    }
  }
  if (Buffer.byteLength(canonicalJson(value), "utf8") > MAX_TASK_GRAPH_BYTES) {
    addIssue(context, "canonical Graph exceeds 256 KiB");
  }
});

type ParsedTaskGraphBudget = z.infer<typeof taskGraphBudgetSchema>;
type ParsedTaskGraphBinding = z.infer<typeof taskGraphBindingSchema>;
type ParsedTaskNodeSpec = z.infer<typeof taskNodeSpecSchema>;
type ParsedTaskGraphRevision = z.infer<typeof taskGraphRevisionContentSchema>;

type DeepReadonly<T> = T extends readonly (infer TEntry)[]
  ? readonly DeepReadonly<TEntry>[]
  : T extends object
    ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
    : T;

export type TaskGraphBudgetV1 = Readonly<ParsedTaskGraphBudget>;
export type TaskNodeBudgetV1 = TaskGraphBudgetV1;
export type TaskGraphBindingV1 = Readonly<ParsedTaskGraphBinding>;
export type TaskNodeSpecV1 = DeepReadonly<ParsedTaskNodeSpec>;
export type AgentTaskNodeV1 = DeepReadonly<z.infer<typeof agentTaskNodeSchema>>;
export type VerificationTaskNodeV1 = DeepReadonly<z.infer<typeof verificationTaskNodeSchema>>;
export type TaskGraphRevisionContentV1 = Readonly<
  Omit<ParsedTaskGraphRevision, "binding" | "graphBudget" | "nodes"> & {
    readonly binding: TaskGraphBindingV1;
    readonly graphBudget: TaskGraphBudgetV1;
    readonly nodes: readonly TaskNodeSpecV1[];
  }
>;

function sortedUnique<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values].sort((left, right) => left.localeCompare(right, "en")));
}

function normalizeNode(node: ParsedTaskNodeSpec): TaskNodeSpecV1 {
  const common = {
    ...node,
    budget: Object.freeze({ ...node.budget }),
    dependsOn: sortedUnique(node.dependsOn),
    planItemIds: sortedUnique(node.planItemIds),
    requiredCapabilities: sortedUnique(node.requiredCapabilities),
    retry: Object.freeze({
      ...node.retry,
      automaticOn: sortedUnique(node.retry.automaticOn),
    }),
    workspace: Object.freeze({
      ...node.workspace,
      declaredPathPrefixes: sortedUnique(node.workspace.declaredPathPrefixes),
    }),
  };
  return Object.freeze(node.kind === "agent"
    ? { ...common, agent: Object.freeze({ ...node.agent }), kind: "agent" as const }
    : {
        ...common,
        kind: "verification" as const,
        verification: Object.freeze({
          ...node.verification,
          argv: Object.freeze([...node.verification.argv]),
        }),
      });
}

export function normalizeTaskGraphRevision(value: unknown): TaskGraphRevisionContentV1 {
  const parsed = taskGraphRevisionContentSchema.parse(value);
  const normalized: TaskGraphRevisionContentV1 = Object.freeze({
    schemaVersion: 1,
    binding: Object.freeze({ ...parsed.binding }),
    graphBudget: Object.freeze({ ...parsed.graphBudget }),
    graphId: parsed.graphId,
    nodes: Object.freeze(
      parsed.nodes
        .map(normalizeNode)
        .sort((left, right) => left.sequence - right.sequence || left.nodeId.localeCompare(right.nodeId, "en")),
    ),
    title: parsed.title,
  });
  taskGraphRevisionContentSchema.parse(normalized);
  return normalized;
}

export function validateTaskGraphPlanItems(
  graph: TaskGraphRevisionContentV1,
  currentPlanItemIds: ReadonlySet<string>,
): void {
  const unknown = [...new Set(graph.nodes.flatMap((node) => node.planItemIds))]
    .filter((id) => !currentPlanItemIds.has(id))
    .sort();
  if (unknown.length > 0) {
    throw new TaskGraphError(
      "task_graph_plan_item_unknown",
      `Graph references unknown Plan item ids: ${unknown.slice(0, 8).join(", ")}`,
    );
  }
}

export function classifyTaskGraphSchemaError(error: z.ZodError): TaskGraphError {
  const message = error.issues[0]?.message ?? "Graph schema is invalid";
  if (message.includes("cycle")) return new TaskGraphError("task_graph_cycle", message, { cause: error });
  if (
    message.includes("exceeds") ||
    message.includes("more than") ||
    message.includes("Too big")
  ) {
    return new TaskGraphError("task_graph_bounds_exceeded", message, { cause: error });
  }
  return new TaskGraphError("task_graph_schema_invalid", message, { cause: error });
}
