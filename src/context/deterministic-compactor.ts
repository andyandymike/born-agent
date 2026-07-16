import { canonicalJson } from "../completion/canonical-json.js";
import {
  contextPriorityRank,
  createContextItem,
  type ContextItem,
  type ContextJson,
} from "./context-item.js";
import type { ProjectedContextState } from "./context-projector.js";
import {
  ProtectedFactLedger,
  type ProtectedFactLedgerProjection,
} from "./protected-fact-ledger.js";
import type { ContextBudget, TokenEstimator } from "./token-estimator.js";

interface ContextGroup {
  readonly id: string;
  readonly items: readonly ContextItem[];
  readonly priority: number;
  readonly recency: number;
}

export interface DeterministicCompactorOptions {
  readonly largeToolObservationTokens?: number;
  readonly recentGroupCount?: number;
}

export interface ContextCompactionResult {
  readonly archivedItemIds: readonly string[];
  readonly compacted: boolean;
  readonly descriptorItemIds: readonly string[];
  readonly epoch: number;
  readonly estimatedInputTokens: number;
  readonly includedItems: readonly ContextItem[];
  readonly ledger: ProtectedFactLedgerProjection;
  readonly protectedClosureEstimatedTokens: number;
}

export type ContextCompactionErrorCode =
  | "context_estimator_mismatch"
  | "context_protected_overflow"
  | "context_unsafe_compaction";

export class ContextCompactionError extends Error {
  public readonly exitCode: 7;

  public constructor(
    public readonly code: ContextCompactionErrorCode,
    message: string,
    public readonly details: {
      readonly activeEffectIds: readonly string[];
      readonly categoryEstimatedTokens: Readonly<Record<string, number>>;
      readonly estimatedTokens: number;
      readonly limitTokens: number;
    },
  ) {
    super(message);
    this.name = "ContextCompactionError";
    this.exitCode = 7;
  }
}

function sumTokens(items: readonly ContextItem[]): number {
  return items.reduce((total, item) => total + item.estimatedTokens, 0);
}

function groupItems(items: readonly ContextItem[]): readonly ContextGroup[] {
  const grouped = new Map<string, ContextItem[]>();
  for (const item of items) {
    const key = item.pairing === null ? `item:${item.id}` : `pair:${item.pairing.id}`;
    const group = grouped.get(key) ?? [];
    group.push(item);
    grouped.set(key, group);
  }
  return Object.freeze(
    [...grouped.entries()].map(([id, values]) => {
      const ordered = Object.freeze(
        values.sort(
          (left, right) =>
            left.recency - right.recency || left.id.localeCompare(right.id),
        ),
      );
      return Object.freeze({
        id,
        items: ordered,
        priority: Math.max(
          ...ordered.map(({ priority }) => contextPriorityRank(priority)),
        ),
        recency: Math.max(...ordered.map(({ recency }) => recency)),
      });
    }),
  );
}

function selectionOrder(left: ContextGroup, right: ContextGroup): number {
  return (
    right.priority - left.priority ||
    right.recency - left.recency ||
    left.id.localeCompare(right.id)
  );
}

function outputLayer(item: ContextItem): number {
  switch (item.kind) {
    case "system_instruction":
      return 0;
    case "user_message":
      return 1;
    case "repository_rules":
      return 2;
    case "approval_history":
    case "mutation_fact":
    case "state_fact":
      return 3;
    case "archived_tool_observation":
      return 5;
    default:
      return 4;
  }
}

function finalItemOrder(left: ContextItem, right: ContextItem): number {
  return (
    outputLayer(left) - outputLayer(right) ||
    left.recency - right.recency ||
    left.id.localeCompare(right.id)
  );
}

function groupHasIncompleteRequiredPair(group: ContextGroup): boolean {
  const pairing = group.items[0]?.pairing;
  if (pairing === undefined || pairing === null) return false;
  const roles = new Set(group.items.map((item) => item.pairing?.role));
  if (pairing.kind === "tool") {
    return !roles.has("call") || !roles.has("observation");
  }
  if (pairing.kind === "completion") {
    return !roles.has("candidate") || !roles.has("decision");
  }
  return false;
}

function metadataRecord(item: ContextItem): Readonly<Record<string, ContextJson>> {
  return item.metadata !== null &&
    typeof item.metadata === "object" &&
    !Array.isArray(item.metadata)
    ? (item.metadata as Readonly<Record<string, ContextJson>>)
    : {};
}

