import type { CliIO, CliRuntime } from "../cli/types.js";
import {
  resolveDockerSandboxConfig,
  type DockerSandboxConfigInput,
} from "../agent/agent-config.js";
import type { DockerSandboxDoctorReport } from "../execution/docker/docker-doctor.js";

function formatReport(report: DockerSandboxDoctorReport): string {
  const lines = report.checks.map(
    (check) => `[${check.ok ? "ok" : "fail"}] ${check.name}: ${check.detail}`,
  );
  lines.push("", `Docker sandbox doctor: ${report.passed} passed, ${report.failed} failed`);
  return `${lines.join("\n")}\n`;
}

export async function executeSandboxDoctor(
  options: DockerSandboxConfigInput,
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  const resolved = resolveDockerSandboxConfig(options, runtime.env);
  if (!resolved.ok) {
    io.stderr.write(`Configuration error: ${resolved.error}\n`);
    return 2;
  }
  if (runtime.runDockerSandboxDoctor === undefined) {
    io.stderr.write("Configuration error: Docker sandbox doctor is unavailable in this runtime\n");
    return 2;
  }
  const report = await runtime.runDockerSandboxDoctor(resolved.value);
  io.stdout.write(formatReport(report));
  return report.ok ? 0 : 3;
}
