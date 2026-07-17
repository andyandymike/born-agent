import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { canonicalJson } from "../completion/canonical-json.js";
import { NodeOllamaLocalCatalogPort } from "../providers/pi/ollama-local-catalog-port.js";
import { AttemptRunner } from "./attempt-runner.js";
import { compareEvalRuns } from "./eval-comparator.js";
import type { EvalCliResult, EvalCliRuntime, EvalRunCliOptions } from "./eval-cli.js";
import { EvalCoreError } from "./eval-errors.js";
import type { EvalExitCode } from "./eval-exit-code.js";
import { InProcessEvalAgentDriver, LocalOllamaEvalAgentDriver, type EvalAgentDriver } from "./eval-agent-driver.js";
import { preflightEvalNoCostPolicy, refuseFullSuiteExecution, type EvalExecutionSource } from "./eval-no-cost-policy.js";
import { NodeEvalReportPort } from "./node-eval-report-port.js";
import { EvalReportStore } from "./eval-report-store.js";
import { evalNoCostEvidenceSchema, parseEvalAttemptReport, type EvalAttemptReport } from "./eval-report-schema.js";
import { loadEvalAssets, type LoadedEvalAssets } from "./eval-suite-loader.js";
import { selectEvalTaskIds } from "./eval-suite-schema.js";
import { buildEvalRunSummary, parseEvalRunSummary, renderEvalSummary, summaryAsComparable, type EvalRunSummary } from "./eval-summary.js";
import type { EvalHiddenGrader } from "./static-hidden-grader.js";
import { DockerHiddenGrader } from "./docker-hidden-grader.js";

export interface NodeEvalRuntimeOptions {
  readonly workspace: string;
  readonly assetsRoot?: string;
  readonly timestamp?: () => string;
  readonly randomUUID?: () => string;
  readonly onCancel?: (listener: () => void) => () => void;
  readonly ollamaCatalog?: NodeOllamaLocalCatalogPort;
  readonly version?: string;
  readonly nodeVersion?: string;
  readonly platform?: NodeJS.Platform;
  readonly hiddenGrader?: EvalHiddenGrader;
  readonly graderImage?: string;
  readonly dockerEnvironment?: Readonly<Record<string, string | undefined>>;
}

function parseRepetitions(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10) {
    throw new EvalCoreError("eval_cli_invalid", "repetitions must be an integer from 1 to 10", 2);
  }
  return parsed;
}

function safeRunId(timestamp: string, uuid: string): string {
  return `eval-${timestamp.replace(/[^0-9]/gu, "").slice(0, 14)}-${uuid.replace(/-/gu, "").slice(-12)}`;
}

function asErrorResult(error: unknown): EvalCliResult {
  if (error instanceof EvalCoreError) return Object.freeze({ exitCode: error.exitCode, stderr: `${error.code}: ${error.message}\n` });
  return Object.freeze({ exitCode: 1, stderr: "eval_harness_invariant: internal eval harness error\n" });
}

function jsonLine(value: unknown): string {
  return `${canonicalJson(value)}\n`;
}

const interruptedRunManifestSchema = z.object({
  schemaVersion: z.literal(1),
  evalRunId: z.string(),
  selectedTaskIds: z.array(z.string()),
  repetitions: z.number().int().min(1).max(10),
  provider: z.string(),
  model: z.string(),
  suiteKind: z.enum(["smoke", "full", "targeted"]),
  noCostEvidence: evalNoCostEvidenceSchema,
  startedAt: z.string(),
  fullSuiteExecution: z.literal("not_run_by_policy"),
}).passthrough();

