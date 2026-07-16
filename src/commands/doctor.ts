import type { CliIO } from "../cli/types.js";
import { runDoctor } from "../doctor/run-doctor.js";
import type { DoctorReport, DoctorRuntime } from "../doctor/types.js";

export function formatDoctorReport(report: DoctorReport): string {
  const lines = report.checks.map(
    (check) => `[${check.ok ? "ok" : "fail"}] ${check.name}: ${check.detail}`,
  );
  lines.push(
    "",
    `Doctor: ${report.passed} passed, ${report.failed} failed`,
  );
  return `${lines.join("\n")}\n`;
}

export async function executeDoctor(
  runtime: DoctorRuntime,
  io: CliIO,
): Promise<number> {
  const report = await runDoctor(runtime);
  io.stdout.write(formatDoctorReport(report));
  return report.ok ? 0 : 3;
}

