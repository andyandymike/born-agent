import { createCommandActionIdentity } from "./action-digest.js";
import { PHASE6_FIXTURE_CWD } from "./local-free-policy.js";
import type {
  CommandActionIdentity,
  EnvironmentPolicyIdentity,
  PermissionContext,
  RunnerConfigFingerprint,
} from "./permission-types.js";

export const TRUSTED_LOCAL_ENVIRONMENT_POLICY_ID =
  "bornagent.local-minimal-env";
export const TRUSTED_LOCAL_ENVIRONMENT_POLICY_VERSION = "2";
export const TRUSTED_OFFLINE_NODE_GUARD_IDENTITY =
  "@bornagent/network-guard-v1";
export const TRUSTED_OFFLINE_NODE_GUARD_SHA256 =
  "4a4a0ce3be28637820c9c9031e92f977a3242a5c95f9c913f50075dcd61d9865";

const REVIEWED_TIMEOUT_MS = 120_000;
const REVIEWED_OUTPUT_LIMIT_BYTES = 131_072;

const REQUIRED_LOCAL_FREE_ENVIRONMENT_NAMES = Object.freeze([
  "CI",
  "COREPACK_ENABLE_NETWORK",
  "NO_COLOR",
  "NPM_CONFIG_OFFLINE",
  "NODE_OPTIONS",
  "YARN_ENABLE_NETWORK",
]);

const ALLOWED_LOCAL_FREE_ENVIRONMENT_NAMES = new Set([
  ...REQUIRED_LOCAL_FREE_ENVIRONMENT_NAMES,
  "HOME",
  "NODE_OPTIONS",
  "PATH",
  "Path",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
]);

export interface TrustedLocalNodeFixtureReview {
  readonly exactArgv: readonly [string];
  readonly id: string;
  readonly outputLimitBytes: number;
  readonly purpose: "verify";
  readonly requiredFileHashes: readonly RunnerConfigFingerprint[];
  readonly timeoutMs: number;
}

export const TRUSTED_PHASE6_NODE_FIXTURE_REVIEWS: readonly TrustedLocalNodeFixtureReview[] =
  Object.freeze([
    fixtureReview(
      "phase6.fixture.pass.v1",
      "pass.mjs",
      "685fce1111bf60a1571ac333242c427a07733cb5696d6b35a0702110887ed507",
    ),
    fixtureReview(
      "phase6.fixture.fail.v1",
      "fail.mjs",
      "ee231deec4995999c83b7995b1e742fdf86c6bae7eca41b23c49ba9f9d31ac26",
    ),
    fixtureReview(
      "phase6.fixture.mixed-output.v1",
      "mixed-output.mjs",
      "438f9648c4d2e5aab786a3b5bed3c4d606021b6bd58aa381bee6bec1d6efb453",
    ),
    fixtureReview(
      "phase6.fixture.print-env.v1",
      "print-env.mjs",
      "757935b2ec56d5227f09c1d5d0e9e7559301b98d62a2efd0ab489f346e126fed",
    ),
    fixtureReview(
      "phase6.fixture.output-limit.v1",
      "flood.mjs",
      "8eaa9a390216e486ab13378f7f770280518c5fefc92b80ecc56e2064c2e0c9f8",
    ),
    fixtureReview(
      "phase6.fixture.process-tree.v1",
      "long-parent.mjs",
      "98a1fbb151aa137cedcc14d44beaa95ca63f352c3227ab2a0bd95b0c92ba22ba",
      [
        Object.freeze({
          canonicalPath: `${PHASE6_FIXTURE_CWD}/grandchild.mjs`,
          sha256:
            "5cdecfcf00b1db1f11e3fec4b91b1a5b813baf9457652a3aeb2929c786dcfc8a",
        }),
      ],
    ),
  ]);

/**
 * Checks the identity of the env policy, not secret values. Policy version 2 is
 * the trusted contract that fixes the offline values for the required guards.
 */
