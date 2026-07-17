import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";
import { EvalCoreError } from "./eval-errors.js";
import {
  assertCanonicalEvalPrefix,
  assertCanonicalEvalRelativePath,
  assertWorkspaceCwd,
  decideEvalChangedPath,
  type EvalPathDecision,
} from "./eval-path.js";
import { loadEvalScenario, evalScenarioSchema, type LoadedEvalScenario } from "./eval-scenario-schema.js";
import type { EvalServiceRegistry } from "./eval-service-registry.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u);
const boundedArgSchema = z.string().max(8_192).refine((value) => !value.includes("\0") && !/[\r\n]/u.test(value));
const executableSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_./-]+$/u)
  .refine((value) => !["sh", "bash", "cmd", "cmd.exe", "powershell", "pwsh"].includes(value.toLowerCase()));

export const evalAgentCommandSchema = z
  .object({
    executable: executableSchema,
    args: z.array(boundedArgSchema).max(128),
    cwd: z.string().min(1).max(1_024),
  })
  .strict();

const graderCommandSchema = z
  .object({
    executable: executableSchema,
    args: z.array(boundedArgSchema).max(128),
    cwd: z.string().min(1).max(1_024),
    timeout_ms: z.number().int().positive().max(600_000),
    expected_exit: z.number().int().min(0).max(255),
  })
  .strict();

const protocolAcceptanceSchema = z
  .object({
    id: idSchema,
    kind: z.literal("protocol"),
    inputs_ref: z.string().min(1).max(1_024),
    expected_ref: z.string().min(1).max(1_024),
    worker: z
      .object({
        adapter: z.literal("node-module-call-v1"),
        entry: z.string().min(1).max(1_024),
        timeout_ms: z.number().int().positive().max(600_000),
      })
      .strict(),
    grader: graderCommandSchema,
  })
  .strict();

const staticAcceptanceSchema = z
  .object({
    id: idSchema,
    kind: z.literal("static"),
    grader: graderCommandSchema,
  })
  .strict();

const changeRulesSchema = z
  .object({
    exact: z.array(z.string().min(1).max(1_024)).max(512),
    prefixes: z.array(z.string().min(2).max(1_024)).max(512),
    max_files: z.number().int().positive().max(10_000),
    max_changed_lines: z.number().int().nonnegative().max(10_000_000),
  })
  .strict();

const forbiddenRulesSchema = z
  .object({
    exact: z.array(z.string().min(1).max(1_024)).max(512),
    prefixes: z.array(z.string().min(2).max(1_024)).max(512),
  })
  .strict();

export const evalTaskManifestSchema = z
  .object({
    schema_version: z.literal(1),
    id: idSchema,
    task_version: z.number().int().positive(),
    category: idSchema,
    prompt: z.string().min(1).max(100_000),
    initial_workspace_sha256: sha256Schema,
    scenario: evalScenarioSchema,
    allowed_changes: changeRulesSchema,
    forbidden_changes: forbiddenRulesSchema,
    agent_commands: z.array(evalAgentCommandSchema).max(64),
    acceptance: z
      .array(z.discriminatedUnion("kind", [protocolAcceptanceSchema, staticAcceptanceSchema]))
      .min(1)
      .max(32),
    limits: z
      .object({
        agent_duration_ms: z.number().int().positive().max(3_600_000),
        grader_duration_ms: z.number().int().positive().max(600_000),
      })
      .strict(),
  })
  .strict();

export type EvalTaskManifest = z.infer<typeof evalTaskManifestSchema>;
export type EvalAgentCommand = z.infer<typeof evalAgentCommandSchema>;

export interface LoadedEvalTask {
  readonly manifest: EvalTaskManifest;
  readonly taskManifestSha256: string;
  readonly scenario: LoadedEvalScenario;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new EvalCoreError("eval_manifest_invalid", `${label} contains duplicate values`, 1);
  }
}

function assertGraderCwd(cwd: string): void {
  if (cwd !== "/grader") {
    throw new EvalCoreError("eval_manifest_invalid", "grader cwd must be exactly /grader", 1);
  }
}

