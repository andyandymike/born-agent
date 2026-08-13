import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExactSessionEvidenceReader } from "../../src/control-plane/exact-session-evidence-reader.js";
import { SessionLedgerHeadSigner } from "../../src/control-plane/session-ledger-head.js";
import { SessionPathPolicy } from "../../src/sessions/session-path-policy.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "bornagent-as3-evidence-"));
  temporary.push(workspace);
  const sessionId = randomUUID();
  const goalId = randomUUID();
  const writer = await V2SessionWriter.createNew(workspace, sessionId);
  const event = await writer.appendTaskEvent("goal.created", {
    goal_id: goalId,
    objective: "exact evidence",
    origin: { input_surface: "cli", kind: "user" },
    parent_goal_id: null,
    replaces_active_goal: null,
    revision: 1,
  });
  const path = (await (await SessionPathPolicy.create(workspace)).inspectExistingSession(sessionId)).sessionFilePath;
  return { event, goalId, path, sessionId, workspace, writer };
}

describe("AS3.1 ExactSessionEvidenceReader", () => {
  it("binds one strict raw line reference and opaque head", async () => {
    const value = await fixture();
    const signer = new SessionLedgerHeadSigner(Buffer.alloc(32, 31));
    const evidence = await new ExactSessionEvidenceReader().read(value);
    const rawEventSha256 = value.writer.readDurableEventIdentity(value.event.eventId).rawEventSha256;
    const head = signer.create({
      eventId: value.event.eventId,
      rawEventSha256,
      sequence: 1,
      sessionId: value.sessionId,
    }).publicHead;

    expect(evidence.reference(value.event)).toMatchObject({
      ledgerId: `session:${value.sessionId}`,
      recordId: value.event.eventId,
      recordSha256: rawEventSha256,
    });
    expect(evidence.verifyHead(head, signer)).toBe(true);
    expect(evidence.verifyHead(signer.create({
      eventId: value.event.eventId,
      rawEventSha256: "f".repeat(64),
      sequence: 1,
      sessionId: value.sessionId,
    }).publicHead, signer)).toBe(false);
    await value.writer.close();
  });

  it("rejects invalid UTF-8 duplicate keys and sequence gaps", async () => {
    const invalidUtf8 = await fixture();
    await invalidUtf8.writer.close();
    await writeFile(invalidUtf8.path, Buffer.from([0xff, 0x0a]));
    await expect(new ExactSessionEvidenceReader().read(invalidUtf8)).rejects.toMatchObject({
      code: "control_session_history_missing_or_corrupt",
    });

    const duplicate = await fixture();
    await duplicate.writer.close();
    const duplicateLine = await readFile(duplicate.path, "utf8");
    await writeFile(duplicate.path, duplicateLine.replace(
      '"session_seq":1',
      '"session_seq":1,"session_seq":1',
    ));
    await expect(new ExactSessionEvidenceReader().read(duplicate)).rejects.toMatchObject({
      code: "control_session_history_missing_or_corrupt",
    });

    const gap = await fixture();
    await gap.writer.close();
    const gapLine = await readFile(gap.path, "utf8");
    await writeFile(gap.path, gapLine.replace('"session_seq":1', '"session_seq":2'));
    await expect(new ExactSessionEvidenceReader().read(gap)).rejects.toMatchObject({
      code: "control_session_history_missing_or_corrupt",
    });
  });

  it("rejects a concurrent append instead of mixing snapshots", async () => {
    const value = await fixture();
    const reader = new ExactSessionEvidenceReader({
      afterFirstRead: async () => {
        await value.writer.appendTaskEvent("goal.revised", {
          base_revision: 1,
          goal_id: value.goalId,
          objective: "concurrent append",
          origin: { input_surface: "cli", kind: "user" },
          revision: 2,
        });
      },
    });
    await expect(reader.read(value)).rejects.toMatchObject({ code: "control_operation_busy" });
    await value.writer.close();
  });
});
