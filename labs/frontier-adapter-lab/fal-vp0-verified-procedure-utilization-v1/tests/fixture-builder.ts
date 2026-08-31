import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import {
  falVp0ProcedureId,
  type FalVp0Procedure,
  type FalVp0SourceBinding,
  type FalVp0SupportRef,
  withFalVp0ProcedureHash,
  withFalVp0SourceBindingHash,
} from "../src/procedure-schema.js";
import { rawSha256 } from "../src/protocol.js";

export const TEST_SUPPORT_TEXT = "check current state then edit and verify";

function digest(label: string): string {
  return sha256Canonical({ label });
}

function lineage(source: "a" | "b") {
  const elements = (kind: string) => [digest(`${source}-${kind}`)];
  const target = elements("target");
  const literal = elements("literal");
  const output = elements("output");
  const convention = elements("convention");
  return {
    comparatorVersion: "fal-vp0-lineage-v1" as const,
    languageSurfaceSha256: digest(`${source}-language`),
    moduleTopologySha256: digest(`${source}-topology`),
    failureMechanismSha256: digest(`${source}-failure`),
    verificationMethodSha256: digest(`${source}-verification`),
    changeSurfaceSha256: digest(`${source}-change`),
    targetSymbolElementSha256s: target,
    literalElementSha256s: literal,
    expectedOutputElementSha256s: output,
    allowedRepositoryConventionElementSha256s: convention,
    targetSymbolSetSha256: sha256Canonical(target),
    literalSetSha256: sha256Canonical(literal),
    expectedOutputSetSha256: sha256Canonical(output),
    allowedRepositoryConventionSetSha256: sha256Canonical(convention),
    solutionShapeSha256: digest(`${source}-shape`),
    goldenDiffSha256: digest(`${source}-golden`),
    derivationArtifacts: [{
      artifactId: `${source}-lineage`,
      kind: "ancestry" as const,
      relativeRef: `source-${source}/lineage.json`,
      rawFileSha256: digest(`${source}-lineage-file`),
    }],
  };
}

export function buildTestSourceBinding(source: "a" | "b"): FalVp0SourceBinding {
  const kinds = [
    "session_range",
    "episode",
    "completion_evidence",
    "run_report",
    "verification",
    "source_state",
  ] as const;
  const supportBytes = new TextEncoder().encode(TEST_SUPPORT_TEXT);
  return withFalVp0SourceBindingHash({
    schemaVersion: 1,
    sourceBindingId: `source-${source}`,
    sourceMode: "public_fixture",
    procedureFamilyId: "family-test",
    scenarioFamilyId: `scenario-${source}`,
    templateLineageId: `template-${source}`,
    solutionShapeId: `solution-${source}`,
    lineageFingerprints: lineage(source),
    scope: {
      ownerPrincipalId: "owner-test",
      applicationRepositoryId: "repository-test",
      canonicalRootIdentitySha256: digest("root"),
    },
    sourceIdentity: {
      sessionId: `session-${source}`,
      runId: `run-${source}`,
    },
    sessionRange: {
      relativeRef: `source-${source}/session.json`,
      startByte: 0,
      endByte: supportBytes.byteLength,
      rawSpanSha256: rawSha256(supportBytes),
    },
    artifacts: kinds.map((kind) => ({
      artifactId: `${source}-${kind.replaceAll("_", "-")}`,
      kind,
      relativeRef: `source-${source}/${kind}.json`,
      bytes: supportBytes.byteLength,
      rawFileSha256: kind === "verification" ? rawSha256(supportBytes) : digest(`${source}-${kind}`),
      logicalSha256: digest(`${source}-${kind}-logical`),
    })),
    episodeRecordId: `episode-${source}`,
    episodeRecordSha256: digest(`${source}-episode-record`),
    taskInputSha256: digest(`${source}-task`),
    completionEvidenceSha256: digest(`${source}-completion`),
    runReportSha256: digest(`${source}-report`),
    finalSourceStateSha256: digest(`${source}-state`),
    relevantVerificationSha256s: [digest(`${source}-verification-result`)],
    redactionProvenance: null,
  });
}

