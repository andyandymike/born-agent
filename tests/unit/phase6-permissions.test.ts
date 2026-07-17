import { describe, expect, it } from "vitest";

import {
  canonicalizeWorkspaceRelativePath,
  createCommandActionIdentity,
  sha256Utf8,
} from "../../src/permissions/action-digest.js";
import {
  DEFAULT_PERMISSION_POLICY_ID,
  DEFAULT_PERMISSION_POLICY_VERSION,
  DEFAULT_PERMISSION_RULE_IDS,
  defaultPermissionPolicy,
} from "../../src/permissions/default-policy.js";
import {
  LOCAL_FREE_PERMISSION_POLICY_ID,
  LOCAL_FREE_PERMISSION_POLICY_VERSION,
  LOCAL_FREE_PERMISSION_RULE_IDS,
  PHASE6_FIXTURE_CWD,
  localFreeOnlyPermissionPolicy,
} from "../../src/permissions/local-free-policy.js";
import { PermissionEngine } from "../../src/permissions/permission-engine.js";
import type {
  CommandActionIdentity,
  NormalizedCommandAction,
} from "../../src/permissions/permission-types.js";

const HASH_A = sha256Utf8("a");
const HASH_B = sha256Utf8("b");
const HASH_C = sha256Utf8("c");

