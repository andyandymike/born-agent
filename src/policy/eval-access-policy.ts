import { assertEvalAccess, type EffectiveRuntimePolicy } from "./policy-resolver.js";
import type { EvalSuiteAccess } from "./runtime-policy-schema.js";

export class EvalAccessPolicy {
  constructor(readonly effective: EffectiveRuntimePolicy) {}

  assertPlan(suite: EvalSuiteAccess, attempts: number): void {
    // PHASE15: local suite access is profile data. The built-in profile denies
    // full by default, while remote+full remains a schema-level invariant that
    // no generic boolean can disable.
    assertEvalAccess({ attempts, policy: this.effective, suite });
  }
}