function archivedObservationDescriptor(
  observation: ContextItem,
  estimator: TokenEstimator,
): ContextItem | null {
  if (
    observation.kind !== "tool_observation" ||
    observation.pairing === null ||
    observation.artifactRefs.length === 0
  ) {
    return null;
  }
  const metadata = metadataRecord(observation);
  const descriptor = {
    artifact_id: observation.artifactRefs[0]?.artifactId ?? null,
    kind: "archived_tool_observation",
    observation_sha256: observation.contentSha256,
    output_bytes:
      typeof metadata.output_bytes === "number"
        ? metadata.output_bytes
        : new TextEncoder().encode(observation.content).byteLength,
    status: typeof metadata.status === "string" ? metadata.status : "unknown",
    tool:
      typeof metadata.tool_name === "string" ? metadata.tool_name : "unknown",
    truncated: metadata.truncated === true,
  } as const;
  return createContextItem(
    {
      artifactRefs: observation.artifactRefs,
      authority: "historical_only",
      content: canonicalJson(descriptor),
      kind: "archived_tool_observation",
      metadata: descriptor,
      pairing: {
        id: observation.pairing.id,
        kind: "tool",
        role: "observation",
      },
      priority: observation.priority,
      recency: observation.recency,
      role: "tool",
      sourceEventIds: observation.sourceEventIds,
      turnId: observation.turnId,
      visibility: "provider_context",
    },
    estimator,
  );
}

function compactToolGroup(
  group: ContextGroup,
  estimator: TokenEstimator,
):
  | {
      readonly archivedIds: readonly string[];
      readonly descriptorIds: readonly string[];
      readonly items: readonly ContextItem[];
    }
  | null {
  const compacted: ContextItem[] = [];
  const archivedIds: string[] = [];
  const descriptorIds: string[] = [];
  let replaced = false;
  for (const item of group.items) {
    const descriptor = archivedObservationDescriptor(item, estimator);
    if (descriptor === null) {
      compacted.push(item);
      continue;
    }
    replaced = true;
    compacted.push(descriptor);
    archivedIds.push(item.id);
    descriptorIds.push(descriptor.id);
  }
  return replaced
    ? Object.freeze({
        archivedIds: Object.freeze(archivedIds),
        descriptorIds: Object.freeze(descriptorIds),
        items: Object.freeze(compacted),
      })
    : null;
}

function categoryDetails(
  ledger: ProtectedFactLedgerProjection,
): Readonly<Record<string, number>> {
  return Object.freeze({ ...ledger.categoryEstimatedTokens });
}

export class DeterministicCompactor {
  readonly #largeToolObservationTokens: number;
  readonly #ledger: ProtectedFactLedger;
  readonly #recentGroupCount: number;