function renderList(assets: LoadedEvalAssets): string {
  const smoke = new Set(assets.suite.suite.smoke_task_ids);
  return [
    `Suite: ${assets.suite.suite.id} v${String(assets.suite.suite.suite_version)} (${String(assets.tasks.size)} tasks)`,
    ...assets.suite.suite.tasks.map((reference) => {
      const task = assets.tasks.get(reference.id);
      return `${smoke.has(reference.id) ? "smoke" : "full "}  ${reference.id}  v${String(reference.task_version)}  ${task?.task.manifest.category ?? "unknown"}`;
    }),
    "Full execution: forbidden by zero-paid-provider-v1 (planning only)",
    "",
  ].join("\n");
}

function comparisonText(baselineId: string, candidateId: string, comparison: ReturnType<typeof compareEvalRuns>): string {
  return [
    `Eval comparison: ${baselineId} -> ${candidateId}`,
    `Compatible: ${String(comparison.compatible)}`,
    `Config differences: ${comparison.configDiff.length === 0 ? "none" : comparison.configDiff.join(", ")}`,
    `Incompatibilities: ${comparison.incompatibilities.length === 0 ? "none" : comparison.incompatibilities.join(", ")}`,
    `Regressions: ${comparison.regressions.length === 0 ? "none" : comparison.regressions.join(", ")}`,
    `Statistical claim: null (${comparison.limitation})`,
    "",
  ].join("\n");
}

export class NodeEvalRuntime implements EvalCliRuntime {
  readonly #assetsRoot: string;
  readonly #reports: NodeEvalReportPort;
  readonly #timestamp: () => string;
  readonly #randomUUID: () => string;
  readonly #onCancel: (listener: () => void) => () => void;
  readonly #ollamaCatalog: NodeOllamaLocalCatalogPort;

  public constructor(private readonly options: NodeEvalRuntimeOptions) {
    this.#assetsRoot = options.assetsRoot ?? path.join(options.workspace, "evals");
    this.#reports = new NodeEvalReportPort(path.join(options.workspace, ".bornagent", "evals"));
    this.#timestamp = options.timestamp ?? (() => new Date().toISOString());
    this.#randomUUID = options.randomUUID ?? randomUUID;
    this.#onCancel = options.onCancel ?? (() => () => undefined);
    this.#ollamaCatalog = options.ollamaCatalog ?? new NodeOllamaLocalCatalogPort();
  }