function supportRefs(): [FalVp0SupportRef, FalVp0SupportRef] {
  const bytes = new TextEncoder().encode(TEST_SUPPORT_TEXT);
  return ["a", "b"].map((source): FalVp0SupportRef => ({
    sourceBindingId: `source-${source}`,
    artifactId: `${source}-verification`,
    startByte: 0,
    endByte: bytes.byteLength,
    rawSpanSha256: rawSha256(bytes),
    supportKind: "verification",
  })) as [FalVp0SupportRef, FalVp0SupportRef];
}

function condition(conditionId: string, description: string, factKey: string) {
  return {
    conditionId,
    description,
    predicate: {
      evaluatorVersion: "fal-vp0-host-facts-v1" as const,
      factSource: "case_manifest" as const,
      factKey,
      extractorId: "fixture-extractor-v1",
      extractorSha256: digest("extractor"),
      operator: "exists" as const,
      expected: null,
      missingPolicy: "reject" as const,
    },
    supportRefs: supportRefs(),
  };
}

export function buildTestProcedure(): FalVp0Procedure {
  const left = buildTestSourceBinding("a");
  const right = buildTestSourceBinding("b");
  const guardBase = condition("guard-clean", "Current state is safe.", "state.safe");
  const guard = {
    ...guardBase,
    predicate: {
      ...guardBase.predicate,
      operator: "equals" as const,
      expected: true,
    },
  };
  const negativeBase = condition("negative", "Unsafe state is absent.", "state.unsafe");
  const negative = {
    ...negativeBase,
    predicate: {
      ...negativeBase.predicate,
      operator: "equals" as const,
      expected: true,
    },
  };
  return withFalVp0ProcedureHash({
    schemaVersion: 1,
    experimentId: "fal-vp0-verified-procedure-utilization-v1",
    revision: 1,
    procedureId: falVp0ProcedureId({
      procedureFamilyId: "family-test",
      sourceBindingIds: [left.sourceBindingId, right.sourceBindingId],
    }),
    procedureFamilyId: "family-test",
    origin: "human_frozen_from_verified_sources",
    scope: {
      ownerPrincipalId: "owner-test",
      applicationRepositoryId: "repository-test",
      canonicalRootIdentitySha256: digest("root"),
    },
    compatibility: {
      runtimeFamily: { valueId: "runtime", value: "node", supportRefs: supportRefs() },
      packageManagerFamily: { valueId: "package-manager", value: "pnpm", supportRefs: supportRefs() },
      versionCondition: condition("version", "Runtime version is compatible.", "runtime.version"),
    },
    activationConditions: [condition("activate", "Target state is present.", "target.present")],
    negativeConditions: [negative],
    preconditions: [condition("precondition", "Workspace is ready.", "workspace.ready")],
    guardChecks: [guard],
    orderedGuidance: [
      {
        stepId: "step-one",
        guidance: "Inspect current state.",
        checkpoint: "State recorded.",
        guardConditionIds: [guard.conditionId],
        supportRefs: supportRefs(),
      },
      {
        stepId: "step-two",
        guidance: "Make the bounded edit.",
        checkpoint: "Edit persisted.",
        guardConditionIds: [guard.conditionId],
        supportRefs: supportRefs(),
      },
    ],
    terminationConditions: [condition("terminate", "Fresh verification passes.", "verification.passed")],
    successVerifierExpectation: {
      classifications: ["test"],
      description: "Run the exact fresh verifier.",
      requiresFreshVerifier: true,
      supportRefs: supportRefs(),
    },
    knownExceptions: [],
    rollbackTarget: "baseline_source_evidence_dossier",
    sourceBindings: [left, right],
  });
}

export function testSupportArtifacts() {
  const bytes = new TextEncoder().encode(TEST_SUPPORT_TEXT);
  return ["a", "b"].map((source) => ({
    artifactId: `${source}-verification`,
    bytes,
    providerDisclosureApproved: true,
    sourceBindingId: `source-${source}`,
  }));
}
