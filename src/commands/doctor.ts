import type { CliIO } from "../cli/types.js";
import {
  runDoctor,
  type DoctorPolicyOptions,
} from "../doctor/run-doctor.js";
import type { DoctorReport, DoctorRuntime } from "../doctor/types.js";
import { RuntimePolicyError } from "../policy/policy-errors.js";

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
  options: DoctorPolicyOptions = {},
): Promise<number> {
  try {
    const report = await runDoctor(runtime, options);
    io.stdout.write(formatDoctorReport(report));
    return report.ok ? 0 : 3;
  } catch (error) {
    if (error instanceof RuntimePolicyError) {
      io.stderr.write(`${error.code}: ${error.message}\n`);
      return error.exitCode;
    }
    io.stderr.write("runtime policy internal error\n");
    return 1;
  }
}
