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
    `Capabilities: ${
      report.capabilities === null
        ? "legacy-none"
        : `${report.capabilities.eligiblePluginCount} plugins / ${report.capabilities.componentCount} components (${report.capabilities.snapshotId.slice(0, 28)}...)`
    }`,
    `Verification: ${report.verification?.status ?? "none"}`,
    `Repository: ${
      report.repository === null
        ? "none"
        : `${report.repository.coverage} ${report.repository.finalGenerationSha256} (outline=${String(report.repository.queries.outline)}, symbol=${String(report.repository.queries.symbol)}, references=${String(report.repository.queries.references)})`
    }`,
    `Skills: ${String(report.skills.activations.length)} activations / ${String(report.skills.resourceReadCount)} resource reads`,
    `Hooks: ${String(report.hooks.counts.matched)} matched / ${String(report.hooks.counts.executed)} executed / ${String(report.hooks.counts.denied)} denied / ${String(report.hooks.counts.degraded)} degraded`,
    `MCP primitives: ${String(report.mcp.servers.length)} servers / ${String(report.mcp.resourceReads.length)} resource reads / ${String(report.mcp.promptGets.length)} prompts`,
    `Reasons: ${report.outcomeReasons.join(", ") || "none"}`,
  ];
  return `${lines.join("\n")}\n`;
}
