import { sha256Canonical } from "../completion/canonical-json.js";
import { ApplicationControlError } from "./application-errors.js";
import type {
  ApplicationActionTargetV1,
  ApplicationCommitBindingV1,
  AuthenticatedCallContextV1,
  ExpectedResourceVersionV1,
  PreparedActionV1,
  ResourceScopeV1,
  StrictCodec,
} from "./application-protocol.js";
import type { DurableRecordReferenceV1 } from "./control-operation-schema.js";

export interface ApplicationActionTargetContractV1 {
  readonly acceptedExpectedVersionKinds: readonly ExpectedResourceVersionV1["kind"][];
  readonly resourceKinds: readonly ResourceScopeV1["kind"][];
  readonly targetKind: ApplicationActionTargetV1["kind"];
}

export interface ApplicationAuthorizationDecisionV1 {
  readonly allowed: boolean;
  readonly decisionSha256: string;
  readonly deniedReasons: readonly string[];
  readonly effectiveScopes: readonly string[];
  readonly localPolicySha256: string;
  readonly requiredScopes: readonly string[];
}

export interface ResolvedApplicationTargetV1 {
  readonly resourceScope: ResourceScopeV1;
  readonly resourceVersion: ExpectedResourceVersionV1;
  readonly targetIdentity: unknown;
  readonly targetIdentitySha256: string;
}

export interface ApplicationActionExecutionContextV1 {
  readonly applicationCommit: ApplicationCommitBindingV1;
  readonly authorizationDecisionSha256: string;
  readonly call: AuthenticatedCallContextV1;
  readonly operationId: string;
  readonly requestId: string;
  readonly resolvedTarget: ResolvedApplicationTargetV1;
}

export interface ApplicationActionExecutionResultV1<TResult = unknown> {
  readonly domainRecordRefs: readonly DurableRecordReferenceV1[];
  readonly primaryDomainRecord: DurableRecordReferenceV1 | null;
  readonly resolvedResourceScope: ResourceScopeV1;
  readonly resolvedResourceVersion: ExpectedResourceVersionV1;
  readonly result: TResult;
  readonly underlyingOperationRefs: readonly DurableRecordReferenceV1[];
}

export interface ApplicationActionDefinitionV1<TPayload = unknown, TResult = unknown> {
  readonly actionKind: string;
  readonly confirmation: "explicit_human" | "show_before_commit" | "none";
  readonly effectClass: "control_only" | "runtime_effect" | "external_effect";
  readonly payloadCodec: StrictCodec<TPayload>;
  /**
   * The Host owns the wire result contract just as it owns the payload
   * contract. Results are action-kind-bound and are decoded both before
   * durable publication and on every completed-artifact replay.
   */
  readonly resultCodec: StrictCodec<TResult>;
  readonly requiredPrincipalKind: "human" | "service";
  readonly requiredScopes: readonly string[];
  readonly targetContracts: readonly ApplicationActionTargetContractV1[];
  readonly zeroHeadPolicy: "not_applicable" | "deny" | "create_first_event";
  display(
    resolved: ResolvedApplicationTargetV1,
    payload: TPayload,
  ): Readonly<{ readonly summary: string; readonly warnings: readonly string[] }>;
  execute(
    context: ApplicationActionExecutionContextV1,
    payload: TPayload,
    prepared: PreparedActionV1,
  ): Promise<ApplicationActionExecutionResultV1<TResult>>;
  /**
   * Inspect exact owner facts after dispatch ownership was lost. This port is
   * observation-only: null means the effect remains unknown and must never be
   * retried by the application service.
   */
  reconcile?(
    context: ApplicationActionExecutionContextV1,
    payload: TPayload,
    prepared: PreparedActionV1,
  ): Promise<ApplicationActionExecutionResultV1<TResult> | null>;
  resolveTarget(
    target: ApplicationActionTargetV1,
    payload: TPayload,
  ): Promise<ResolvedApplicationTargetV1>;
}

function targetIdentity(target: ApplicationActionTargetV1): {
  readonly expectedVersionKind: ExpectedResourceVersionV1["kind"];
  readonly resourceKind: ResourceScopeV1["kind"];
  readonly targetKind: ApplicationActionTargetV1["kind"];
} {
  if (target.kind === "existing_resource") {
    return {
      expectedVersionKind: target.expectedVersion.kind,
      resourceKind: target.resourceScope.kind,
      targetKind: target.kind,
    };
  }
  return {
    expectedVersionKind: target.expectedCatalogVersion.kind,
    resourceKind: target.catalogScope.kind,
    targetKind: target.kind,
  };
}

