import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { ChangeJournalEntry } from "../changes/change-journal.js";
import type { GoalRevisionAttributionScope } from "../completion/completion-types.js";
import type { GoalChangeLedgerProjection } from "./goal-change-ledger.js";

function cloneEntry(entry: ChangeJournalEntry): ChangeJournalEntry {
  return {
    ...entry,
    postimage: Buffer.from(entry.postimage),
    preimage: Buffer.from(entry.preimage),
  };
}

export function goalChangeAttributionScope(
  projection: GoalChangeLedgerProjection,
): GoalRevisionAttributionScope {
  return Object.freeze({
    baselineEventId: projection.baselineEventId,
    changeEventIds: Object.freeze(
      projection.records.map((record) => record.eventId),
    ),
    goalId: projection.goalId,
    goalRevision: projection.goalRevision,
    kind: "goal_revision",
    ledgerSha256: projection.ledgerSha256,
    sourceRunIds: Object.freeze([...projection.sourceRunIds]),
  });
}

export class VerifiedGoalChangeSeed {
  readonly attributionScope: GoalRevisionAttributionScope;
  readonly preExistingDirtyPaths: readonly string[];
  readonly #entries: readonly ChangeJournalEntry[];

  private constructor(input: {
    readonly attributionScope: GoalRevisionAttributionScope;
    readonly entries: readonly ChangeJournalEntry[];
    readonly preExistingDirtyPaths: readonly string[];
  }) {
    this.attributionScope = input.attributionScope;
    this.#entries = Object.freeze(input.entries.map(cloneEntry));
    this.preExistingDirtyPaths = Object.freeze([...input.preExistingDirtyPaths]);
    Object.freeze(this);
  }

  entriesForJournal(): readonly ChangeJournalEntry[] {
    return this.#entries.map(cloneEntry);
  }

  static async hydrateAndVerify(input: {
    readonly artifactStore: ArtifactStore;
    readonly projection: GoalChangeLedgerProjection;
  }): Promise<VerifiedGoalChangeSeed> {
    const entries: ChangeJournalEntry[] = [];
    for (const record of input.projection.records) {
      for (const file of record.data.files) {
        const post = await input.artifactStore.readVerified(file.postimage.artifact_id);
        if (
          post.metadata.bytes !== file.postimage.bytes ||
          post.metadata.sha256 !== file.postimage.sha256 ||
          post.objectRef !== file.postimage.object_ref
        ) {
          throw new Error(`Goal change postimage artifact is corrupt for ${file.path}`);
        }
        let preimage = Buffer.alloc(0);
        let preimageSha256 = file.preimage?.sha256 ??
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        if (file.preimage !== null) {
          const pre = await input.artifactStore.readVerified(file.preimage.artifact_id);
          if (
            pre.metadata.bytes !== file.preimage.bytes ||
            pre.metadata.sha256 !== file.preimage.sha256 ||
            pre.objectRef !== file.preimage.object_ref
          ) {
            throw new Error(`Goal change preimage artifact is corrupt for ${file.path}`);
          }
          preimage = Buffer.from(pre.bytes);
          preimageSha256 = pre.metadata.sha256;
        }
        entries.push({
          addedLines: 0,
          appliedAt: record.timestamp,
          diff: `goal-change:${record.data.record_sha256}`,
          kind: file.kind,
          path: file.path,
          planId: record.data.patch_plan_event_id,
          postimage: Buffer.from(post.bytes),
          postimageSha256: post.metadata.sha256,
          preimage,
          preimageSha256,
          removedLines: 0,
        });
      }
    }
    return new VerifiedGoalChangeSeed({
      attributionScope: goalChangeAttributionScope(input.projection),
      entries,
      preExistingDirtyPaths:
        input.projection.baseline.data.pre_existing_dirty_paths,
    });
  }
}
