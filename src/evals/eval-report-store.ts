import { canonicalJson } from "../completion/canonical-json.js";
import { EvalCoreError } from "./eval-errors.js";
import { parseEvalAttemptReport, type EvalAttemptReport } from "./eval-report-schema.js";

export interface AtomicEvalReportPort {
  writeTemp(path: string, bytes: Uint8Array): Promise<void>;
  syncFile(path: string): Promise<void>;
  rename(tempPath: string, finalPath: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
  readAttemptFiles(runId: string): Promise<readonly unknown[]>;
}

function assertSegment(value: string, label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(value)) {
    throw new EvalCoreError("eval_report_corrupt", `${label} is unsafe for report storage`, 1);
  }
}

export class EvalReportStore {
  public constructor(private readonly port: AtomicEvalReportPort) {}

  public async writeAttempt(reportInput: unknown): Promise<string> {
    const report = parseEvalAttemptReport(reportInput);
    assertSegment(report.evalRunId, "eval run ID");
    assertSegment(report.taskId, "task ID");
    const directory = `${report.evalRunId}/attempts/${report.taskId}`;
    const finalPath = `${directory}/r${String(report.repetition)}.json`;
    const tempPath = `${finalPath}.tmp`;
    const bytes = new TextEncoder().encode(`${canonicalJson(report)}\n`);
    // PHASE14: each complete or cancelled partial attempt is synced and renamed atomically so summaries can be rebuilt after interruption.
    await this.port.writeTemp(tempPath, bytes);
    await this.port.syncFile(tempPath);
    await this.port.rename(tempPath, finalPath);
    await this.port.syncDirectory(directory);
    return finalPath;
  }

  public async rebuildAttempts(runId: string): Promise<readonly EvalAttemptReport[]> {
    assertSegment(runId, "eval run ID");
    const reports = (await this.port.readAttemptFiles(runId)).map((input) => parseEvalAttemptReport(input));
    return Object.freeze(
      reports.sort((left, right) => left.taskId.localeCompare(right.taskId) || left.repetition - right.repetition),
    );
  }
}
