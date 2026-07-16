import { sha256Canonical } from "../completion/canonical-json.js";
import type {
  ContextItem,
  ProtectedFactCategory,
} from "./context-item.js";

export interface ProtectedFact {
  readonly category: ProtectedFactCategory;
  readonly estimatedTokens: number;
  readonly factId: string;
  readonly itemId: string;
  readonly sourceEventIds: readonly string[];
}

export interface ProtectedFactLedgerProjection {
  readonly categoryEstimatedTokens: Readonly<
    Partial<Record<ProtectedFactCategory, number>>
  >;
  readonly facts: readonly ProtectedFact[];
  readonly protectedItemIds: readonly string[];
  readonly totalEstimatedTokens: number;
}

export interface ProtectedFactLedgerInput {
  readonly activeEffectIds: readonly string[];
  readonly items: readonly ContextItem[];
}

function categoryForItem(
  item: ContextItem,
  activeEffects: ReadonlySet<string>,
): ProtectedFactCategory | null {
  if (item.kind === "system_instruction") return "system_policy";
  if (item.kind === "user_message") return "user_instruction";
  if (item.kind === "repository_rules") return "repository_rules";
  if (item.kind === "approval_history") return "approval_history";
  if (item.pairing !== null && activeEffects.has(item.pairing.id)) {
    return "pending_effects";
  }
  return item.protectedCategory;
}

function freezeCategoryTotals(
  totals: ReadonlyMap<ProtectedFactCategory, number>,
): Readonly<Partial<Record<ProtectedFactCategory, number>>> {
  return Object.freeze(
    Object.fromEntries(
      [...totals.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );
}

export class ProtectedFactLedger {
  public project(
    input: ProtectedFactLedgerInput,
  ): ProtectedFactLedgerProjection {
    const activeEffects = new Set(input.activeEffectIds);
    const seenItemIds = new Set<string>();
    const facts: ProtectedFact[] = [];
    const categoryTotals = new Map<ProtectedFactCategory, number>();
    for (const item of input.items) {
      if (seenItemIds.has(item.id)) {
        throw new TypeError(`duplicate context item id ${item.id}`);
      }
      seenItemIds.add(item.id);
      const category = categoryForItem(item, activeEffects);
      if (category === null) continue;
      // PHASE10: constraints and unresolved safety/completion facts are kept as
      // schema facts. If they exceed capacity we fail closed rather than let
      // recency heuristics silently erase the reason an action is forbidden.
      const fact: ProtectedFact = Object.freeze({
        category,
        estimatedTokens: item.estimatedTokens,
        factId: `fact:${sha256Canonical({
          category,
          item_id: item.id,
          schema_version: 1,
        })}`,
        itemId: item.id,
        sourceEventIds: item.sourceEventIds,
      });
      facts.push(fact);
      categoryTotals.set(
        category,
        (categoryTotals.get(category) ?? 0) + item.estimatedTokens,
      );
    }
    facts.sort((left, right) =>
      left.category.localeCompare(right.category) ||
      left.itemId.localeCompare(right.itemId),
    );
    const protectedItemIds = Object.freeze(
      [...new Set(facts.map(({ itemId }) => itemId))].sort((left, right) =>
        left.localeCompare(right),
      ),
    );
    return Object.freeze({
      categoryEstimatedTokens: freezeCategoryTotals(categoryTotals),
      facts: Object.freeze(facts),
      protectedItemIds,
      totalEstimatedTokens: facts.reduce(
        (total, fact) => total + fact.estimatedTokens,
        0,
      ),
    });
  }
}