export function isTrustedLocalFreeEnvironmentPolicy(
  policy: EnvironmentPolicyIdentity,
): boolean {
  if (
    policy.id !== TRUSTED_LOCAL_ENVIRONMENT_POLICY_ID ||
    policy.version !== TRUSTED_LOCAL_ENVIRONMENT_POLICY_VERSION
  ) {
    return false;
  }

  const uniqueNames = new Set(policy.variableNames);
  if (uniqueNames.size !== policy.variableNames.length) {
    return false;
  }
  if (
    policy.variableNames.some(
      (name) => !ALLOWED_LOCAL_FREE_ENVIRONMENT_NAMES.has(name),
    )
  ) {
    return false;
  }
  return REQUIRED_LOCAL_FREE_ENVIRONMENT_NAMES.every((name) =>
    uniqueNames.has(name),
  );
}

export function matchTrustedPhase6NodeFixture(
  action: CommandActionIdentity,
): TrustedLocalNodeFixtureReview | null {
  const verified = verifyActionIdentity(action);
  if (
    verified === null ||
    verified.logicalExecutable !== "node" ||
    verified.canonicalCwd !== PHASE6_FIXTURE_CWD ||
    verified.packageManager !== null ||
    verified.lifecycleScripts !== null ||
    verified.executionInputs.manifestSha256 !== null ||
    verified.executionInputs.lockfileSha256 !== null ||
    !isTrustedLocalFreeEnvironmentPolicy(verified.environmentPolicy)
  ) {
    return null;
  }

  for (const review of TRUSTED_PHASE6_NODE_FIXTURE_REVIEWS) {
    if (
      arraysEqual(verified.argv, review.exactArgv) &&
      verified.purpose === review.purpose &&
      verified.timeoutMs === review.timeoutMs &&
      verified.outputLimitBytes === review.outputLimitBytes &&
      fingerprintArraysEqual(
        verified.executionInputs.runnerConfigHashes,
        review.requiredFileHashes,
      )
    ) {
      return review;
    }
  }
  return null;
}

export function createTrustedLocalFixturePermissionContext(
  action: CommandActionIdentity,
): PermissionContext | null {
  if (matchTrustedPhase6NodeFixture(action) === null) {
    return null;
  }

  // PHASE6: The current digest enters the approval context only after source-owned
  // path, argv, file hashes, bounds, and offline env policy all match. Echoing an
  // arbitrary model action digest here would turn the review gate into allow-all.
  return Object.freeze({
    reviewedLocalActionSha256: Object.freeze([action.actionSha256]),
  });
}

function fixtureReview(
  id: string,
  scriptName: string,
  scriptSha256: string,
  dependencies: readonly RunnerConfigFingerprint[] = [],
): TrustedLocalNodeFixtureReview {
  const hashes = [
    Object.freeze({
      canonicalPath: TRUSTED_OFFLINE_NODE_GUARD_IDENTITY,
      sha256: TRUSTED_OFFLINE_NODE_GUARD_SHA256,
    }),
    Object.freeze({
      canonicalPath: `${PHASE6_FIXTURE_CWD}/${scriptName}`,
      sha256: scriptSha256,
    }),
    ...dependencies,
  ].sort((left, right) => left.canonicalPath.localeCompare(right.canonicalPath));
  return Object.freeze({
    exactArgv: Object.freeze([scriptName]) as readonly [string],
    id,
    outputLimitBytes: REVIEWED_OUTPUT_LIMIT_BYTES,
    purpose: "verify",
    requiredFileHashes: Object.freeze(hashes),
    timeoutMs: REVIEWED_TIMEOUT_MS,
  });
}

function verifyActionIdentity(
  action: CommandActionIdentity,
): CommandActionIdentity | null {
  try {
    const verified = createCommandActionIdentity(action);
    return verified.actionSha256 === action.actionSha256 &&
      verified.executionInputsSha256 === action.executionInputsSha256
      ? verified
      : null;
  } catch {
    return null;
  }
}

function fingerprintArraysEqual(
  left: readonly RunnerConfigFingerprint[],
  right: readonly RunnerConfigFingerprint[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (fingerprint, index) =>
        fingerprint.canonicalPath === right[index]?.canonicalPath &&
        fingerprint.sha256 === right[index]?.sha256,
    )
  );
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