export class ApplicationActionRegistry {
  private readonly definitions: ReadonlyMap<string, ApplicationActionDefinitionV1>;

  constructor(definitions: readonly ApplicationActionDefinitionV1[]) {
    const entries = new Map<string, ApplicationActionDefinitionV1>();
    for (const definition of definitions) {
      if (entries.has(definition.actionKind)) throw new TypeError(`duplicate application action ${definition.actionKind}`);
      if (definition.targetContracts.length === 0 || definition.requiredScopes.length === 0) {
        throw new TypeError(`application action ${definition.actionKind} has an incomplete static contract`);
      }
      if (
        definition.resultCodec === undefined ||
        typeof definition.resultCodec.decodeStrict !== "function" ||
        !Number.isSafeInteger(definition.resultCodec.maximumBytes) ||
        !/^[a-f0-9]{64}$/u.test(definition.resultCodec.schemaSha256)
      ) {
        throw new TypeError(`application action ${definition.actionKind} has no strict result contract`);
      }
      entries.set(definition.actionKind, Object.freeze({
        ...definition,
        requiredScopes: Object.freeze([...definition.requiredScopes]),
        targetContracts: Object.freeze(definition.targetContracts.map((contract) => Object.freeze({
          ...contract,
          acceptedExpectedVersionKinds: Object.freeze([...contract.acceptedExpectedVersionKinds]),
          resourceKinds: Object.freeze([...contract.resourceKinds]),
        }))),
      }));
    }
    this.definitions = entries;
    Object.freeze(this);
  }

  get(actionKind: string): ApplicationActionDefinitionV1 {
    const definition = this.definitions.get(actionKind);
    if (definition === undefined) {
      throw new ApplicationControlError("control_unknown_action", "application action is not registered");
    }
    return definition;
  }

  validateTarget(actionKind: string, target: ApplicationActionTargetV1): ApplicationActionDefinitionV1 {
    const definition = this.get(actionKind);
    const actual = targetIdentity(target);
    const allowed = definition.targetContracts.some(
      (contract) =>
        contract.targetKind === actual.targetKind &&
        contract.resourceKinds.includes(actual.resourceKind) &&
        contract.acceptedExpectedVersionKinds.includes(actual.expectedVersionKind),
    );
    if (!allowed) {
      throw new ApplicationControlError("control_target_invalid", "action target/resource/version matrix is not registered");
    }
    if (
      target.kind === "existing_resource" &&
      target.resourceScope.kind === "session" &&
      target.expectedVersion.kind === "session_ledger_head" &&
      target.expectedVersion.head.sequence === 0 &&
      definition.zeroHeadPolicy === "deny"
    ) {
      throw new ApplicationControlError("control_session_not_started", "action is not allowed before the first session event");
    }
    return definition;
  }

  actionKinds(): readonly string[] {
    return Object.freeze([...this.definitions.keys()].sort());
  }

  identitySha256(): string {
    return sha256Canonical([...this.definitions.values()].map((definition) => ({
      action_kind: definition.actionKind,
      confirmation: definition.confirmation,
      effect_class: definition.effectClass,
      has_action_specific_reconciler: definition.reconcile !== undefined,
      payload_schema_sha256: definition.payloadCodec.schemaSha256,
      result_schema_sha256: definition.resultCodec.schemaSha256,
      required_principal_kind: definition.requiredPrincipalKind,
      required_scopes: definition.requiredScopes,
      target_contracts: definition.targetContracts,
      zero_head_policy: definition.zeroHeadPolicy,
    })));
  }
}

export function createLocalAuthorizationDecision(input: {
  readonly effectiveScopes: readonly string[];
  readonly localPolicySha256: string;
  readonly principalKind: string;
  readonly requiredPrincipalKind: "human" | "service";
  readonly requiredScopes: readonly string[];
}): ApplicationAuthorizationDecisionV1 {
  const deniedReasons = [
    ...(input.principalKind === input.requiredPrincipalKind ? [] : ["principal_kind_mismatch"]),
    ...input.requiredScopes
      .filter((scope) => !input.effectiveScopes.includes(scope))
      .map(() => "required_scope_missing"),
  ];
  const content = {
    allowed: deniedReasons.length === 0,
    deniedReasons: Object.freeze(deniedReasons),
    effectiveScopes: Object.freeze([...input.effectiveScopes].sort()),
    localPolicySha256: input.localPolicySha256,
    requiredScopes: Object.freeze([...input.requiredScopes]),
  };
  return Object.freeze({ ...content, decisionSha256: sha256Canonical(content) });
}
