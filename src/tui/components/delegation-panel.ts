import type { DelegationProjectionV1, DelegationRevisionProjectionV1 } from "../../delegation/delegation-projector.js";
import type { TuiEphemeralState } from "../tui-ephemeral-state.js";

function currentRows(projection: DelegationProjectionV1): readonly DelegationRevisionProjectionV1[] {
  const latest = new Map<string, DelegationRevisionProjectionV1>();
  for (const revision of projection.revisions) {
    if (revision.status !== "superseded") latest.set(revision.delegationId, revision);
  }
  return [...latest.values()].sort((left, right) =>
    left.content.sequence - right.content.sequence ||
    left.delegationId.localeCompare(right.delegationId, "en"));
}

function model(revision: DelegationRevisionProjectionV1): string {
  return revision.content.model.strategy === "same_as_parent"
    ? "same-as-parent"
    : `${revision.content.model.exactProviderId}/${revision.content.model.exactModelId}`;
}

function marker(revision: DelegationRevisionProjectionV1): string {
  if (["active", "waiting_approval", "cancelling", "reconciling"].includes(revision.status)) return ">>";
  if (revision.status === "accepted") return "OK";
  if (["blocked", "failed", "cancelled", "stale", "rejected"].includes(revision.status)) return "!!";
  return "--";
}

export function renderDelegationPanel(
  projection: DelegationProjectionV1,
  ephemeral: TuiEphemeralState,
): readonly string[] {
  if (projection.trackingMode !== "phase20") return [];
  const rows = currentRows(projection);
  const activeChildren = projection.activeActorSlots.filter((slot) => slot.actorKind === "child").length;
  const header = `DELEGATIONS | ${String(rows.length)} | actors=${String(activeChildren)}/2 | barrier=${projection.barriers.at(-1)?.status ?? "inactive"} | held-attempts=${String(projection.budget.held.attempts)}`;
  if (!ephemeral.delegationPanelOpen) return [header, "[d] open delegation details"];
  const selected = rows.find((row) => row.delegationId === ephemeral.selectedDelegationId) ?? rows[0] ?? null;
  const rowLines = rows.map((row) => {
    const selectedMark = row.delegationId === selected?.delegationId ? "*" : " ";
    const actor = row.attempts.at(-1)?.actorId?.slice(0, 8) ?? "none";
    const workspace = row.content.workspace.managedWorkspaceId?.slice(0, 8) ?? "origin-ro";
    return `${selectedMark}${marker(row)} #${String(row.content.sequence)} ${row.status} ${row.content.title} | actor=${actor} | model=${model(row)} | ws=${workspace} | steps<=${String(row.content.budget.maxModelSteps)} | receipt=${row.receipt?.sha256.slice(0, 10) ?? "none"}`;
  });
  if (selected === null) return [header, ...rowLines, "[d] close delegation details"];
  const tools = selected.content.authorityRequest.toolIds.join(",") || "none";
  const capabilities = selected.content.authorityRequest.capabilityIds.join(",") || "none";
  const paths = selected.content.workspace.declaredPathPrefixes.join(",") || "none";
  const detail = [
    `DELEGATION DETAIL | ${selected.delegationId} r${String(selected.delegationRevision)} sha=${selected.delegationSha256.slice(0, 12)}`,
    `objective: ${selected.content.objective}`,
    `context=${selected.envelope?.contextCapsuleSha256.slice(0, 12) ?? "not-prepared"} envelope=${selected.envelope?.envelopeSha256.slice(0, 12) ?? "not-prepared"}`,
    `tools=${tools} | capabilities=${capabilities}`,
    `paths=${paths} | profile=${selected.content.authorityRequest.taskProfile}`,
    `claims=${selected.content.expectedReceipt.requiredClaims.map((claim) => `${claim.claimId}:${claim.kind}${claim.required ? "!" : ""}`).join(",")}`,
  ];
  const receipt = ephemeral.delegationReceiptOpen
    ? [
        `RECEIPT | ${selected.receipt?.sha256 ?? "none"} | status=${selected.receipt?.status ?? "none"}`,
        `claim-status=${selected.receipt?.claimStatuses.map((claim) => `${claim.claimId}:${claim.status}`).join(",") || "none"}`,
        `blockers=${selected.blockerCodes.join(",") || "none"}`,
      ]
    : [];
  const approval = projection.waitingApprovals.at(-1);
  const modal = approval === undefined
    ? []
    : [
        `CHILD APPROVAL | actor=${approval.childActorId} | request=${approval.approvalRequestId}`,
        `action=${approval.actionKind} digest=${approval.actionDigest} workspace=${approval.workspaceId ?? "origin-read-only"}`,
        "Default deny; approval is bound to this exact child/action identity.",
      ];
  const decision = ephemeral.delegationDecisionDialog;
  const decisionModal = decision === null
    ? []
    : [
        `DELEGATION DECISION | ${decision.action.toUpperCase()} | ${decision.delegationId} r${String(decision.revision)}`,
        `sha256=${decision.sha256} | status=${decision.status}`,
        `${decision.title}: ${decision.objective}`,
        ...(decision.reason === null ? [] : [`reason=${decision.reason}`]),
        "WARNING | Delegation approval does not approve child patches, commands, MCP calls, or completion.",
        ephemeral.delegationDecisionFocus === "confirm" ? "cancel  [CONFIRM]" : "[CANCEL]  confirm (default cancel)",
      ];
  return [header, ...rowLines, ...detail, ...receipt, ...modal, ...decisionModal, "[d] close | [j/k] select | [v] receipt | [s] start/resume | [a/r/c] exact decision"];
}
