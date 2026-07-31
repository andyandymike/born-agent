import type { OutcomeReport } from "./outcome-report.js";

export function renderOutcomeReport(
  report: OutcomeReport,
  format: "json" | "text",
): string {
  if (format === "json") return `${JSON.stringify(report)}\n`;
  const lines = [
    `Outcome: ${report.outcome}`,
    `Outcome report: ${report.reportSha256}`,
    `Goal: ${
      report.goal === null
        ? "none"
        : `${report.goal.status} ${report.goal.id} rev ${String(report.goal.revision)}`
    }`,
    `Plan: ${
      report.plan?.execution === null || report.plan === null
        ? "none"
        : `${report.plan.execution.status} ${report.plan.execution.id} rev ${String(report.plan.execution.revision)} (${String(report.plan.execution.completedItems)}/${String(report.plan.execution.totalItems)} completed)`
    }`,
    `Changes: ${String(report.changes.length)}`,
    `Verification: ${report.verification?.status ?? "none"}`,
    `Reasons: ${report.outcomeReasons.join(", ") || "none"}`,
  ];
  return `${lines.join("\n")}\n`;
}
