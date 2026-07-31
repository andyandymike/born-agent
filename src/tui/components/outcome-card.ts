import type { OutcomeReport } from "../../coordination/outcome-report.js";

export function renderOutcomeCard(
  report: OutcomeReport | null,
): readonly string[] {
  if (report === null) return ["OUTCOME | none"];
  return [
    `OUTCOME | ${report.outcome} | changes=${String(report.changes.length)} | verification=${report.verification?.status ?? "none"}`,
    `OUTCOME HASH | ${report.reportSha256}`,
    ...(report.outcomeReasons.length === 0
      ? []
      : [`OUTCOME REASONS | ${report.outcomeReasons.join(", ")}`]),
  ];
}
