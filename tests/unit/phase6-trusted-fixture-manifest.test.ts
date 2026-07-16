import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  OFFLINE_NODE_GUARD_IDENTITY,
  OFFLINE_NODE_GUARD_SHA256,
} from "../../src/execution/environment-filter.js";
import { createDefaultExecutableRegistry } from "../../src/execution/executable-registry.js";
import { ExecutionPreparer } from "../../src/execution/execution-preparer.js";

import {
  createCommandActionIdentity,
  sha256Utf8,
} from "../../src/permissions/action-digest.js";
import {
  PHASE6_FIXTURE_CWD,
  localFreeOnlyPermissionPolicy,
} from "../../src/permissions/local-free-policy.js";
import { PermissionEngine } from "../../src/permissions/permission-engine.js";
import type {
  CommandActionIdentity,
  NormalizedCommandAction,
} from "../../src/permissions/permission-types.js";
import {
  TRUSTED_LOCAL_ENVIRONMENT_POLICY_ID,
  TRUSTED_LOCAL_ENVIRONMENT_POLICY_VERSION,
  TRUSTED_PHASE6_NODE_FIXTURE_REVIEWS,
  createTrustedLocalFixturePermissionContext,
  isTrustedLocalFreeEnvironmentPolicy,
  matchTrustedPhase6NodeFixture,
  type TrustedLocalNodeFixtureReview,
} from "../../src/permissions/trusted-local-fixture-manifest.js";

const BINARY_SHA256 = sha256Utf8("reviewed-host-node-binary");

describe("Phase 6 trusted local fixture manifest", () => {
  it("accepts the action identity produced by the real preparer", async () => {
    const preparer = await ExecutionPreparer.create({
      hostEnvironment: process.env,
      platform: process.platform,
      registry: createDefaultExecutableRegistry({
        execPath: process.execPath,
        hostEnvironment: process.env,
        platform: process.platform,
      }),
      workspace: process.cwd(),
    });
    for (const script of ["pass.mjs", "long-parent.mjs"]) {
      const prepared = await preparer.prepare({
        args: [script],
        cwd: PHASE6_FIXTURE_CWD,
        executable: "node",
        outputLimitBytes: 131_072,
        purpose: "verify",
        timeoutMs: 120_000,
      });

      expect(
        createTrustedLocalFixturePermissionContext(prepared.actionIdentity),
      ).toEqual({
        reviewedLocalActionSha256: [prepared.actionSha256],
      });
    }
  });

  it("matches every source-hardcoded hash to the actual checked-in bytes", async () => {
    const checkedPaths = new Set<string>();
    for (const review of TRUSTED_PHASE6_NODE_FIXTURE_REVIEWS) {
      for (const fingerprint of review.requiredFileHashes) {
        if (checkedPaths.has(fingerprint.canonicalPath)) {
          continue;
        }
        checkedPaths.add(fingerprint.canonicalPath);
        if (fingerprint.canonicalPath === OFFLINE_NODE_GUARD_IDENTITY) {
          expect(fingerprint.sha256).toBe(OFFLINE_NODE_GUARD_SHA256);
          continue;
        }
        const bytes = await readFile(resolve(fingerprint.canonicalPath));
        const actual = createHash("sha256").update(bytes).digest("hex");
        expect(actual, fingerprint.canonicalPath).toBe(fingerprint.sha256);
      }
    }
  });

  it("contains no direct destructive or grandchild entry", () => {
    const exactScripts = TRUSTED_PHASE6_NODE_FIXTURE_REVIEWS.map(
      (review) => review.exactArgv[0],
    );
    expect(exactScripts).not.toContain("delete-sentinel.mjs");
    expect(exactScripts).not.toContain("grandchild.mjs");
    expect(exactScripts).not.toContain("print-args.mjs");
  });

  it("creates a one-action context only after exact source review matching", () => {
    const review = findReview("pass.mjs");
    const action = makeReviewedAction(review);
    const context = createTrustedLocalFixturePermissionContext(action);

    expect(context).toEqual({
      reviewedLocalActionSha256: [action.actionSha256],
    });
    expect(matchTrustedPhase6NodeFixture(action)?.id).toBe(review.id);
    expect(
      new PermissionEngine(localFreeOnlyPermissionPolicy).evaluate(
        action,
        context ?? {},
      ).effect,
    ).toBe("ask");
  });

  it("rejects extra argv even when the requested script is reviewed", () => {
    const review = findReview("pass.mjs");
    const action = makeReviewedAction(review, {
      argv: ["pass.mjs", "extra"],
    });
    expect(createTrustedLocalFixturePermissionContext(action)).toBeNull();
  });

  it("rejects a changed fixture hash with a freshly recomputed action digest", () => {
    const review = findReview("pass.mjs");
    const action = makeReviewedAction(review, {
      executionInputs: {
        lockfileSha256: null,
        manifestSha256: null,
        runnerConfigHashes: review.requiredFileHashes.map((fingerprint) =>
          fingerprint.canonicalPath === `${PHASE6_FIXTURE_CWD}/pass.mjs`
            ? {
                ...fingerprint,
                sha256: sha256Utf8("changed fixture bytes"),
              }
            : fingerprint,
        ),
      },
    });
    expect(createTrustedLocalFixturePermissionContext(action)).toBeNull();
  });

  it("rejects delete-sentinel and direct grandchild actions", async () => {
    for (const scriptName of ["delete-sentinel.mjs", "grandchild.mjs"]) {
      const bytes = await readFile(resolve(PHASE6_FIXTURE_CWD, scriptName));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const action = makeUnlistedAction(scriptName, sha256);
      expect(createTrustedLocalFixturePermissionContext(action)).toBeNull();
    }
  });

  it("requires the reviewed grandchild dependency for the parent fixture", () => {
    const review = findReview("long-parent.mjs");
    expect(review.requiredFileHashes).toHaveLength(3);
    expect(createTrustedLocalFixturePermissionContext(makeReviewedAction(review))).not.toBeNull();

    const withoutDependency = makeReviewedAction(review, {
      executionInputs: {
        lockfileSha256: null,
        manifestSha256: null,
        runnerConfigHashes: [review.requiredFileHashes[0]!],
      },
    });
    expect(createTrustedLocalFixturePermissionContext(withoutDependency)).toBeNull();
  });

  it("fails closed for missing offline guards or added credential names", () => {
    const valid = localEnvironmentNames();
    expect(
      isTrustedLocalFreeEnvironmentPolicy({
        id: TRUSTED_LOCAL_ENVIRONMENT_POLICY_ID,
        variableNames: valid,
        version: TRUSTED_LOCAL_ENVIRONMENT_POLICY_VERSION,
      }),
    ).toBe(true);

    const review = findReview("pass.mjs");
    const missingGuard = makeReviewedAction(review, {
      environmentPolicy: {
        id: TRUSTED_LOCAL_ENVIRONMENT_POLICY_ID,
        variableNames: valid.filter((name) => name !== "COREPACK_ENABLE_NETWORK"),
        version: TRUSTED_LOCAL_ENVIRONMENT_POLICY_VERSION,
      },
    });
    expect(createTrustedLocalFixturePermissionContext(missingGuard)).toBeNull();

    const credentialAdded = makeReviewedAction(review, {
      environmentPolicy: {
        id: TRUSTED_LOCAL_ENVIRONMENT_POLICY_ID,
        variableNames: [...valid, "OPENAI_API_KEY"],
        version: TRUSTED_LOCAL_ENVIRONMENT_POLICY_VERSION,
      },
    });
    expect(createTrustedLocalFixturePermissionContext(credentialAdded)).toBeNull();
  });

  it("rejects changed cwd, purpose, timeout, output bound, and forged identity", () => {
    const review = findReview("pass.mjs");
    const changes: readonly Partial<NormalizedCommandAction>[] = [
      { canonicalCwd: "." },
      { purpose: "inspect" },
      { timeoutMs: review.timeoutMs - 1 },
      { outputLimitBytes: review.outputLimitBytes - 1 },
    ];
    for (const change of changes) {
      expect(
        createTrustedLocalFixturePermissionContext(
          makeReviewedAction(review, change),
        ),
      ).toBeNull();
    }

    const valid = makeReviewedAction(review);
    const forged = {
      ...valid,
      actionSha256: sha256Utf8("forged"),
    } as CommandActionIdentity;
    expect(createTrustedLocalFixturePermissionContext(forged)).toBeNull();
  });
});

