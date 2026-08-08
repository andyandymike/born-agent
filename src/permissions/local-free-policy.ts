import { evaluateHardDeny } from "./default-policy.js";
import type {
  CommandActionIdentity,
  NormalizedAction,
  PermissionContext,
  PermissionPolicy,
  PolicyDecision,
  Sha256Hex,
} from "./permission-types.js";

export const LOCAL_FREE_PERMISSION_POLICY_ID =
  "bornagent.local-free-only-command-policy";
export const LOCAL_FREE_PERMISSION_POLICY_VERSION = "3";
export const PHASE6_FIXTURE_CWD = "fixtures/phase-06-command-execution";
export const PHASE7_FIXTURE_CWDS = Object.freeze([
  "fixtures/phase-07-fix-and-verify",
  "fixtures/phase-07-verification-fails",
]);

export const LOCAL_FREE_PERMISSION_RULE_IDS = Object.freeze({
  askDockerSandbox: "local-free.ask.docker-sandbox-command.v1",
  askReviewedFixture: "local-free.ask.reviewed-phase6-fixture.v1",
  askReviewedMcpCall: "local-free.ask.reviewed-offline-mcp-call.v1",
  askReviewedMcpPrimitive: "local-free.ask.reviewed-offline-mcp-primitive.v1",
  askReviewedMcpStart: "local-free.ask.reviewed-offline-mcp-start.v1",
  askFrozenCapabilityMcpStart: "local-free.ask.frozen-capability-mcp-start.v1",
  denyUnreviewedMcp: "local-free.deny.unreviewed-mcp.v1",
  denyUnreviewedAction: "local-free.deny.unreviewed-action.v1",
  denyUnsupportedShape: "local-free.deny.unsupported-command-shape.v1",
} as const);

export const localFreeOnlyPermissionPolicy: PermissionPolicy = Object.freeze({
  id: LOCAL_FREE_PERMISSION_POLICY_ID,
  version: LOCAL_FREE_PERMISSION_POLICY_VERSION,
  evaluate(
    action: NormalizedAction,
    context: PermissionContext,
  ): PolicyDecision {
    if (action.actionKind === "mcp.server.start") {
      const reviewed = contains(context.reviewedOfflineMcpActionSha256, action.actionSha256);
      const frozenCapability = contains(
        context.frozenCapabilityMcpActionSha256,
        action.actionSha256,
      );
      if (!reviewed && !frozenCapability) {
        return {
          effect: "deny",
          reasonCode: "mcp_start_not_in_reviewed_offline_set",
          ruleId: LOCAL_FREE_PERMISSION_RULE_IDS.denyUnreviewedMcp,
        };
      }
      return {
        effect: "ask",
        reasonCode: frozenCapability
          ? "frozen_capability_mcp_start_requires_user_approval"
          : "reviewed_offline_mcp_start_requires_user_approval",
        ruleId: frozenCapability
          ? LOCAL_FREE_PERMISSION_RULE_IDS.askFrozenCapabilityMcpStart
          : LOCAL_FREE_PERMISSION_RULE_IDS.askReviewedMcpStart,
      };
    }
    if (
      action.actionKind === "mcp.tool.call" ||
      action.actionKind === "mcp.resource.read" ||
      action.actionKind === "mcp.prompt.get"
    ) {
      if (
        !contains(context.reviewedOfflineMcpServerIds, action.serverId) &&
        !contains(context.startedMcpServerIds, action.serverId)
      ) {
        return {
          effect: "deny",
          reasonCode: "mcp_server_not_reviewed_offline",
          ruleId: LOCAL_FREE_PERMISSION_RULE_IDS.denyUnreviewedMcp,
        };
      }
      // PHASE12: catalog discovery and server annotations do not grant call
      // authority. Every exact, locally validated argument digest remains ask.
      return {
        effect: "ask",
        reasonCode: action.actionKind === "mcp.tool.call"
          ? "reviewed_offline_mcp_call_requires_user_approval"
          : "reviewed_offline_mcp_primitive_requires_user_approval",
        ruleId: action.actionKind === "mcp.tool.call"
          ? LOCAL_FREE_PERMISSION_RULE_IDS.askReviewedMcpCall
          : LOCAL_FREE_PERMISSION_RULE_IDS.askReviewedMcpPrimitive,
      };
    }
    const hardDeny = evaluateHardDeny(action);
    if (hardDeny !== null) {
      return hardDeny;
    }

    if (action.executionEnvironment?.executor === "docker") {
      // PHASE13: Permission still authorizes one exact command; Docker is the
      // separate isolation boundary. This rule only admits a digest-pinned,
      // network-none action whose snapshot/image/resources are already hashed.
      return {
        effect: "ask",
        reasonCode: "offline_docker_sandbox_command_requires_user_approval",
        ruleId: LOCAL_FREE_PERMISSION_RULE_IDS.askDockerSandbox,
      };
    }

    if (!isPhase6ReviewedFixtureShape(action)) {
      return {
        effect: "deny",
        reasonCode: "local_free_only_unsupported_command",
        ruleId: LOCAL_FREE_PERMISSION_RULE_IDS.denyUnsupportedShape,
      };
    }

    if (!containsReviewedDigest(context, action.actionSha256)) {
      return {
        effect: "deny",
        reasonCode: "fixture_action_not_in_trusted_review_set",
        ruleId: LOCAL_FREE_PERMISSION_RULE_IDS.denyUnreviewedAction,
      };
    }

    // PHASE6: An argv review cannot prove what repository code will do transitively.
    // The local-free gate therefore asks only for content-bound, pre-reviewed offline
    // fixtures; a user click alone must never authorize an arbitrary or billable script.
    return {
      effect: "ask",
      reasonCode: "reviewed_offline_fixture_requires_user_approval",
      ruleId: LOCAL_FREE_PERMISSION_RULE_IDS.askReviewedFixture,
    };
  },
});

