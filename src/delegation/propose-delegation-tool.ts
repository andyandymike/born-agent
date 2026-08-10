import { z } from "zod";

import { canonicalJson } from "../completion/canonical-json.js";
import { taskMutationBlocker } from "../coordination/task-control-plane.js";
import { reconstructMultiRunSession } from "../sessions/reconstruct-multi-run-session.js";
import type { V2SessionWriter } from "../sessions/v2-session-writer.js";
import type { ToolDefinition, ToolRawResult } from "../tools/tool-types.js";
import {
  resolveDelegationParentBinding,
  storeDelegationArtifactExact,
} from "./delegation-control-plane.js";
import { DelegationError } from "./delegation-errors.js";
import {
  canonicalDelegationIdentity,
  delegationAuthorityRequestPreviewIdentity,
} from "./delegation-identity.js";
import {
  delegationRevisionContentSchema,
  delegationRevisionDraftSchema,
} from "./delegation-schema.js";

export const proposeDelegationInputSchema = z.object({
  revision: delegationRevisionDraftSchema,
}).strict();

export type ProposeDelegationInputV1 = Readonly<z.infer<typeof proposeDelegationInputSchema>>;

export function createProposeDelegationTool(input: {
  readonly parentRunId: string;
  readonly randomUuid: () => string;
  readonly sessionId: string;
  readonly workspace: string;
  readonly writer: V2SessionWriter;
}): ToolDefinition<ProposeDelegationInputV1> {
  return {
    capability: "mutation",
    description: "Propose one bounded child-agent delegation draft for explicit user review. This never approves, queues, launches, or grants child effect authority.",
    inputSchema: proposeDelegationInputSchema,
    name: "propose_delegation",
    async execute(value, context): Promise<ToolRawResult> {
      try {
        const session = reconstructMultiRunSession(input.writer.events);
        // The registry persists this exact read-before-effect proposal call
        // before invoking the tool. Ignore only that call while retaining every
        // earlier unresolved command, patch, MCP, Hook, or distinct tool call.
        const blocker = taskMutationBlocker(session, {
          ignorePendingToolCall: { callId: context.callId, runId: input.parentRunId },
        });
        if (blocker !== null) {
          throw new DelegationError("delegation_effect_reconciliation_required", "delegation proposal is blocked until current effects are reconciled");
        }
        const binding = resolveDelegationParentBinding(session, input.parentRunId);
        const existing = session.delegations.revisions.filter((revision) =>
          revision.parentActorId === binding.parentActorId && revision.status !== "superseded");
        if (existing.length >= 8) {
          throw new DelegationError("delegation_parallel_limit", "parent already owns the maximum eight delegations");
        }
        if (existing.some((revision) => revision.content.sequence === value.revision.sequence)) {
          throw new DelegationError("delegation_revision_conflict", "delegation sequence is already used by this parent");
        }
        const delegationId = input.randomUuid();
        const identity = canonicalDelegationIdentity({
          ...value.revision,
          binding,
          delegationId,
        });
        const content = delegationRevisionContentSchema.parse(identity.content);
        const authorityPreviewSha256 = delegationAuthorityRequestPreviewIdentity(identity.content);
        const artifact = await storeDelegationArtifactExact(
          input.workspace,
          input.sessionId,
          delegationId,
          Buffer.from(canonicalJson(content), "utf8"),
          identity.delegationSha256,
        );
        await input.writer.appendDelegationEvent("delegation.revision.proposed", {
          artifact,
          authority_preview_sha256: authorityPreviewSha256,
          binding,
          content,
          delegation_id: delegationId,
          delegation_revision: 1,
          delegation_sha256: identity.delegationSha256,
          origin: { input_surface: "tool", kind: "model" },
          parent_actor_id: binding.parentActorId,
          parent_run_id: binding.parentRunId,
        });
        return {
          ok: true,
          truncated: false,
          value: {
            status: "proposed",
            delegationId,
            revision: 1,
            sha256: identity.delegationSha256,
          },
        };
      } catch (error) {
        if (error instanceof DelegationError) {
          return {
            ok: false,
            error: {
              category: error.exitCode === 2 ? "invalid_arguments" : error.exitCode === 7 ? "limit" : "permission",
              code: error.code,
              message: error.message,
              retryable: error.code === "delegation_busy" || error.code === "delegation_lease_busy",
            },
          };
        }
        throw error;
      }
    },
  };
}
