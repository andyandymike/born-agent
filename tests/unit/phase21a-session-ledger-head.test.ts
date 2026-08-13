import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ActiveWriterSessionLedgerHeadPort,
  InactiveSessionLedgerHeadPort,
  SessionLedgerHeadSigner,
} from "../../src/control-plane/session-ledger-head.js";
import { V2SessionWriter } from "../../src/sessions/v2-session-writer.js";

const temporary: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bornagent-phase21a-head-"));
  temporary.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Phase 21A durable session ledger head", () => {
  it("publishes an opaque head only after the raw envelope is durable", async () => {
    const root = await workspace();
    const sessionId = randomUUID();
    const signer = new SessionLedgerHeadSigner(Buffer.alloc(32, 17));
    const writer = await V2SessionWriter.createNew(root, sessionId);
    const port = new ActiveWriterSessionLedgerHeadPort(signer, writer);
    expect(await port.readStorageHead(sessionId)).toMatchObject({
      publicHead: { eventId: null, eventIntegrityToken: null, sequence: 0, sessionId },
      rawEventSha256: null,
    });
    const event = await writer.appendTaskEvent("goal.created", {
      goal_id: randomUUID(),
      objective: "continue",
      origin: { input_surface: "cli", kind: "user" },
      parent_goal_id: null,
      replaces_active_goal: null,
      revision: 1,
    });
    const active = await port.readStorageHead(sessionId);
    expect(active.publicHead).toMatchObject({ eventId: event.eventId, sequence: 1, sessionId });
    expect(active.publicHead.eventIntegrityToken).toMatch(/^slh_v1_/u);
    expect(active.publicHead.eventIntegrityToken).not.toContain(active.rawEventSha256!);
    expect(signer.verify(active.publicHead, active.rawEventSha256)).toBe(true);
    await writer.close();

    const inactive = await new InactiveSessionLedgerHeadPort(signer, root).readStorageHead(sessionId);
    expect(inactive).toEqual(active);
  });

  it("does not accept another key or a candidate raw hash", () => {
    const sessionId = randomUUID();
    const identity = {
      eventId: randomUUID(),
      rawEventSha256: "a".repeat(64),
      sequence: 1,
      sessionId,
    };
    const head = new SessionLedgerHeadSigner(Buffer.alloc(32, 1)).create(identity);
    expect(new SessionLedgerHeadSigner(Buffer.alloc(32, 2)).verify(head.publicHead, identity.rawEventSha256)).toBe(false);
    expect(new SessionLedgerHeadSigner(Buffer.alloc(32, 1)).verify(head.publicHead, "b".repeat(64))).toBe(false);
  });
});