export function isPhase6ReviewedFixtureShape(
  action: CommandActionIdentity,
): boolean {
  if (isFixtureNodeCommand(action)) {
    return true;
  }
  return isFixturePackageTestCommand(action);
}

function isFixtureNodeCommand(action: CommandActionIdentity): boolean {
  if (
    action.logicalExecutable !== "node" ||
    action.argv.length === 0 ||
    action.packageManager !== null ||
    action.lifecycleScripts !== null
  ) {
    return false;
  }

  const script = action.argv[0];
  if (script === undefined || script.startsWith("-")) {
    return false;
  }
  const normalizedScript = script.replaceAll("\\", "/");
  const supportedExtension = /\.(?:cjs|js|mjs)$/u.test(normalizedScript);
  if (!supportedExtension || normalizedScript.includes("../")) {
    return false;
  }

  if (action.canonicalCwd === PHASE6_FIXTURE_CWD) {
    return !normalizedScript.startsWith("/");
  }
  if (PHASE7_FIXTURE_CWDS.includes(action.canonicalCwd)) {
    return normalizedScript === "verify.mjs";
  }
  return (
    action.canonicalCwd === "." &&
    normalizedScript.startsWith(`${PHASE6_FIXTURE_CWD}/`)
  );
}

function isFixturePackageTestCommand(
  action: CommandActionIdentity,
): boolean {
  if (
    action.canonicalCwd !== PHASE6_FIXTURE_CWD ||
    action.packageManager === null ||
    action.lifecycleScripts === null ||
    action.lifecycleScripts.scriptName !== "test" ||
    action.executionInputs.manifestSha256 === null
  ) {
    return false;
  }

  const executable = action.logicalExecutable;
  if (executable === "pnpm" || executable === "npm") {
    return (
      action.packageManager.logicalName === executable &&
      (arraysEqual(action.argv, ["test"]) ||
        arraysEqual(action.argv, ["run", "test"]))
    );
  }

  if (executable !== "corepack") {
    return false;
  }
  const manager = action.packageManager.logicalName;
  return (
    (manager === "pnpm" || manager === "npm") &&
    (arraysEqual(action.argv, [manager, "test"]) ||
      arraysEqual(action.argv, [manager, "run", "test"]))
  );
}

function containsReviewedDigest(
  context: PermissionContext,
  actionSha256: Sha256Hex,
): boolean {
  const reviewed = context.reviewedLocalActionSha256;
  if (reviewed === undefined) {
    return false;
  }
  if (Array.isArray(reviewed)) {
    return reviewed.includes(actionSha256);
  }
  return (reviewed as ReadonlySet<Sha256Hex>).has(actionSha256);
}

function contains<T>(
  values: ReadonlySet<T> | readonly T[] | undefined,
  value: T,
): boolean {
  if (values === undefined) return false;
  return Array.isArray(values)
    ? values.includes(value)
    : (values as ReadonlySet<T>).has(value);
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
