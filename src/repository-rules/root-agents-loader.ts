import { isAbsolute, win32 } from "node:path";

import {
  compareRepositoryRules,
  invalidRepositoryRulesChange,
  RepositoryRuleSet,
  ROOT_AGENTS_RELATIVE_PATH,
  type RepositoryRulesArtifactReference,
  type RepositoryRulesChangeDetection,
  type RepositoryRulesIdentity,
} from "./repository-rule-set.js";
import {
  MAX_REPOSITORY_RULE_BYTES,
  StableAgentsReader,
  StableAgentsReaderError,
  type StableAgentsReaderErrorCode,
  type StableAgentsDiskState,
} from "./stable-agents-reader.js";

export const MAX_ROOT_AGENTS_BYTES = MAX_REPOSITORY_RULE_BYTES;

export interface RepositoryRulesArtifactInput {
  readonly bytes: Uint8Array;
  readonly expectedSha256: string;
  readonly mediaType: "text/markdown; charset=utf-8";
}

export interface RepositoryRulesArtifactPort {
  storeRepositoryRules(input: RepositoryRulesArtifactInput): Promise<RepositoryRulesArtifactReference>;
}

export type RootAgentsLoaderErrorCode = StableAgentsReaderErrorCode | "artifact_reference_invalid";

export class RootAgentsLoaderError extends Error {
  override readonly name = "RootAgentsLoaderError";

  constructor(readonly code: RootAgentsLoaderErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

function validRelativeArtifactRef(value: string): boolean {
  const hasControlCharacter = Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
  return (
    value.length > 0 &&
    !value.includes("\\") &&
    !hasControlCharacter &&
    !isAbsolute(value) &&
    !win32.isAbsolute(value) &&
    !/^[a-zA-Z]:/u.test(value) &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function diskIdentity(state: StableAgentsDiskState): RepositoryRulesIdentity {
  return state.state === "missing"
    ? Object.freeze({ contentSha256: null, state: "missing" as const })
    : Object.freeze({ contentSha256: state.contentSha256, state: "loaded" as const });
}

export class RootAgentsLoader {
  private constructor(
    private readonly reader: StableAgentsReader,
    private readonly artifactStore: RepositoryRulesArtifactPort,
  ) {}

  get workspaceRealPath(): string {
    return this.reader.workspaceRealPath;
  }

  static async create(
    workspace: string,
    options: { readonly artifactStore: RepositoryRulesArtifactPort },
  ): Promise<RootAgentsLoader> {
    try {
      return new RootAgentsLoader(await StableAgentsReader.create(workspace), options.artifactStore);
    } catch (error) {
      if (error instanceof StableAgentsReaderError) {
        throw new RootAgentsLoaderError(error.code, error.message, { cause: error });
      }
      throw error;
    }
  }

  async loadForRun(): Promise<RepositoryRuleSet> {
    const state = await this.readDiskState();
    if (state.state === "missing") return RepositoryRuleSet.missing();
    const artifact = await this.artifactStore.storeRepositoryRules({
      bytes: Uint8Array.from(state.bytes),
      expectedSha256: state.contentSha256,
      mediaType: "text/markdown; charset=utf-8",
    });
    if (
      artifact.bytes !== state.bytes.byteLength ||
      artifact.sha256 !== state.contentSha256 ||
      artifact.artifactId !== `sha256:${state.contentSha256}` ||
      !validRelativeArtifactRef(artifact.relativeRef)
    ) {
      throw new RootAgentsLoaderError("artifact_reference_invalid", "repository rules artifact reference does not match frozen content");
    }
    return RepositoryRuleSet.loaded({
      artifact,
      content: state.content,
      contentBytes: state.bytes.byteLength,
      contentSha256: state.contentSha256,
    });
  }

  async detectChange(frozen: RepositoryRuleSet): Promise<RepositoryRulesChangeDetection> {
    try {
      return compareRepositoryRules(frozen, diskIdentity(await this.readDiskState()));
    } catch (error) {
      if (error instanceof RootAgentsLoaderError) return invalidRepositoryRulesChange(frozen, error.code);
      throw error;
    }
  }

  private async readDiskState(): Promise<StableAgentsDiskState> {
    try {
      return await this.reader.read(ROOT_AGENTS_RELATIVE_PATH, { allowMissing: true });
    } catch (error) {
      if (error instanceof StableAgentsReaderError) {
        throw new RootAgentsLoaderError(error.code, error.message, { cause: error });
      }
      throw error;
    }
  }
}
