import { opendir } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import { DEFAULT_IGNORED_DIRECTORY_NAMES } from "../repository-intelligence/source-inventory-policy.js";
import type { RepositoryRulesArtifactPort } from "./root-agents-loader.js";
import type { RepositoryRuleSet } from "./repository-rule-set.js";
import { NestedRepositoryRuleSet } from "./repository-rule-manifest.js";
import {
  repositoryRuleManifestSchema,
  repositoryRuleManifestIdentityDescriptor,
  type RepositoryRuleEntryV1,
  type RepositoryRuleManifestV1,
} from "./repository-rule-manifest-schema.js";
import {
  StableAgentsReader,
  StableAgentsReaderError,
} from "./stable-agents-reader.js";

export const MAX_REPOSITORY_RULE_FILES = 4096;
export const MAX_REPOSITORY_RULE_TOTAL_BYTES = 16 * 1024 * 1024;
export const MAX_REPOSITORY_RULE_MANIFEST_BYTES = 4 * 1024 * 1024;
export const MAX_REPOSITORY_RULE_PATH_BYTES = 4 * 1024;

export type NestedAgentsLoaderErrorCode =
  | "repository_rule_artifact_invalid"
  | "repository_rules_discovery_incomplete"
  | "repository_rules_manifest_invalid"
  | "repository_rules_too_many";

export class NestedAgentsLoaderError extends Error {
  constructor(
    readonly code: NestedAgentsLoaderErrorCode,
    message: string,
    readonly exitCode: 1 | 2 | 8 = 1,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "NestedAgentsLoaderError";
  }
}

interface DiscoveredRules {
  readonly paths: readonly string[];
  readonly policySha256: string;
}

function depthAndScope(relativePath: string): { readonly depth: number; readonly scopePrefix: string } {
  const scopePrefix = relativePath.split("/").slice(0, -1).join("/");
  return { depth: scopePrefix === "" ? 0 : scopePrefix.split("/").length, scopePrefix };
}

function validArtifact(entry: RepositoryRuleEntryV1): boolean {
  return (
    entry.artifact.artifactId === `sha256:${entry.contentSha256}` &&
    entry.artifact.sha256 === entry.contentSha256 &&
    entry.artifact.bytes === entry.contentBytes
  );
}

export class NestedAgentsLoader {
  private readonly ignoredDirectories = Object.freeze([...DEFAULT_IGNORED_DIRECTORY_NAMES]);

  private constructor(
    private readonly reader: StableAgentsReader,
    private readonly artifactStore: RepositoryRulesArtifactPort,
  ) {}

  static async create(
    workspace: string,
    options: { readonly artifactStore: RepositoryRulesArtifactPort },
  ): Promise<NestedAgentsLoader> {
    return new NestedAgentsLoader(await StableAgentsReader.create(workspace), options.artifactStore);
  }

  async loadForRun(
    sourceStateSha256: string,
    options: { readonly preloadedRoot?: RepositoryRuleSet } = {},
  ): Promise<NestedRepositoryRuleSet> {
    if (!/^[a-f0-9]{64}$/u.test(sourceStateSha256)) {
      throw new NestedAgentsLoaderError("repository_rules_manifest_invalid", "source state hash is invalid", 2);
    }
    const discovered = await this.discover();
    const entries: RepositoryRuleEntryV1[] = [];
    const contentByPath = new Map<string, string>();
    let totalBytes = 0;
    for (const relativePath of discovered.paths) {
      let state;
      try {
        state = await this.reader.read(relativePath, { allowMissing: false });
      } catch (error) {
        throw new NestedAgentsLoaderError(
          "repository_rules_discovery_incomplete",
          "a discovered repository rule could not be loaded stably",
          8,
          { cause: error },
        );
      }
      if (state.state !== "loaded") {
        throw new NestedAgentsLoaderError("repository_rules_discovery_incomplete", "a discovered repository rule disappeared", 8);
      }
      totalBytes += state.bytes.byteLength;
      if (totalBytes > MAX_REPOSITORY_RULE_TOTAL_BYTES) {
        throw new NestedAgentsLoaderError("repository_rules_too_many", "repository rule content exceeds 16 MiB", 8);
      }
      const preloadedRoot = relativePath === "AGENTS.md" ? options.preloadedRoot : undefined;
      const artifact =
        preloadedRoot?.snapshot.state === "loaded" &&
        preloadedRoot.snapshot.contentSha256 === state.contentSha256 &&
        preloadedRoot.snapshot.contentBytes === state.bytes.byteLength &&
        preloadedRoot.snapshot.content === state.content
          ? preloadedRoot.snapshot.artifact
          : await this.artifactStore.storeRepositoryRules({
              bytes: Uint8Array.from(state.bytes),
              expectedSha256: state.contentSha256,
              mediaType: "text/markdown; charset=utf-8",
            });
      const scope = depthAndScope(relativePath);
      const entry = {
        artifact: { ...artifact },
        contentBytes: state.bytes.byteLength,
        contentSha256: state.contentSha256,
        depth: scope.depth,
        relativePath,
        scopePrefix: scope.scopePrefix,
      } satisfies RepositoryRuleEntryV1;
      if (!validArtifact(entry)) {
        throw new NestedAgentsLoaderError("repository_rule_artifact_invalid", "repository rule artifact identity is invalid");
      }
      entries.push(Object.freeze(entry));
      contentByPath.set(relativePath, state.content);
    }
    entries.sort(
      (left, right) => left.depth - right.depth || (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0),
    );
    const unsigned = {
      discoveryComplete: true as const,
      discoveryPolicySha256: discovered.policySha256,
      entries,
      schemaVersion: 1 as const,
      sourceStateSha256,
    };
    const identityDescriptor = repositoryRuleManifestIdentityDescriptor(unsigned);
    if (Buffer.byteLength(canonicalJson(identityDescriptor), "utf8") > MAX_REPOSITORY_RULE_MANIFEST_BYTES) {
      throw new NestedAgentsLoaderError("repository_rules_manifest_invalid", "repository rule manifest exceeds 4 MiB", 8);
    }
    let manifest: RepositoryRuleManifestV1;
    try {
      manifest = repositoryRuleManifestSchema.parse({ ...unsigned, manifestSha256: sha256Canonical(identityDescriptor) });
    } catch (error) {
      throw new NestedAgentsLoaderError("repository_rules_manifest_invalid", "repository rule manifest failed strict validation", 1, { cause: error });
    }
    return new NestedRepositoryRuleSet(manifest, contentByPath);
  }