function makeReviewedAction(
  review: TrustedLocalNodeFixtureReview,
  overrides: Partial<NormalizedCommandAction> = {},
): CommandActionIdentity {
  return createCommandActionIdentity({
    actionKind: "command",
    argv: review.exactArgv,
    binary: {
      bytesSha256: BINARY_SHA256,
      canonicalIdentity: "trusted-runtime:node",
      version: "v22.0.0",
    },
    canonicalCwd: PHASE6_FIXTURE_CWD,
    environmentPolicy: {
      id: TRUSTED_LOCAL_ENVIRONMENT_POLICY_ID,
      variableNames: localEnvironmentNames(),
      version: TRUSTED_LOCAL_ENVIRONMENT_POLICY_VERSION,
    },
    executionInputs: {
      lockfileSha256: null,
      manifestSha256: null,
      runnerConfigHashes: review.requiredFileHashes,
    },
    lifecycleScripts: null,
    logicalExecutable: "node",
    outputLimitBytes: review.outputLimitBytes,
    packageManager: null,
    purpose: review.purpose,
    timeoutMs: review.timeoutMs,
    ...overrides,
  });
}

function makeUnlistedAction(
  scriptName: string,
  sha256: string,
): CommandActionIdentity {
  const syntheticReview: TrustedLocalNodeFixtureReview = {
    canonicalCwd: PHASE6_FIXTURE_CWD,
    exactArgv: [scriptName],
    id: "test.unlisted",
    outputLimitBytes: 131_072,
    purpose: "verify",
    requiredFileHashes: [
      {
        canonicalPath: `${PHASE6_FIXTURE_CWD}/${scriptName}`,
        sha256,
      },
    ],
    timeoutMs: 120_000,
  };
  return makeReviewedAction(syntheticReview);
}

function findReview(scriptName: string): TrustedLocalNodeFixtureReview {
  const review = TRUSTED_PHASE6_NODE_FIXTURE_REVIEWS.find(
    (candidate) => candidate.exactArgv[0] === scriptName,
  );
  if (review === undefined) {
    throw new Error(`missing trusted fixture review for ${scriptName}`);
  }
  return review;
}

function localEnvironmentNames(): readonly string[] {
  return [
    "CI",
    "COREPACK_ENABLE_NETWORK",
    "NO_COLOR",
    "NPM_CONFIG_OFFLINE",
    "NODE_OPTIONS",
    "PATH",
    "YARN_ENABLE_NETWORK",
  ];
}
