import { describe, expect, it, vi } from "vitest";

import { PatchApprovalGate } from "../../src/approvals/patch-approval-gate.js";
import type { PatchPlan } from "../../src/changes/patch-types.js";
import { EventPublisher } from "../../src/events/event-publisher.js";
import {
  InMemorySessionWriter,
} from "../helpers.js";

function ids() {
  let value = 0;
  return () =>
    `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
}

const plan: PatchPlan = {
  addedLines: 1,
  files: [
    {
      absolutePath: "C:\\workspace\\src\\math.ts",
      addedLines: 1,
      diff: "diff --git a/src/math.ts b/src/math.ts\n",
      identity: { device: 1, inode: 2, mode: 0o100644 },
      kind: "modify",
      parent: {
        existingAncestorAbsolutePath: "C:\\workspace\\src",
        existingAncestorRealPath: "C:\\workspace\\src",
        missingDirectories: [],
      },
      postimage: Buffer.from("new\n"),
      postimageSha256: "b".repeat(64),
      preimage: Buffer.from("old\n"),
      preimageSha256: "a".repeat(64),
      relativePath: "src/math.ts",
      removedLines: 1,
    },
  ],
  normalizedPatch: "diff --git a/src/math.ts b/src/math.ts\n",
  patchSha256: "c".repeat(64),
  planId: "d".repeat(64),
  preview: "@@ -1 +1 @@\n-old\n+new",
  previewTruncated: false,
  removedLines: 1,
  workspaceRealPath: "C:\\workspace",
};

async function readyPublisher(writer = new InMemorySessionWriter()) {
  const randomUUID = ids();
  const publisher = new EventPublisher({
    randomUUID,
    renderer: { render: () => undefined },
    runId: randomUUID(),
    sessionId: randomUUID(),
    timestamp: () => "2026-07-17T00:00:00.000Z",
    writer,
  });
  await publisher.publish({
    data: {
      command: "agent",
      edit_approval: "ask",
      input: { role: "user", text: "fix math" },
      max_duration_ms: 10_000,
      max_steps: 8,
      max_tokens: 1_000,
      max_tool_output_bytes: 65_536,
      model: "fake",
      provider: "ollama",
      request_timeout_ms: 5_000,
      tools: ["apply_patch"],
      tools_enabled: true,
      workspace: "C:\\workspace",
    },
    type: "run.started",
  });
  await publisher.publish({
    data: {
      input_kind: "user_task",
      max_steps: 8,
      remaining_duration_ms: 10_000,
      remaining_tokens: 1_000,
      remaining_tool_output_bytes: 65_536,
      step: 1,
    },
    type: "agent.step.started",
  });
  await publisher.publish({
    data: {
      input_tokens: 1,
      output_tokens: 1,
      step: 1,
      total_tokens: 2,
    },
    type: "model.usage",
  });
  await publisher.publish({
    data: {
      duration_ms: 1,
      outcome: "tool_call",
      step: 1,
      text_chars: 0,
      tool_call_id: "call_patch",
    },
    type: "agent.step.completed",
  });
  await publisher.publish({
    data: {
      arguments_json: '{"patch":"diff"}',
      call_id: "call_patch",
      step: 1,
      tool_name: "apply_patch",
    },
    type: "tool.call.requested",
  });
  await publisher.publish({
    data: {
      added_lines: 1,
      call_id: "call_patch",
      patch_sha256: plan.patchSha256,
      paths: [{ kind: "modify", path: "src/math.ts" }],
      plan_id: plan.planId,
      preview: plan.preview,
      removed_lines: 1,
      step: 1,
      truncated: false,
    },
    type: "patch.plan.created",
  });
  return { publisher, randomUUID, writer };
}

describe("PatchApprovalGate", () => {
  it("persists request before prompting and decision before returning", async () => {
    const fixture = await readyPublisher();
    const prompt = vi.fn(async () => {
      expect(fixture.writer.events.at(-1)?.type).toBe("approval.requested");
      return "approved" as const;
    });
    const gate = new PatchApprovalGate({
      mode: "ask",
      prompt: { request: prompt },
      publisher: fixture.publisher,
      randomUUID: fixture.randomUUID,
    });
    await expect(
      gate.request(
        { callId: "call_patch", plan, step: 1 },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ decision: "approved" });
    expect(fixture.writer.events.slice(-2).map((event) => event.type)).toEqual([
      "approval.requested",
      "approval.decided",
    ]);
  });

  it("deny mode audits a denial without invoking the prompt", async () => {
    const fixture = await readyPublisher();
    const prompt = vi.fn();
    const gate = new PatchApprovalGate({
      mode: "deny",
      prompt: { request: prompt },
      publisher: fixture.publisher,
      randomUUID: fixture.randomUUID,
    });
    await expect(
      gate.request(
        { callId: "call_patch", plan, step: 1 },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ decision: "denied" });
    expect(prompt).not.toHaveBeenCalled();
    expect(fixture.writer.events.at(-1)).toMatchObject({
      data: { decision: "denied" },
      type: "approval.decided",
    });
  });

  it("never prompts when request persistence fails", async () => {
    const writer = new InMemorySessionWriter("memory://fail", (event) => {
      if (event.type === "approval.requested") throw new Error("disk full");
    });
    const fixture = await readyPublisher(writer);
    const prompt = vi.fn();
    const gate = new PatchApprovalGate({
      mode: "ask",
      prompt: { request: prompt },
      publisher: fixture.publisher,
      randomUUID: fixture.randomUUID,
    });
    await expect(
      gate.request(
        { callId: "call_patch", plan, step: 1 },
        new AbortController().signal,
      ),
    ).rejects.toThrow("session persistence failed");
    expect(prompt).not.toHaveBeenCalled();
  });
});