  async inspectCurrentIdentity(): Promise<readonly { relativePath: string; contentBytes: number; contentSha256: string }[]> {
    const discovered = await this.discover();
    const identities: { relativePath: string; contentBytes: number; contentSha256: string }[] = [];
    for (const relativePath of discovered.paths) {
      try {
        const state = await this.reader.read(relativePath, { allowMissing: false });
        if (state.state !== "loaded") throw new Error("rule disappeared");
        identities.push({ relativePath, contentBytes: state.bytes.byteLength, contentSha256: state.contentSha256 });
      } catch (error) {
        if (error instanceof StableAgentsReaderError) {
          throw new NestedAgentsLoaderError("repository_rules_discovery_incomplete", "repository rule identity is invalid", 8, { cause: error });
        }
        throw error;
      }
    }
    return Object.freeze(identities);
  }

  private async discover(): Promise<DiscoveredRules> {
    const paths: string[] = [];
    const ignored = new Set(this.ignoredDirectories.map((name) => name.toLowerCase()));
    const visit = async (absoluteDirectory: string, relativeDirectory: string): Promise<void> => {
      let directory;
      try {
        directory = await opendir(absoluteDirectory);
      } catch (error) {
        throw new NestedAgentsLoaderError("repository_rules_discovery_incomplete", "repository rule discovery could not read a directory", 8, { cause: error });
      }
      for await (const entry of directory) {
        const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
        if (entry.name === "AGENTS.md") {
          if (entry.isDirectory() || entry.isSymbolicLink() || !entry.isFile()) {
            throw new NestedAgentsLoaderError("repository_rules_discovery_incomplete", "AGENTS.md is not a regular unlinked file", 8);
          }
          if (Buffer.byteLength(relativePath, "utf8") > MAX_REPOSITORY_RULE_PATH_BYTES) {
            throw new NestedAgentsLoaderError("repository_rules_discovery_incomplete", "repository rule path exceeds 4 KiB", 8);
          }
          paths.push(relativePath.replaceAll("\\", "/"));
          if (paths.length > MAX_REPOSITORY_RULE_FILES) {
            throw new NestedAgentsLoaderError("repository_rules_too_many", "repository contains more than 4096 rule files", 8);
          }
        } else if (entry.isDirectory() && !entry.isSymbolicLink() && !ignored.has(entry.name.toLowerCase())) {
          await visit(join(absoluteDirectory, entry.name), relativePath.replaceAll("\\", "/"));
        }
      }
    };
    await visit(this.reader.workspaceRealPath, "");
    paths.sort((left, right) => {
      const leftDepth = depthAndScope(left).depth;
      const rightDepth = depthAndScope(right).depth;
      return leftDepth - rightDepth || (left < right ? -1 : left > right ? 1 : 0);
    });
    if (new Set(paths.map((path) => path.toLowerCase())).size !== paths.length) {
      throw new NestedAgentsLoaderError("repository_rules_manifest_invalid", "repository rule paths collide case-insensitively", 8);
    }
    return Object.freeze({
      paths: Object.freeze(paths),
      policySha256: sha256Canonical({
        exactBasename: "AGENTS.md",
        ignoredDirectories: this.ignoredDirectories,
        limits: {
          manifestBytes: MAX_REPOSITORY_RULE_MANIFEST_BYTES,
          pathBytes: MAX_REPOSITORY_RULE_PATH_BYTES,
          ruleBytes: 64 * 1024,
          ruleFiles: MAX_REPOSITORY_RULE_FILES,
          totalBytes: MAX_REPOSITORY_RULE_TOTAL_BYTES,
        },
        policyVersion: 1,
      }),
    });
  }
}
