import type { RepositoryRuleSet } from "./repository-rule-set.js";
import { RepositoryRuleSet as RootRuleSet } from "./repository-rule-set.js";
import type { RepositoryRuleEntryV1, RepositoryRuleManifestV1 } from "./repository-rule-manifest-schema.js";

export class NestedRepositoryRuleSet {
  readonly manifest: RepositoryRuleManifestV1;
  readonly totalContentBytes: number;
  readonly rootRules: RepositoryRuleSet;
  readonly #contentByPath: ReadonlyMap<string, string>;

  constructor(
    manifest: RepositoryRuleManifestV1,
    contentByPath: ReadonlyMap<string, string>,
  ) {
    this.manifest = Object.freeze(manifest);
    this.#contentByPath = new Map(contentByPath);
    this.totalContentBytes = manifest.entries.reduce((total, entry) => total + entry.contentBytes, 0);
    const root = manifest.entries.find((entry) => entry.relativePath === "AGENTS.md");
    this.rootRules =
      root === undefined
        ? RootRuleSet.missing()
        : RootRuleSet.loaded({
            artifact: {
              ...root.artifact,
              artifactId: root.artifact.artifactId as `sha256:${string}`,
            },
            content: this.content(root),
            contentBytes: root.contentBytes,
            contentSha256: root.contentSha256,
          });
    Object.freeze(this);
  }

  content(entryOrPath: RepositoryRuleEntryV1 | string): string {
    const path = typeof entryOrPath === "string" ? entryOrPath : entryOrPath.relativePath;
    const content = this.#contentByPath.get(path);
    if (content === undefined) throw new TypeError(`repository rule content is missing for ${path}`);
    return content;
  }
}