function validateManifestSemantics(manifest: EvalTaskManifest): void {
  const exactGroups = [manifest.allowed_changes.exact, manifest.forbidden_changes.exact];
  const prefixGroups = [manifest.allowed_changes.prefixes, manifest.forbidden_changes.prefixes];
  for (const [index, group] of exactGroups.entries()) {
    for (const path of group) {
      assertCanonicalEvalRelativePath(path, index === 0 ? "allowed exact path" : "forbidden exact path");
    }
    assertUnique(group, "exact path list");
  }
  for (const [index, group] of prefixGroups.entries()) {
    for (const prefix of group) {
      assertCanonicalEvalPrefix(prefix, index === 0 ? "allowed prefix" : "forbidden prefix");
    }
    assertUnique(group, "path prefix list");
  }
  for (const command of manifest.agent_commands) {
    assertWorkspaceCwd(command.cwd);
  }
  const acceptanceIds = manifest.acceptance.map((acceptance) => acceptance.id);
  assertUnique(acceptanceIds, "acceptance IDs");
  // PHASE14: hidden grader commands and expectations stay in a host-only bundle, never in the Agent workspace or context.
  for (const acceptance of manifest.acceptance) {
    assertGraderCwd(acceptance.grader.cwd);
    if (!acceptance.grader.args.every((arg) => !arg.includes("/workspace"))) {
      throw new EvalCoreError("eval_manifest_invalid", "grader command cannot receive the candidate workspace path", 1);
    }
    if (acceptance.kind === "protocol") {
      // PHASE14: protocol inputs and expected values are host-only, joined by validated case IDs and bounded framing rather than array position.
      const inputRef = assertCanonicalEvalRelativePath(acceptance.inputs_ref, "protocol inputs_ref");
      const expectedRef = assertCanonicalEvalRelativePath(acceptance.expected_ref, "protocol expected_ref");
      if (!inputRef.startsWith("grader/") || !expectedRef.startsWith("grader/") || inputRef === expectedRef) {
        throw new EvalCoreError(
          "eval_manifest_invalid",
          "protocol inputs and expected references must be distinct host-only grader paths",
          1,
        );
      }
      assertCanonicalEvalRelativePath(acceptance.worker.entry, "protocol worker entry");
      if (acceptance.worker.entry.startsWith("grader/")) {
        throw new EvalCoreError("eval_manifest_invalid", "protocol worker entry cannot point into grader bytes", 1);
      }
    }
  }
}

export function loadEvalTaskManifest(
  input: unknown,
  serviceRegistry: EvalServiceRegistry,
  computedInitialWorkspaceSha256?: string,
): LoadedEvalTask {
  const parsed = evalTaskManifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new EvalCoreError("eval_manifest_invalid", "invalid eval task manifest schema", 1, { cause: parsed.error });
  }
  validateManifestSemantics(parsed.data);
  if (
    computedInitialWorkspaceSha256 !== undefined &&
    parsed.data.initial_workspace_sha256 !== computedInitialWorkspaceSha256
  ) {
    throw new EvalCoreError("eval_harness_invariant", "initial workspace digest does not match task manifest", 1);
  }
  return Object.freeze({
    manifest: Object.freeze(parsed.data),
    taskManifestSha256: sha256Canonical(parsed.data),
    scenario: loadEvalScenario(parsed.data.scenario, serviceRegistry),
  });
}

export function matchesEvalAgentCommand(
  configured: readonly EvalAgentCommand[],
  candidate: EvalAgentCommand,
): boolean {
  // PHASE14: eval auto-approval is meaningful only for byte-exact commands inside a disposable attempt; this matcher grants no normal CLI authority.
  return configured.some(
    (command) =>
      command.executable === candidate.executable &&
      command.cwd === candidate.cwd &&
      command.args.length === candidate.args.length &&
      command.args.every((arg, index) => arg === candidate.args[index]),
  );
}

export function decideTaskChangedPath(manifest: EvalTaskManifest, path: string): EvalPathDecision {
  return decideEvalChangedPath(path, {
    allowedExact: manifest.allowed_changes.exact,
    allowedPrefixes: manifest.allowed_changes.prefixes,
    forbiddenExact: manifest.forbidden_changes.exact,
    forbiddenPrefixes: manifest.forbidden_changes.prefixes,
  });
}
