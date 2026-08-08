import { Buffer } from "node:buffer";

import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import type { CapabilitySnapshotV1 } from "../capabilities/capability-types.js";
import { SkillError } from "./skill-errors.js";
import type {
  FrozenSkillCatalogEntry,
  SkillCatalogPage,
} from "./skill-types.js";

const MAX_CATALOG_PROJECTION_BYTES = 64 * 1024;

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function decodeCursor(value: string): Readonly<Record<string, unknown>> {
  if (value.length < 1 || value.length > 2048) {
    throw new SkillError("skill_entry_invalid", "Skill catalog cursor is invalid");
  }
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("cursor is not an object");
    }
    return parsed as Readonly<Record<string, unknown>>;
  } catch (error) {
    throw new SkillError(
      "skill_entry_invalid",
      "Skill catalog cursor is invalid",
      8,
      { cause: error },
    );
  }
}

function tokens(query: string | undefined): readonly string[] {
  if (query === undefined || query.trim().length === 0) return Object.freeze([]);
  if (
    Buffer.byteLength(query, "utf8") > 256 ||
    [...query].some((character) => {
      const code = character.codePointAt(0)!;
      return code < 0x20 || code === 0x7f;
    })
  ) {
    throw new SkillError("skill_entry_invalid", "Skill catalog query is invalid");
  }
  return Object.freeze(
    [...new Set(query.normalize("NFC").toLowerCase().trim().split(/\s+/u))].sort(ordinal),
  );
}

export class FrozenSkillCatalog {
  readonly #entries: readonly FrozenSkillCatalogEntry[];
  readonly #snapshot: CapabilitySnapshotV1;
  readonly catalogSha256: string;

  constructor(
    snapshot: CapabilitySnapshotV1,
    activeSkillIds: () => ReadonlySet<string>,
  ) {
    this.#snapshot = snapshot;
    this.#entries = Object.freeze(
      snapshot.plugins
        .flatMap((plugin) => plugin.components)
        .filter((record) => record.identity.kind === "skill")
        .map((record): FrozenSkillCatalogEntry => {
          if (record.metadata.kind !== "skill") {
            throw new SkillError("skill_entry_invalid", "frozen Skill metadata kind is inconsistent");
          }
          return Object.freeze({
            active: activeSkillIds().has(record.identity.qualifiedId),
            description: record.description,
            displayName: record.displayName,
            identity: record.identity,
            invocation: record.metadata.invocation,
            metadata: record.metadata,
            record,
            resourceCount: record.metadata.resources?.length ?? 0,
            source: record.identity.source,
            version: record.identity.pluginVersion,
          });
        })
        .sort((left, right) => ordinal(left.identity.qualifiedId, right.identity.qualifiedId)),
    );
    this.catalogSha256 = sha256Canonical({
      schema_version: 1,
      snapshot_id: snapshot.snapshotId,
      skills: this.#entries.map((entry) => ({
        description: entry.description,
        display_name: entry.displayName,
        identity: entry.identity,
        invocation: entry.invocation,
        resource_count: entry.resourceCount,
      })),
    });
  }

  exact(skillId: string): FrozenSkillCatalogEntry {
    const entry = this.#entries.find((candidate) => candidate.identity.qualifiedId === skillId);
    if (entry === undefined) {
      throw new SkillError("skill_not_available", "Skill ID is not in the frozen run catalog", 8);
    }
    return entry;
  }

  resolveUserSelector(selector: string): FrozenSkillCatalogEntry {
    const matches = this.#entries.filter((entry) =>
      entry.identity.qualifiedId === selector ||
      entry.identity.componentId === selector ||
      `${entry.identity.pluginId}/${entry.identity.componentId}` === selector,
    );
    if (matches.length === 0) {
      throw new SkillError("skill_not_available", "Skill selector has no frozen match", 2);
    }
    if (matches.length !== 1) {
      throw new SkillError("skill_not_available", "Skill selector is ambiguous; use the exact ID", 2);
    }
    return matches[0]!;
  }

  listModelAllowed(input: {
    readonly activeSkillIds: ReadonlySet<string>;
    readonly cursor?: string;
    readonly limit?: number;
    readonly query?: string;
  }): SkillCatalogPage {
    const limit = input.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
      throw new SkillError("skill_entry_invalid", "Skill catalog limit must be 1..20");
    }
    const queryTokens = tokens(input.query);
    const queryIdentity = sha256Canonical(queryTokens);
    let offset = 0;
    if (input.cursor !== undefined) {
      const cursor = decodeCursor(input.cursor);
      if (
        cursor.schema_version !== 1 ||
        cursor.catalog_sha256 !== this.catalogSha256 ||
        cursor.snapshot_id !== this.#snapshot.snapshotId ||
        cursor.query_sha256 !== queryIdentity ||
        cursor.limit !== limit ||
        typeof cursor.offset !== "number" ||
        !Number.isSafeInteger(cursor.offset) ||
        cursor.offset < 0
      ) {
        throw new SkillError("skill_content_stale", "Skill catalog cursor is stale or invalid");
      }
      offset = cursor.offset;
    }
    // PHASE18: user-only Skills do not enter model-visible metadata. Guessing
    // an exact ID later is still rejected by the activation boundary.
    const visible = this.#entries.filter((entry) => {
      if (entry.invocation !== "model_allowed") return false;
      if (queryTokens.length === 0) return true;
      const haystack = `${entry.identity.qualifiedId} ${entry.displayName} ${entry.description}`.toLowerCase();
      return queryTokens.every((token) => haystack.includes(token));
    });
    const projected = visible.slice(offset, offset + limit).map((entry) => Object.freeze({
      active: input.activeSkillIds.has(entry.identity.qualifiedId),
      description: entry.description,
      display_name: entry.displayName,
      resource_count: entry.resourceCount,
      skill_id: entry.identity.qualifiedId,
      source: entry.source,
      version: entry.version,
    }));
    const bytes = Buffer.byteLength(canonicalJson(projected), "utf8");
    if (bytes > MAX_CATALOG_PROJECTION_BYTES) {
      throw new SkillError("skill_context_limit_exceeded", "Skill catalog page exceeds 64 KiB");
    }
    const nextOffset = offset + projected.length;
    const nextCursor = nextOffset < visible.length
      ? Buffer.from(canonicalJson({
          catalog_sha256: this.catalogSha256,
          limit,
          offset: nextOffset,
          query_sha256: queryIdentity,
          schema_version: 1,
          snapshot_id: this.#snapshot.snapshotId,
        }), "utf8").toString("base64url")
      : null;
    return Object.freeze({
      entries: Object.freeze(projected),
      next_cursor: nextCursor,
      snapshot_id: this.#snapshot.snapshotId,
    });
  }
}
