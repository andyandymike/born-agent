export const ROOT_AGENTS_RELATIVE_PATH = "AGENTS.md" as const;

export interface RepositoryRulesArtifactReference {
  readonly artifactId: `sha256:${string}`;
  readonly bytes: number;
  readonly relativeRef: string;
  readonly sha256: string;
}

export interface MissingRepositoryRulesSnapshot {
  readonly artifact: null;
  readonly content: null;
  readonly contentBytes: 0;
  readonly contentSha256: null;
  readonly relativePath: typeof ROOT_AGENTS_RELATIVE_PATH;
  readonly state: "missing";
}

export interface LoadedRepositoryRulesSnapshot {
  readonly artifact: RepositoryRulesArtifactReference;
  readonly content: string;
  readonly contentBytes: number;
  readonly contentSha256: string;
  readonly relativePath: typeof ROOT_AGENTS_RELATIVE_PATH;
  readonly state: "loaded";
}

export type RepositoryRulesSnapshot =
  | LoadedRepositoryRulesSnapshot
  | MissingRepositoryRulesSnapshot;

export type RepositoryRulesIdentity =
  | {
      readonly contentSha256: null;
      readonly state: "missing";
    }
  | {
      readonly contentSha256: string;
      readonly state: "loaded";
    };

export type RepositoryRulesChangeReason =
  | "content_changed"
  | "created"
  | "invalid"
  | "removed"
  | "unchanged";

export type RepositoryRulesChangeDetection =
  | {
      readonly changed: false;
      readonly current: RepositoryRulesIdentity;
      readonly frozen: RepositoryRulesIdentity;
      readonly reason: "unchanged";
    }
  | {
      readonly changed: true;
      readonly current: RepositoryRulesIdentity;
      readonly frozen: RepositoryRulesIdentity;
      readonly reason: "content_changed" | "created" | "removed";
    }
  | {
      readonly changed: true;
      readonly current: {
        readonly errorCode: string;
        readonly state: "invalid";
      };
      readonly frozen: RepositoryRulesIdentity;
      readonly reason: "invalid";
    };

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
}

function frozenIdentity(snapshot: RepositoryRulesSnapshot): RepositoryRulesIdentity {
  return Object.freeze(
    snapshot.state === "missing"
      ? { contentSha256: null, state: "missing" as const }
      : {
          contentSha256: snapshot.contentSha256,
          state: "loaded" as const,
        },
  );
}

/**
 * Immutable, run-scoped repository instruction snapshot.
 *
 * A later disk probe is deliberately represented separately; it can report a
 * change, but it cannot replace the content or artifact held by this object.
 */
export class RepositoryRuleSet {
  readonly snapshot: RepositoryRulesSnapshot;

  private constructor(snapshot: RepositoryRulesSnapshot) {
    this.snapshot = snapshot;
    Object.freeze(this);
  }

  static missing(): RepositoryRuleSet {
    return new RepositoryRuleSet(
      Object.freeze({
        artifact: null,
        content: null,
        contentBytes: 0,
        contentSha256: null,
        relativePath: ROOT_AGENTS_RELATIVE_PATH,
        state: "missing",
      }),
    );
  }

  static loaded(input: {
    readonly artifact: RepositoryRulesArtifactReference;
    readonly content: string;
    readonly contentBytes: number;
    readonly contentSha256: string;
  }): RepositoryRuleSet {
    assertSha256(input.contentSha256, "repository rules hash");
    assertSha256(input.artifact.sha256, "repository rules artifact hash");
    if (
      input.contentBytes < 0 ||
      !Number.isSafeInteger(input.contentBytes) ||
      input.artifact.bytes !== input.contentBytes ||
      input.artifact.sha256 !== input.contentSha256 ||
      input.artifact.artifactId !== `sha256:${input.contentSha256}`
    ) {
      throw new TypeError("repository rules artifact does not match its content");
    }

    const artifact = Object.freeze({ ...input.artifact });
    return new RepositoryRuleSet(
      Object.freeze({
        artifact,
        content: input.content,
        contentBytes: input.contentBytes,
        contentSha256: input.contentSha256,
        relativePath: ROOT_AGENTS_RELATIVE_PATH,
        state: "loaded",
      }),
    );
  }

  identity(): RepositoryRulesIdentity {
    return frozenIdentity(this.snapshot);
  }
}

export function compareRepositoryRules(
  frozen: RepositoryRuleSet,
  current: RepositoryRulesIdentity,
): RepositoryRulesChangeDetection {
  const frozenValue = frozen.identity();
  const currentValue = Object.freeze({ ...current }) as RepositoryRulesIdentity;
  if (frozenValue.state === currentValue.state) {
    if (
      frozenValue.state === "missing" ||
      (currentValue.state === "loaded" &&
        frozenValue.contentSha256 === currentValue.contentSha256)
    ) {
      return Object.freeze({
        changed: false,
        current: currentValue,
        frozen: frozenValue,
        reason: "unchanged",
      });
    }
    return Object.freeze({
      changed: true,
      current: currentValue,
      frozen: frozenValue,
      reason: "content_changed",
    });
  }

  return Object.freeze({
    changed: true,
    current: currentValue,
    frozen: frozenValue,
    reason: frozenValue.state === "missing" ? "created" : "removed",
  });
}

export function invalidRepositoryRulesChange(
  frozen: RepositoryRuleSet,
  errorCode: string,
): RepositoryRulesChangeDetection {
  return Object.freeze({
    changed: true,
    current: Object.freeze({ errorCode, state: "invalid" }),
    frozen: frozen.identity(),
    reason: "invalid",
  });
}
