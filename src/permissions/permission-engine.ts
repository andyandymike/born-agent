import {
  createCommandActionIdentity,
} from "./action-digest.js";
import type {
  CommandActionIdentity,
  PermissionContext,
  PermissionDecision,
  PermissionEngineLike,
  PermissionPolicy,
  PolicyDecision,
} from "./permission-types.js";

export const PERMISSION_ENGINE_RULE_IDS = Object.freeze({
  denyActionDigestMismatch: "permission.deny.action-digest-mismatch.v1",
  denyExecutionInputsDigestMismatch:
    "permission.deny.execution-inputs-digest-mismatch.v1",
  denyInvalidAction: "permission.deny.invalid-action.v1",
} as const);

export class PermissionEngine implements PermissionEngineLike {
  readonly #policy: PermissionPolicy;

  constructor(policy: PermissionPolicy) {
    assertIdentifier(policy.id, "policy.id");
    assertIdentifier(policy.version, "policy.version");
    this.#policy = policy;
  }

  evaluate(
    action: CommandActionIdentity,
    context: PermissionContext = {},
  ): PermissionDecision {
    let verified: CommandActionIdentity;
    try {
      verified = createCommandActionIdentity(action);
    } catch {
      return this.#deny(
        PERMISSION_ENGINE_RULE_IDS.denyInvalidAction,
        "invalid_action_identity",
      );
    }

    if (verified.executionInputsSha256 !== action.executionInputsSha256) {
      return this.#deny(
        PERMISSION_ENGINE_RULE_IDS.denyExecutionInputsDigestMismatch,
        "execution_inputs_digest_mismatch",
      );
    }
    if (verified.actionSha256 !== action.actionSha256) {
      return this.#deny(
        PERMISSION_ENGINE_RULE_IDS.denyActionDigestMismatch,
        "action_digest_mismatch",
      );
    }

    // PHASE6: This policy decision is an application-level consent boundary, not
    // an OS sandbox. Even an allowed argv-only child retains the current user's
    // host capabilities, so policy evaluation must stay fail closed and auditable.
    const policyDecision = this.#policy.evaluate(verified, context);
    return this.#decorate(policyDecision);
  }

  #decorate(decision: PolicyDecision): PermissionDecision {
    assertIdentifier(decision.ruleId, "policy decision ruleId");
    if (decision.effect === "allow") {
      return Object.freeze({
        effect: "allow",
        policyId: this.#policy.id,
        policyVersion: this.#policy.version,
        ruleId: decision.ruleId,
      });
    }

    assertIdentifier(decision.reasonCode, "policy decision reasonCode");
    return Object.freeze({
      effect: decision.effect,
      policyId: this.#policy.id,
      policyVersion: this.#policy.version,
      reasonCode: decision.reasonCode,
      ruleId: decision.ruleId,
    });
  }

  #deny(ruleId: string, reasonCode: string): PermissionDecision {
    return Object.freeze({
      effect: "deny",
      policyId: this.#policy.id,
      policyVersion: this.#policy.version,
      reasonCode,
      ruleId,
    });
  }
}

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || /[\r\n\0]/u.test(value)) {
    throw new TypeError(`${label} must be a non-empty single-line string`);
  }
}