  private async assets(): Promise<LoadedEvalAssets> {
    return loadEvalAssets(this.#assetsRoot);
  }

  private hiddenGrader(): EvalHiddenGrader {
    if (this.options.hiddenGrader !== undefined) return this.options.hiddenGrader;
    if (this.options.graderImage === undefined) {
      throw new EvalCoreError(
        "eval_cli_invalid",
        "targeted/smoke eval requires a configured digest-pinned local grader image",
        2,
      );
    }
    return new DockerHiddenGrader({
      ...(this.options.dockerEnvironment === undefined
        ? {}
        : { environment: this.options.dockerEnvironment }),
      image: this.options.graderImage,
      randomUUID: this.#randomUUID,
    });
  }

  private async source(options: EvalRunCliOptions): Promise<EvalExecutionSource> {
    const provider = options.provider.trim().toLowerCase();
    if (provider === "fake" || provider === "mock") return Object.freeze({ kind: "in_process_test", provider });
    if (provider !== "ollama") {
      preflightEvalNoCostPolicy({ kind: "forbidden_remote", provider });
      throw new EvalCoreError("eval_no_cost_source_forbidden", "remote eval provider is forbidden", 2);
    }
    const endpoint = options.ollamaEndpoint ?? "http://127.0.0.1:11434";
    const catalog = await this.#ollamaCatalog.refresh({ baseURL: endpoint, timeoutMs: 2_500 }).catch((error: unknown) => {
      throw new EvalCoreError("eval_no_cost_source_forbidden", "local Ollama preflight failed; no pull or fallback was attempted", 2, { cause: error });
    });
    const installed = catalog.find((entry) => entry.tag === options.model);
    if (installed === undefined || (options.ollamaModelDigest !== undefined && installed.digest !== options.ollamaModelDigest)) {
      throw new EvalCoreError("eval_no_cost_source_forbidden", "the exact Ollama model tag/digest is not already installed", 2);
    }
    return Object.freeze({ kind: "local_ollama", provider: "ollama", endpoint, installedModelTag: installed.tag, installedModelDigest: installed.digest });
  }

  private fullPlanningSource(options: EvalRunCliOptions): EvalExecutionSource {
    const provider = options.provider.trim().toLowerCase();
    if (provider === "fake" || provider === "mock") {
      return Object.freeze({ kind: "in_process_test", provider });
    }
    if (provider !== "ollama") {
      preflightEvalNoCostPolicy({ kind: "forbidden_remote", provider });
      throw new EvalCoreError(
        "eval_no_cost_source_forbidden",
        "remote eval provider is forbidden",
        2,
      );
    }
    // PHASE14: a forbidden full plan validates only the literal-loopback shape.
    // It must not refresh Ollama, inspect/pull a model, or manufacture an
    // attempt merely to refuse execution.
    return Object.freeze({
      endpoint: options.ollamaEndpoint ?? "http://127.0.0.1:11434",
      installedModelDigest:
        options.ollamaModelDigest ?? `sha256:${"0".repeat(64)}`,
      installedModelTag: options.model,
      kind: "local_ollama",
      provider: "ollama",
    });
  }

  public async list(options: { readonly json: boolean }): Promise<EvalCliResult> {
    try {
      const assets = await this.assets();
      const document = {
        schemaVersion: 1,
        suite: { id: assets.suite.suite.id, version: assets.suite.suite.suite_version, sha256: assets.suite.suiteSha256 },
        smokeTaskIds: assets.suite.suite.smoke_task_ids,
        fullTaskIds: assets.suite.suite.full_task_ids,
        fullSuiteExecution: "not_run_by_policy",
        tasks: assets.suite.suite.tasks.map((reference) => ({ id: reference.id, version: reference.task_version, category: assets.tasks.get(reference.id)?.task.manifest.category ?? null })),
      };
      return Object.freeze({ exitCode: 0, stdout: options.json ? jsonLine(document) : renderList(assets) });
    } catch (error) { return asErrorResult(error); }
  }

  public async run(options: EvalRunCliOptions): Promise<EvalCliResult> {
    try {
      const assets = await this.assets();
      if (options.suite !== "smoke" && options.suite !== "full") throw new EvalCoreError("eval_cli_invalid", "suite must be smoke or full", 2);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u.test(options.provider) || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,511}$/u.test(options.model)) throw new EvalCoreError("eval_cli_invalid", "provider/model identity is malformed", 2);
      if (options.suite === "full" && options.task !== undefined) throw new EvalCoreError("eval_full_suite_forbidden", "--suite full cannot be narrowed with --task", 2);
      const source =
        options.suite === "full"
          ? this.fullPlanningSource(options)
          : await this.source(options);
      const guard = preflightEvalNoCostPolicy(source);
      const suiteTaskIds = selectEvalTaskIds(assets.suite, options.suite);
      const selectedTaskIds = options.task === undefined ? suiteTaskIds : [options.task];
      if (selectedTaskIds.some((id) => !assets.tasks.has(id))) throw new EvalCoreError("eval_cli_invalid", "requested eval task is not checked in", 2);
      const suiteKind = options.task === undefined ? options.suite : "targeted";
      const repetitions = parseRepetitions(options.repetitions, options.suite === "smoke" ? assets.suite.suite.repetition_policy.smoke_default : assets.suite.suite.repetition_policy.full_default);
      const startedAt = this.#timestamp();
      const evalRunId = safeRunId(startedAt, this.#randomUUID());
      await mkdir(path.join(this.#reports.root, evalRunId), { recursive: true });
      const runManifest = {
        schemaVersion: 1,
        evalRunId,
        suiteId: assets.suite.suite.id,
        suiteVersion: assets.suite.suite.suite_version,
        suiteSha256: assets.suite.suiteSha256,
        selectedTaskIds,
        repetitions,
        suiteKind,
        provider: options.provider,
        model: options.model,
        sourceSha256: guard.sourceSha256,
        executionSource: source.kind === "local_ollama"
          ? { kind: source.kind, provider: source.provider, installedModelTag: source.installedModelTag, installedModelDigest: source.installedModelDigest, endpointScope: "literal_loopback", adapter: "ollama-direct-loopback-v1" }
          : { kind: source.kind, provider: source.provider, fixtureVersion: 1, endpointScope: "none", adapter: "in-process-eval-v1" },
        noCostEvidence: guard.evidence,
        fullSuiteExecution: "not_run_by_policy",
        startedAt,
        bornAgentVersion: this.options.version ?? "unknown",
        nodeVersion: this.options.nodeVersion ?? process.versions.node,
        platform: this.options.platform ?? process.platform,
        reportSchemaVersion: 1,
        tasks: selectedTaskIds.map((id) => {
          const asset = assets.tasks.get(id);
          const reference = assets.suite.suite.tasks.find((candidate) => candidate.id === id);
          if (asset === undefined || reference === undefined) throw new EvalCoreError("eval_harness_invariant", `missing run manifest task ${id}`, 1);
          return {
            id,
            taskVersion: reference.task_version,
            taskManifestSha256: reference.task_manifest_sha256,
            workspaceSha256: reference.initial_workspace_sha256,
            graderSha256: reference.grader_sha256,
            scenarioSha256: asset.task.scenario.scenarioSha256,
            scenarioConfigSha256: asset.task.scenario.scenarioConfigSha256,
            serviceSetSha256: asset.task.scenario.serviceSetSha256,
          };
        }),
      };
      await this.#reports.writeJson(`${evalRunId}/run-manifest.json`, runManifest);

      if (options.suite === "full") {
        const refusal = refuseFullSuiteExecution(selectedTaskIds, source);
        const summary = buildEvalRunSummary({ assets, evalRunId, suiteKind: "full", selectedTaskIds, attempts: [], repetitions, provider: options.provider, model: options.model, noCostEvidence: refusal.noCostEvidence, startedAt, completedAt: this.#timestamp(), exitCode: 2, status: "config_error" });
        await this.persistSummary(summary);
        return Object.freeze({ exitCode: 2, stdout: options.json ? jsonLine(summary) : renderEvalSummary(summary), stderr: "full_suite_forbidden_by_policy: planned 20 tasks; started 0 attempts and sent 0 provider requests\n" });
      }

      const controller = new AbortController();
      const stopCancel = this.#onCancel(() => controller.abort());
      const reports = new EvalReportStore(this.#reports);
      const driver: EvalAgentDriver = source.kind === "in_process_test" ? new InProcessEvalAgentDriver() : new LocalOllamaEvalAgentDriver();
      const grader = this.hiddenGrader();
      await grader.preflight?.();
      const runner = new AttemptRunner(reports, driver, grader);
      const attempts: EvalAttemptReport[] = [];
      try {
        for (const taskId of selectedTaskIds) {
          const task = assets.tasks.get(taskId);
          if (task === undefined) throw new EvalCoreError("eval_harness_invariant", `selected task disappeared: ${taskId}`, 1);
          for (let repetition = 1; repetition <= repetitions; repetition += 1) {
            if (controller.signal.aborted) break;
            attempts.push(await runner.run({ evalRunId, repetition, task, attemptRoot: path.join(this.#reports.root, evalRunId, "attempts", taskId, `r${String(repetition)}`), source, guard, model: options.model, signal: controller.signal }));
          }
          if (controller.signal.aborted) break;
        }
      } finally { stopCancel(); }
      const persistedAttempts = [...await reports.rebuildAttempts(evalRunId)];
      const exitCode: EvalExitCode = controller.signal.aborted ? 130 : persistedAttempts.some((attempt) => attempt.status === "harness_invalid") ? 1 : persistedAttempts.some((attempt) => attempt.outcome?.taskPassed !== true) ? 9 : 0;
      const status = exitCode === 130 ? "cancelled" : exitCode === 1 ? "harness_invalid" : "complete";
      const summary = buildEvalRunSummary({ assets, evalRunId, suiteKind, selectedTaskIds, attempts: persistedAttempts, repetitions, provider: options.provider, model: options.model, noCostEvidence: guard.evidence, startedAt, completedAt: this.#timestamp(), exitCode, status });
      await this.persistSummary(summary);
      return Object.freeze({ exitCode, stdout: options.json ? jsonLine(summary) : renderEvalSummary(summary) });
    } catch (error) { return asErrorResult(error); }
  }

  private async persistSummary(summary: EvalRunSummary): Promise<void> {
    await this.#reports.writeJson(`${summary.evalRunId}/summary.json`, summary);
    await this.#reports.writeText(`${summary.evalRunId}/report.md`, renderEvalSummary(summary));
  }

  public async show(options: { readonly runId: string; readonly attempt?: string; readonly json: boolean }): Promise<EvalCliResult> {
    try {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(options.runId)) throw new EvalCoreError("eval_cli_invalid", "unsafe eval run ID", 2);
      if (options.attempt !== undefined) {
        const match = /^([a-z0-9][a-z0-9-]{0,63}):r([1-9][0-9]*)$/u.exec(options.attempt);
        if (match?.[1] === undefined || match[2] === undefined) throw new EvalCoreError("eval_cli_invalid", "attempt must be task-id:rN", 2);
        const report = parseEvalAttemptReport(await this.#reports.readJson(`${options.runId}/attempts/${match[1]}/r${match[2]}.json`));
        return Object.freeze({ exitCode: report.status === "harness_invalid" ? 1 : report.outcome?.taskPassed === true ? 0 : 9, stdout: jsonLine(report) });
      }
      let summary: EvalRunSummary;
      try {
        summary = parseEvalRunSummary(await this.#reports.readJson(`${options.runId}/summary.json`));
      } catch {
        const manifest = interruptedRunManifestSchema.parse(await this.#reports.readJson(`${options.runId}/run-manifest.json`));
        const assets = await this.assets();
        const attempts = await new EvalReportStore(this.#reports).rebuildAttempts(options.runId);
        summary = buildEvalRunSummary({
          assets,
          evalRunId: manifest.evalRunId,
          suiteKind: manifest.suiteKind,
          selectedTaskIds: manifest.selectedTaskIds,
          attempts,
          repetitions: manifest.repetitions,
          provider: manifest.provider,
          model: manifest.model,
          noCostEvidence: manifest.noCostEvidence,
          startedAt: manifest.startedAt,
          completedAt: this.#timestamp(),
          exitCode: 1,
          status: "partial",
        });
      }
      return Object.freeze({ exitCode: summary.exitCode, stdout: options.json ? jsonLine(summary) : renderEvalSummary(summary) });
    } catch (error) { return asErrorResult(error); }
  }

  public async compare(options: { readonly baselineId: string; readonly candidateId: string; readonly json: boolean }): Promise<EvalCliResult> {
    try {
      const baseline = parseEvalRunSummary(await this.#reports.readJson(`${options.baselineId}/summary.json`));
      const candidate = parseEvalRunSummary(await this.#reports.readJson(`${options.candidateId}/summary.json`));
      const comparison = compareEvalRuns(summaryAsComparable(baseline), summaryAsComparable(candidate));
      return Object.freeze({ exitCode: comparison.exitCode, stdout: options.json ? jsonLine(comparison) : comparisonText(options.baselineId, options.candidateId, comparison) });
    } catch (error) { return asErrorResult(error); }
  }
}