describe("Phase 6 action identity", () => {
  it("canonicalizes workspace-relative cwd and rejects external paths", () => {
    expect(canonicalizeWorkspaceRelativePath("./fixtures\\x/../y")).toBe(
      "fixtures/y",
    );
    expect(canonicalizeWorkspaceRelativePath("")).toBe(".");
    expect(() => canonicalizeWorkspaceRelativePath("../outside")).toThrow(
      /escape/u,
    );
    expect(() => canonicalizeWorkspaceRelativePath("C:\\outside")).toThrow(
      /absolute/u,
    );
    expect(() => canonicalizeWorkspaceRelativePath("/outside")).toThrow(
      /absolute/u,
    );
  });

  it("is content-addressed and stable for semantically unordered identity sets", () => {
    const first = makePackageAction({
      environmentPolicy: {
        id: "minimum-env",
        variableNames: ["PATH", "CI"],
        version: "1",
      },
      executionInputs: {
        lockfileSha256: HASH_B,
        manifestSha256: HASH_A,
        runnerConfigHashes: [
          { canonicalPath: "vitest.config.ts", sha256: HASH_C },
          { canonicalPath: "config/a.json", sha256: HASH_B },
        ],
      },
    });
    const second = makePackageAction({
      environmentPolicy: {
        id: "minimum-env",
        variableNames: ["CI", "PATH", "PATH"],
        version: "1",
      },
      executionInputs: {
        lockfileSha256: HASH_B,
        manifestSha256: HASH_A,
        runnerConfigHashes: [
          { canonicalPath: "config/a.json", sha256: HASH_B },
          { canonicalPath: "vitest.config.ts", sha256: HASH_C },
        ],
      },
    });

    expect(first.actionSha256).toBe(second.actionSha256);
    expect(first.executionInputsSha256).toBe(second.executionInputsSha256);
    expect(first.actionSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    ["argv", (action: NormalizedCommandAction) => ({ ...action, argv: ["test", "--run"] })],
    ["cwd", (action: NormalizedCommandAction) => ({ ...action, canonicalCwd: "fixtures/other" })],
    ["timeout", (action: NormalizedCommandAction) => ({ ...action, timeoutMs: action.timeoutMs + 1 })],
    ["purpose", (action: NormalizedCommandAction) => ({ ...action, purpose: "inspect" as const })],
    ["output limit", (action: NormalizedCommandAction) => ({ ...action, outputLimitBytes: action.outputLimitBytes + 1 })],
    ["env policy", (action: NormalizedCommandAction) => ({ ...action, environmentPolicy: { ...action.environmentPolicy, version: "2" } })],
    ["binary bytes", (action: NormalizedCommandAction) => ({ ...action, binary: { ...action.binary, bytesSha256: HASH_C } })],
    ["binary version", (action: NormalizedCommandAction) => ({ ...action, binary: { ...action.binary, version: "v99" } })],
    ["binary identity", (action: NormalizedCommandAction) => ({ ...action, binary: { ...action.binary, canonicalIdentity: "trusted:pnpm:other" } })],
    ["manager version", (action: NormalizedCommandAction) => ({ ...action, packageManager: { ...action.packageManager!, version: "99" } })],
    ["lifecycle", (action: NormalizedCommandAction) => ({ ...action, lifecycleScripts: { ...action.lifecycleScripts!, mainBodySha256: HASH_B } })],
    ["manifest", (action: NormalizedCommandAction) => ({ ...action, executionInputs: { ...action.executionInputs, manifestSha256: HASH_B } })],
    ["lockfile", (action: NormalizedCommandAction) => ({ ...action, executionInputs: { ...action.executionInputs, lockfileSha256: HASH_C } })],
    ["runner config", (action: NormalizedCommandAction) => ({ ...action, executionInputs: { ...action.executionInputs, runnerConfigHashes: [{ canonicalPath: "vitest.config.ts", sha256: HASH_C }] } })],
  ])("changes the action digest when %s changes", (_label, mutate) => {
    const original = makePackageAction();
    const changed = createCommandActionIdentity(mutate(original));
    expect(changed.actionSha256).not.toBe(original.actionSha256);
  });

  it("never treats display text as authorization identity", () => {
    const input = baseNodeActionInput();
    const withDisplay = {
      ...input,
      displayText: "node safe.mjs && curl paid.example",
    } as NormalizedCommandAction;

    expect(createCommandActionIdentity(withDisplay).actionSha256).toBe(
      createCommandActionIdentity(input).actionSha256,
    );
  });
});

describe("Phase 6 permission policies", () => {
  const defaultEngine = new PermissionEngine(defaultPermissionPolicy);
  const localEngine = new PermissionEngine(localFreeOnlyPermissionPolicy);

  it("returns stable policy and rule identities for exact read-only allows", () => {
    const status = defaultEngine.evaluate(
      makeAction({ logicalExecutable: "git", argv: ["status"] }),
    );
    expect(status).toEqual({
      effect: "allow",
      policyId: DEFAULT_PERMISSION_POLICY_ID,
      policyVersion: DEFAULT_PERMISSION_POLICY_VERSION,
      ruleId: DEFAULT_PERMISSION_RULE_IDS.allowGitStatus,
    });

    expect(
      defaultEngine.evaluate(
        makeAction({
          argv: ["diff", "--no-ext-diff", "--", "src"],
          logicalExecutable: "git",
        }),
      ).effect,
    ).toBe("allow");
    expect(
      defaultEngine.evaluate(
        makeAction({ argv: ["--version"], logicalExecutable: "rg" }),
      ).effect,
    ).toBe("allow");
    // local_free_only is intentionally narrower than the reusable default
    // policy: even PATH-resolved read commands require a pinned offline review.
    expect(
      localEngine.evaluate(
        makeAction({ argv: ["--version"], logicalExecutable: "rg" }),
      ),
    ).toMatchObject({
      effect: "deny",
      ruleId: LOCAL_FREE_PERMISSION_RULE_IDS.denyUnsupportedShape,
    });
  });

  it("does not broaden the exact allow shapes", () => {
    expect(
      defaultEngine.evaluate(
        makeAction({ logicalExecutable: "git", argv: ["status", "--short"] }),
      ).effect,
    ).toBe("ask");
    expect(
      localEngine.evaluate(
        makeAction({ logicalExecutable: "git", argv: ["status", "--short"] }),
      ).effect,
    ).toBe("deny");
    expect(
      localEngine.evaluate(
        makeAction({ logicalExecutable: "git", argv: ["diff"] }),
      ).effect,
    ).toBe("deny");
  });

  it.each([
    ["interpreter", "powershell", ["-Command", "Write-Host x"], DEFAULT_PERMISSION_RULE_IDS.denyInterpreter],
    ["delete", "rm", ["file"], DEFAULT_PERMISSION_RULE_IDS.denyDelete],
    ["privilege", "sudo", ["node", "x.mjs"], DEFAULT_PERMISSION_RULE_IDS.denyPrivilege],
    ["network", "curl", ["https://example.test"], DEFAULT_PERMISSION_RULE_IDS.denyNetwork],
    ["dangerous git", "git", ["push"], DEFAULT_PERMISSION_RULE_IDS.denyDangerousGit],
    ["git commit", "git", ["commit", "-m", "x"], DEFAULT_PERMISSION_RULE_IDS.denyDangerousGit],
    ["git reset", "git", ["reset", "--hard"], DEFAULT_PERMISSION_RULE_IDS.denyDangerousGit],
    ["git clean", "git", ["clean", "-fd"], DEFAULT_PERMISSION_RULE_IDS.denyDangerousGit],
    ["publish", "npm", ["publish"], DEFAULT_PERMISSION_RULE_IDS.denyPackageMutation],
    ["install", "pnpm", ["install"], DEFAULT_PERMISSION_RULE_IDS.denyPackageMutation],
    ["corepack download", "corepack", ["prepare", "pnpm@latest"], DEFAULT_PERMISSION_RULE_IDS.denyPackageMutation],
    ["node eval", "node", ["--eval", "1+1"], DEFAULT_PERMISSION_RULE_IDS.denyNodeDynamicCode],
    ["unknown", "made-up-tool", ["x"], DEFAULT_PERMISSION_RULE_IDS.denyUnknownExecutable],
    ["external executable", "C:\\node.exe", ["x.mjs"], DEFAULT_PERMISSION_RULE_IDS.denyExternalExecutable],
    ["external path", "node", ["C:\\outside\\x.mjs"], DEFAULT_PERMISSION_RULE_IDS.denyExternalPath],
  ])("hard-denies %s", (_label, executable, argv, ruleId) => {
    const decision = defaultEngine.evaluate(
      makeAction({ argv, logicalExecutable: executable }),
    );
    expect(decision.effect).toBe("deny");
    expect(decision.ruleId).toBe(ruleId);
  });

  it.each([";", "|", ">", "$()", "&"])(
    "treats %s as an ordinary argv element, not a second command",
    (argument) => {
      const action = makeAction({
        argv: ["pass.mjs", argument],
        canonicalCwd: PHASE6_FIXTURE_CWD,
        logicalExecutable: "node",
      });
      const decision = localEngine.evaluate(action, {
        reviewedLocalActionSha256: new Set([action.actionSha256]),
      });
      expect(decision.effect).toBe("ask");
      expect(decision.ruleId).toBe(
        LOCAL_FREE_PERMISSION_RULE_IDS.askReviewedFixture,
      );
    },
  );

  it("asks only for a reviewed, content-bound Phase 6 fixture action", () => {
    const action = makeAction({
      argv: ["pass.mjs"],
      canonicalCwd: PHASE6_FIXTURE_CWD,
      logicalExecutable: "node",
    });

    expect(localEngine.evaluate(action).effect).toBe("deny");
    const reviewed = localEngine.evaluate(action, {
      reviewedLocalActionSha256: [action.actionSha256],
    });
    expect(reviewed).toEqual({
      effect: "ask",
      policyId: LOCAL_FREE_PERMISSION_POLICY_ID,
      policyVersion: LOCAL_FREE_PERMISSION_POLICY_VERSION,
      reasonCode: "reviewed_offline_fixture_requires_user_approval",
      ruleId: LOCAL_FREE_PERMISSION_RULE_IDS.askReviewedFixture,
    });

    const changed = makeAction({
      argv: ["pass.mjs", "changed"],
      canonicalCwd: PHASE6_FIXTURE_CWD,
      logicalExecutable: "node",
    });
    expect(
      localEngine.evaluate(changed, {
        reviewedLocalActionSha256: [action.actionSha256],
      }).effect,
    ).toBe("deny");
  });

  it("asks for an exactly reviewed fixture package test with lifecycle hashes", () => {
    const action = makePackageAction();
    const decision = localEngine.evaluate(action, {
      reviewedLocalActionSha256: new Set([action.actionSha256]),
    });
    expect(decision.effect).toBe("ask");

    const unreviewedScript = makePackageAction({ argv: ["run", "lint"] });
    expect(
      localEngine.evaluate(unreviewedScript, {
        reviewedLocalActionSha256: new Set([unreviewedScript.actionSha256]),
      }).effect,
    ).toBe("deny");
  });

  it("fails closed when a supplied digest is stale or forged", () => {
    const action = makeAction();
    const forged = {
      ...action,
      actionSha256: HASH_A,
    } as CommandActionIdentity;
    const decision = defaultEngine.evaluate(forged);
    expect(decision).toMatchObject({
      effect: "deny",
      reasonCode: "action_digest_mismatch",
    });

    const staleInputs = {
      ...action,
      executionInputsSha256: HASH_B,
    } as CommandActionIdentity;
    expect(defaultEngine.evaluate(staleInputs)).toMatchObject({
      effect: "deny",
      reasonCode: "execution_inputs_digest_mismatch",
    });
  });
});

function makeAction(
  overrides: Partial<NormalizedCommandAction> = {},
): CommandActionIdentity {
  return createCommandActionIdentity({
    ...baseNodeActionInput(),
    ...overrides,
  });
}

function baseNodeActionInput(): NormalizedCommandAction {
  return {
    actionKind: "command",
    argv: ["fixtures/phase-06-command-execution/pass.mjs"],
    binary: {
      bytesSha256: HASH_A,
      canonicalIdentity: "trusted:node:fixture",
      version: "v22.0.0",
    },
    canonicalCwd: ".",
    environmentPolicy: {
      id: "minimum-env",
      variableNames: ["CI", "NO_COLOR", "PATH"],
      version: "1",
    },
    executionInputs: {
      lockfileSha256: null,
      manifestSha256: null,
      runnerConfigHashes: [],
    },
    lifecycleScripts: null,
    logicalExecutable: "node",
    outputLimitBytes: 131_072,
    packageManager: null,
    purpose: "verify",
    timeoutMs: 120_000,
  };
}

function makePackageAction(
  overrides: Partial<NormalizedCommandAction> = {},
): CommandActionIdentity {
  const managerBinary = {
    bytesSha256: HASH_B,
    canonicalIdentity: "trusted:pnpm:fixture",
    version: "11.13.1",
  };
  return createCommandActionIdentity({
    ...baseNodeActionInput(),
    argv: ["test"],
    binary: managerBinary,
    canonicalCwd: PHASE6_FIXTURE_CWD,
    executionInputs: {
      lockfileSha256: HASH_B,
      manifestSha256: HASH_A,
      runnerConfigHashes: [],
    },
    lifecycleScripts: {
      mainBodySha256: HASH_A,
      postBodySha256: null,
      preBodySha256: null,
      scriptName: "test",
    },
    logicalExecutable: "pnpm",
    packageManager: {
      binary: managerBinary,
      logicalName: "pnpm",
      version: "11.13.1",
    },
    ...overrides,
  });
}
