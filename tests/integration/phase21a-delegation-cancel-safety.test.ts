import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { taskMutationBlocker } from "../../src/coordination/task-control-plane.js";
import { canonicalDelegationIdentity, delegationAuthorityRequestPreviewIdentity } from "../../src/delegation/delegation-identity.js";
import { DelegationControlPlane } from "../../src/delegation/delegation-control-plane.js";
import { delegationRevisionContentSchema } from "../../src/delegation/delegation-schema.js";
import { EventPublisher } from "../../src/events/event-publisher.js";
import { SessionCatalog } from "../../src/sessions/session-catalog.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";
import { IDS, phase20Content } from "../phase20-test-helpers.js";
import { testBackendSelected } from "../phase8-event-helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true, maxRetries: 5 })));
});

describe("Phase 21A Delegation cancellation safety reduction", () => {
  it("durably requests cancellation while the exact child tool call is unresolved", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bornagent-phase21a-delegation-cancel-"));
    roots.push(workspace);
    const writer = await V2SessionWriter.createNew(workspace, IDS.session, {
      createEventId: randomUUID,
      timestamp: () => new Date().toISOString(),
    });
    const publisher = new EventPublisher({
      randomUUID,
      renderer: { render: () => undefined },
      runId: IDS.parent,
      sessionId: IDS.session,
      timestamp: () => new Date().toISOString(),
      writer,
    });
    const content = phase20Content();
    const identity = canonicalDelegationIdentity(content);
    try {
      await publisher.publish({
        data: {
          command: "agent",
          edit_approval: "ask",
          input: { role: "user", text: "Run the exact delegated task." },
          max_duration_ms: 60_000,
          max_steps: 4,
          max_tokens: 4_000,
          max_tool_output_bytes: 64 * 1024,
          model: "phase21a-local-fake",
          provider: "ollama",
          request_timeout_ms: 30_000,
          tools: ["apply_patch"],
          tools_enabled: true,
          workspace,
        },
        type: "run.started",
      });
      await publisher.publish(testBackendSelected("ollama", "phase21a-local-fake"));
      await publisher.publish({
        data: {
          input_kind: "user_task",
          max_steps: 4,
          remaining_duration_ms: 60_000,
          remaining_tokens: 4_000,
          remaining_tool_output_bytes: 64 * 1024,
          step: 1,
        },
        type: "agent.step.started",
      });
      await writer.appendDelegationEvent("delegation.revision.proposed", {
        artifact: {
          artifact_id: `sha256:${identity.delegationSha256}`,
          bytes: identity.bytes.length,
          object_ref: `sha256:${identity.delegationSha256}`,
          sha256: identity.delegationSha256,
        },
        authority_preview_sha256: delegationAuthorityRequestPreviewIdentity(content),
        binding: content.binding,
        content: delegationRevisionContentSchema.parse(content),
        delegation_id: content.delegationId,
        delegation_revision: 1,
        delegation_sha256: identity.delegationSha256,
        origin: { input_surface: "cli", kind: "user" },
        parent_actor_id: content.binding.parentActorId,
        parent_run_id: content.binding.parentRunId,
      });
      await publisher.publish({
        data: {
          duration_ms: 1,
          outcome: "tool_call",
          step: 1,
          text_chars: 0,
          tool_call_id: "pending_patch",
        },
        type: "agent.step.completed",
      });
      await publisher.publish({
        data: {
          arguments_json: "{}",
          call_id: "pending_patch",
          step: 1,
          tool_name: "apply_patch",
        },
        type: "tool.call.requested",
      });
    } finally {
      await writer.close();
    }

    const before = await new SessionCatalog(workspace).read(IDS.session);
    expect(taskMutationBlocker(before)).toMatchObject({ details: ["pending_tool_calls=1"] });

    const result = await new DelegationControlPlane().cancel({
      context: {
        inputSurface: "cli",
        now: () => new Date().toISOString(),
        randomUuid: randomUUID,
        sessionId: IDS.session,
        workspace,
      },
      delegationId: IDS.delegation,
      reason: "stop the unresolved exact child effect",
    });

    expect(result.delegation).toMatchObject({
      delegationId: IDS.delegation,
      status: "cancelling",
    });
    const after = await new SessionCatalog(workspace).read(IDS.session);
    expect(after.events.filter((event) => event.type === "delegation.cancel.requested")).toHaveLength(1);
    expect(taskMutationBlocker(after)).toMatchObject({ details: ["pending_tool_calls=1"] });
  });
});
