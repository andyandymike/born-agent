import { access } from "node:fs/promises";
import { constants } from "node:fs";

import { sha256Canonical } from "../completion/canonical-json.js";
import { SensitivePathPolicy } from "../tools/sensitive-path-policy.js";
import { WorkspacePathPolicy } from "../tools/workspace-path-policy.js";
import { FilesystemSourceEnumerator } from "./filesystem-source-enumerator.js";
import { GitSourceEnumerator } from "./git-source-enumerator.js";
import { isParseEligibleLanguage, repositoryLanguageHint } from "./repository-language.js";
import { RepositoryIntelligenceError } from "./repository-intelligence-error.js";
import {
  repositorySourceSnapshotSchema,
  type RepositorySourceEntry,
  type RepositorySourceSnapshotResult,
} from "./source-snapshot.js";
import {
  createSourceInventoryPolicy,
  sourceInventoryPolicySha256,
  type SourceInventoryBounds,
  type SourceInventoryPolicy,
} from "./source-inventory-policy.js";
import { StableSourceReader } from "./stable-source-reader.js";

function increment(target: Record<string, number>, key: string, amount = 1): void {
  target[key] = (target[key] ?? 0) + amount;
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class RepositorySourceSnapshotter {
  private constructor(
    private readonly workspace: string,
    private readonly paths: WorkspacePathPolicy,
    private readonly policy: SourceInventoryPolicy,
    private readonly reader: StableSourceReader,
    private readonly environment: Readonly<Record<string, string | undefined>>,
  ) {}

  static async create(
    workspace: string,
    options: {
      readonly bounds?: Partial<SourceInventoryBounds>;
      readonly environment?: Readonly<Record<string, string | undefined>>;
    } = {},
  ): Promise<RepositorySourceSnapshotter> {
    const policy = createSourceInventoryPolicy(options.bounds);
    const paths = await WorkspacePathPolicy.create(workspace, { sensitive: new SensitivePathPolicy() });
    return new RepositorySourceSnapshotter(
      workspace,
      paths,
      policy,
      new StableSourceReader(paths),
      options.environment ?? process.env,
    );
  }

  async snapshot(signal: AbortSignal = new AbortController().signal): Promise<RepositorySourceSnapshotResult> {
    if (signal.aborted) {
      throw new RepositoryIntelligenceError("source_unstable", "repository snapshot was cancelled", 130);
    }
    const git = await new GitSourceEnumerator(this.workspace, this.environment).enumerate(signal);
    const enumeration =
      git ?? (await new FilesystemSourceEnumerator(this.paths.workspaceRealPath, this.policy).enumerate(signal));

    const candidates = new Set(enumeration.paths);
    // Root AGENTS.md is an inventory fact even when repository ignore rules hide it. Nested rule
    // discovery remains a 17B concern.
    try {
      await access(`${this.paths.workspaceRealPath}/AGENTS.md`, constants.F_OK);
      candidates.add("AGENTS.md");
    } catch {
      // Missing root repository rules are valid.
    }
    const sorted = [...candidates].sort(ordinal);
    const skipped: Record<string, number> = { ...enumeration.skipped };
    const bounded = sorted.slice(0, this.policy.bounds.maxFiles);
    if (sorted.length > bounded.length) increment(skipped, "remaining_files", sorted.length - bounded.length);

    const entries: RepositorySourceEntry[] = [];
    const sourceBytes = new Map<string, Uint8Array>();
    let acceptedBytes = 0;
    for (const relativePath of bounded) {
      if (signal.aborted) {
        throw new RepositoryIntelligenceError("source_unstable", "repository snapshot was cancelled", 130);
      }
      if (Buffer.byteLength(relativePath, "utf8") > this.policy.bounds.maxRelativePathBytes) {
        increment(skipped, "path_too_long");
        continue;
      }
      try {
        const stable = await this.reader.read(relativePath, {
          maxBytes: this.policy.bounds.maxFileBytes,
          signal,
        });
        if (acceptedBytes + stable.byteLength > this.policy.bounds.maxParseBytes) {
          increment(skipped, "parse_bytes_exceeded");
          continue;
        }
        acceptedBytes += stable.byteLength;
        const languageHint = repositoryLanguageHint(relativePath);
        entries.push(
          Object.freeze({
            byteLength: stable.byteLength,
            contentSha256: stable.contentSha256,
            languageHint,
            parseEligibility:
              stable.textEncoding === "binary"
                ? "binary"
                : isParseEligibleLanguage(languageHint)
                  ? "eligible"
                  : "unsupported",
            relativePath,
            textEncoding: stable.textEncoding,
          }),
        );
        sourceBytes.set(relativePath, stable.bytes);
      } catch (error) {
        if (error instanceof RepositoryIntelligenceError) {
          if (error.exitCode === 130) throw error;
          increment(skipped, error.code);
          continue;
        }
        increment(skipped, "source_unstable");
      }
    }

    const entriesSha256 = sha256Canonical(entries);
    const inventoryPolicySha256 = sourceInventoryPolicySha256(this.policy);
    const coverage = Object.keys(skipped).length === 0 ? "complete" : "partial";
    const sourceStateSha256 = sha256Canonical({
      coverage,
      entriesSha256,
      gitHeadOid: enumeration.gitHeadOid,
      gitIndexSha256: enumeration.gitIndexSha256,
      inventoryPolicySha256,
      skipped,
      sourceKind: enumeration.sourceKind,
    });
    const snapshot = repositorySourceSnapshotSchema.parse({
      coverage,
      entries,
      entriesSha256,
      gitHeadOid: enumeration.gitHeadOid,
      gitIndexSha256: enumeration.gitIndexSha256,
      inventoryPolicySha256,
      schemaVersion: 1,
      skipped,
      sourceKind: enumeration.sourceKind,
      sourceStateSha256,
    });
    // PHASE17: this immutable snapshot is a historical description. A caller must take a new
    // snapshot or perform a current-source guard before treating any returned range as current.
    return Object.freeze({ snapshot: Object.freeze(snapshot), sourceBytes });
  }
}