  public constructor(
    private readonly estimator: TokenEstimator,
    options: DeterministicCompactorOptions = {},
  ) {
    this.#largeToolObservationTokens =
      options.largeToolObservationTokens ?? 256;
    this.#recentGroupCount = options.recentGroupCount ?? 2;
    if (
      !Number.isSafeInteger(this.#largeToolObservationTokens) ||
      this.#largeToolObservationTokens <= 0 ||
      !Number.isSafeInteger(this.#recentGroupCount) ||
      this.#recentGroupCount < 0
    ) {
      throw new RangeError("compactor options must be bounded integers");
    }
    this.#ledger = new ProtectedFactLedger();
  }

  public compact(
    state: ProjectedContextState,
    budget: ContextBudget,
  ): ContextCompactionResult {
    for (const item of state.items) {
      if (
        item.estimatorId !== this.estimator.estimatorId ||
        state.estimatorId !== this.estimator.estimatorId
      ) {
        throw new ContextCompactionError(
          "context_estimator_mismatch",
          "all context items must use the planner estimator",
          {
            activeEffectIds: state.activeEffectIds,
            categoryEstimatedTokens: {},
            estimatedTokens: 0,
            limitTokens: budget.absoluteInputTokens,
          },
        );
      }
    }
    const ledger = this.#ledger.project({
      activeEffectIds: state.activeEffectIds,
      items: state.items,
    });
    const protectedIds = new Set(ledger.protectedItemIds);
    const groups = groupItems(state.items);
    const protectedGroupIds = new Set(
      groups
        .filter((group) => group.items.some((item) => protectedIds.has(item.id)))
        .map(({ id }) => id),
    );
    const protectedClosure = groups
      .filter(({ id }) => protectedGroupIds.has(id))
      .flatMap(({ items }) => items);
    const protectedClosureEstimatedTokens = sumTokens(protectedClosure);
    if (protectedClosureEstimatedTokens > budget.absoluteInputTokens) {
      throw new ContextCompactionError(
        "context_protected_overflow",
        "protected facts and their pairing closure exceed safe input capacity",
        {
          activeEffectIds: state.activeEffectIds,
          categoryEstimatedTokens: categoryDetails(ledger),
          estimatedTokens: protectedClosureEstimatedTokens,
          limitTokens: budget.absoluteInputTokens,
        },
      );
    }

    const totalTokens = sumTokens(state.items);
    if (totalTokens <= budget.compactionTargetTokens) {
      return Object.freeze({
        archivedItemIds: Object.freeze([]),
        compacted: false,
        descriptorItemIds: Object.freeze([]),
        epoch: state.epoch,
        estimatedInputTokens: totalTokens,
        includedItems: state.items,
        ledger,
        protectedClosureEstimatedTokens,
      });
    }

    const incompletePairs = groups
      .filter(groupHasIncompleteRequiredPair)
      .map(({ id }) => id);
    if (!state.safePoint || state.activeEffectIds.length > 0 || incompletePairs.length > 0) {
      // PHASE10: compaction cannot run through an unmatched call/result or an
      // active side effect. Doing so could retain a success observation while
      // deleting the action identity that makes it auditable and replay-safe.
      const activeEffectIds = Object.freeze([
        ...new Set([...state.activeEffectIds, ...incompletePairs]),
      ].sort((left, right) => left.localeCompare(right)));
      throw new ContextCompactionError(
        "context_unsafe_compaction",
        "context is over threshold but no safe compaction point exists",
        {
          activeEffectIds,
          categoryEstimatedTokens: categoryDetails(ledger),
          estimatedTokens: totalTokens,
          limitTokens: budget.compactionTargetTokens,
        },
      );
    }

    const selectedItems: ContextItem[] = [...protectedClosure];
    const selectedIds = new Set(selectedItems.map(({ id }) => id));
    const archivedIds = new Set<string>();
    const descriptorIds = new Set<string>();
    let selectedTokens = protectedClosureEstimatedTokens;
    const selectionLimit = Math.max(
      budget.compactionTargetTokens,
      protectedClosureEstimatedTokens,
    );
    const optionalGroups = groups
      .filter(({ id }) => !protectedGroupIds.has(id))
      .sort(selectionOrder);
    const recentGroupIds = new Set(
      [...optionalGroups]
        .sort(
          (left, right) =>
            right.recency - left.recency || left.id.localeCompare(right.id),
        )
        .slice(0, this.#recentGroupCount)
        .map(({ id }) => id),
    );

    for (const group of optionalGroups) {
      const hasLargeObservation = group.items.some(
        (item) =>
          item.kind === "tool_observation" &&
          item.estimatedTokens >= this.#largeToolObservationTokens,
      );
      const compactedGroup =
        hasLargeObservation && !recentGroupIds.has(group.id)
          ? compactToolGroup(group, this.estimator)
          : null;
      const candidate = compactedGroup?.items ?? group.items;
      const candidateTokens = sumTokens(candidate);
      if (selectedTokens + candidateTokens <= selectionLimit) {
        for (const item of candidate) {
          if (!selectedIds.has(item.id)) {
            selectedItems.push(item);
            selectedIds.add(item.id);
          }
        }
        selectedTokens += candidateTokens;
        for (const id of compactedGroup?.archivedIds ?? []) archivedIds.add(id);
        for (const id of compactedGroup?.descriptorIds ?? []) descriptorIds.add(id);
        continue;
      }

      const fallback = compactedGroup ?? compactToolGroup(group, this.estimator);
      const fallbackTokens = fallback === null ? Number.POSITIVE_INFINITY : sumTokens(fallback.items);
      if (fallback !== null && selectedTokens + fallbackTokens <= selectionLimit) {
        for (const item of fallback.items) {
          if (!selectedIds.has(item.id)) {
            selectedItems.push(item);
            selectedIds.add(item.id);
          }
        }
        selectedTokens += fallbackTokens;
        for (const id of fallback.archivedIds) archivedIds.add(id);
        for (const id of fallback.descriptorIds) descriptorIds.add(id);
      } else {
        for (const item of group.items) archivedIds.add(item.id);
      }
    }

    selectedItems.sort(finalItemOrder);
    return Object.freeze({
      archivedItemIds: Object.freeze(
        [...archivedIds]
          .filter((id) => !selectedIds.has(id))
          .sort((left, right) => left.localeCompare(right)),
      ),
      compacted: true,
      descriptorItemIds: Object.freeze(
        [...descriptorIds].sort((left, right) => left.localeCompare(right)),
      ),
      epoch: state.epoch + 1,
      estimatedInputTokens: sumTokens(selectedItems),
      includedItems: Object.freeze(selectedItems),
      ledger,
      protectedClosureEstimatedTokens,
    });
  }
}
