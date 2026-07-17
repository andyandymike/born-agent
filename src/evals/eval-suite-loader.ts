import { readFile } from "node:fs/promises";
import path from "node:path";

import { sha256Canonical } from "../completion/canonical-json.js";
import { EvalCoreError } from "./eval-errors.js";
import { readEvalFileTree } from "./eval-file-tree.js";
import { loadProtocolCases } from "./protocol-case-loader.js";
import { EvalServiceRegistry } from "./eval-service-registry.js";
import { loadEvalSuite, type LoadedEvalSuite } from "./eval-suite-schema.js";
import { loadEvalTaskManifest, type LoadedEvalTask } from "./eval-task-schema.js";

const DEFAULT_SERVICE_IMPLEMENTATION_SHA256 = sha256Canonical({
  fixture: "mcp-stdio-search-two-files-v1",
  protocol: "mcp-stdio-fixture-v1",
});

export function createDefaultEvalServiceRegistry(): EvalServiceRegistry {
  return new EvalServiceRegistry([
    {
      ref: "mcp_stdio_fixture",
      fixtureId: "search-two-files-v1",
      registryVersion: 1,
      fixtureVersion: 1,
      supportedModes: ["normal", "crash_before_result", "result_then_exit", "hang_after_start"],
      implementationSha256: DEFAULT_SERVICE_IMPLEMENTATION_SHA256,
    },
  ]);
}

export interface LoadedEvalTaskAsset {
  readonly task: LoadedEvalTask;
  readonly taskRoot: string;
  readonly workspaceRoot: string;
  readonly graderRoot: string;
  readonly graderSha256: string;
}

export interface LoadedEvalAssets {
  readonly root: string;
  readonly suite: LoadedEvalSuite;
  readonly tasks: ReadonlyMap<string, LoadedEvalTaskAsset>;
}

async function readJson(filePath: string, label: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    throw new EvalCoreError("eval_harness_invariant", `${label} is missing`, 1, { cause: error });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new EvalCoreError("eval_harness_invariant", `${label} is not valid JSON`, 1, { cause: error });
  }
}

export async function loadEvalAssets(
  root: string,
  registry: EvalServiceRegistry = createDefaultEvalServiceRegistry(),
): Promise<LoadedEvalAssets> {
  const suite = loadEvalSuite(await readJson(path.join(root, "suite-v1.json"), "eval suite"));
  const tasks = new Map<string, LoadedEvalTaskAsset>();
  for (const reference of suite.suite.tasks) {
    const taskRoot = path.join(root, "tasks", reference.id);
    const workspaceRoot = path.join(taskRoot, "workspace");
    const graderRoot = path.join(taskRoot, "grader");
    const workspace = await readEvalFileTree(workspaceRoot, { rejectGrader: true, rejectPrivate: true });
    const grader = await readEvalFileTree(graderRoot, { rejectPrivate: true });
    const taskInput = await readJson(path.join(taskRoot, "task.json"), `task manifest ${reference.id}`);
    const task = loadEvalTaskManifest(taskInput, registry, workspace.contentSha256);
    if (
      task.manifest.id !== reference.id ||
      task.manifest.task_version !== reference.task_version ||
      task.taskManifestSha256 !== reference.task_manifest_sha256 ||
      workspace.contentSha256 !== reference.initial_workspace_sha256 ||
      grader.contentSha256 !== reference.grader_sha256
    ) {
      throw new EvalCoreError("eval_harness_invariant", `suite reference does not match checked-in task '${reference.id}'`, 1);
    }
    for (const acceptance of task.manifest.acceptance) {
      if (acceptance.kind !== "protocol") continue;
      const inputs = await readJson(path.join(taskRoot, acceptance.inputs_ref), `${reference.id} protocol inputs`);
      const expected = await readJson(path.join(taskRoot, acceptance.expected_ref), `${reference.id} protocol expected`);
      loadProtocolCases(inputs, expected);
    }
    tasks.set(reference.id, Object.freeze({
      task,
      taskRoot,
      workspaceRoot,
      graderRoot,
      graderSha256: grader.contentSha256,
    }));
  }
  return Object.freeze({ root, suite, tasks });
}
