import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { EvalCoreError } from "./eval-errors.js";
import { assertCanonicalEvalRelativePath } from "./eval-path.js";
import type { LoadedEvalTaskAsset } from "./eval-suite-loader.js";
import { decodeProtocolObservations, loadProtocolCases } from "./protocol-case-loader.js";
import { canonicalJson } from "../completion/canonical-json.js";

const expectedSchema = z.object({ schema_version: z.literal(1), path: z.string(), utf8: z.string().max(1_048_576) }).strict();

export interface HiddenGradeResult {
  readonly passed: boolean;
  readonly secondaryCodes: readonly string[];
}

export interface EvalHiddenGrader {
  preflight?(): Promise<void>;
  grade(
    task: LoadedEvalTaskAsset,
    workspacePath: string,
    signal?: AbortSignal,
  ): Promise<HiddenGradeResult>;
}

/** Test-only host grader; production eval wiring uses DockerHiddenGrader. */
export class StaticHiddenGrader implements EvalHiddenGrader {
  public async grade(task: LoadedEvalTaskAsset, workspacePath: string): Promise<HiddenGradeResult> {
    const protocol = task.task.manifest.acceptance.find((acceptance) => acceptance.kind === "protocol");
    if (protocol !== undefined) {
      // The in-process fake path emulates the generic worker protocol without executing candidate code; real container plans remain in HiddenGraderRunner.
      const inputs = JSON.parse(await readFile(path.join(task.taskRoot, protocol.inputs_ref), "utf8")) as unknown;
      const expected = JSON.parse(await readFile(path.join(task.taskRoot, protocol.expected_ref), "utf8")) as unknown;
      const cases = loadProtocolCases(inputs, expected);
      const answer = (await readFile(path.join(workspacePath, "answer.txt"), "utf8").catch(() => "")).trimEnd();
      const jsonl = `${cases.caseIds.map((caseId) => JSON.stringify({ case_id: caseId, value: answer })).join("\n")}\n`;
      const observations = decodeProtocolObservations(jsonl, cases.caseIds, { maxFrameBytes: 65_536, maxTotalBytes: 1_048_576 });
      const passed = cases.caseIds.every((caseId) => canonicalJson(observations.get(caseId)) === canonicalJson(cases.expected.get(caseId)));
      return Object.freeze({ passed, secondaryCodes: Object.freeze(passed ? [] : ["hidden_protocol_mismatch"]) });
    }
    // PHASE14: expected bytes are opened only after Agent terminal and never copied into its workspace, context, tool output, or session.
    const expectedInput = JSON.parse(await readFile(path.join(task.graderRoot, "expected.json"), "utf8")) as unknown;
    const parsed = expectedSchema.safeParse(expectedInput);
    if (!parsed.success) throw new EvalCoreError("eval_hidden_grader_invalid", "static grader expectation is corrupt", 1, { cause: parsed.error });
    const relativePath = assertCanonicalEvalRelativePath(parsed.data.path, "static grader path");
    if (relativePath.startsWith("grader/") || relativePath.startsWith(".git/") || relativePath.startsWith(".bornagent/")) throw new EvalCoreError("eval_hidden_grader_invalid", "static grader path is harness-private", 1);
    const actual = await readFile(path.join(workspacePath, ...relativePath.split("/")), "utf8").catch(() => null);
    return Object.freeze({ passed: actual === parsed.data.utf8, secondaryCodes: Object.freeze(actual === parsed.data.utf8 ? [] : ["hidden_static_mismatch"]) });
  }
}
