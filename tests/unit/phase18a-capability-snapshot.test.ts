import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  capabilitySnapshotSchema,
  createCapabilitySnapshot,
} from "../../src/capabilities/capability-snapshot.js";
import { runEventSchema } from "../../src/events/run-event-schema.js";
import {
  createTestCapabilityRoots,
  writeTestCapabilityPackage,
  writeTestSourceIndex,
} from "../phase18a-test-helpers.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("Phase 18A frozen capability snapshot", () => {
  it("has a canonical timestamp-independent identity and includes enabled packages only", async () => {
    const base = await mkdtemp(join(tmpdir(), "bornagent-phase18a-snapshot-"));
    temporary.push(base);
    const roots = await createTestCapabilityRoots(base);
    const enabled = await writeTestCapabilityPackage(join(roots.userRoot, "enabled"));
    const disabled = await writeTestCapabilityPackage(join(roots.userRoot, "disabled"), {
      pluginId: "acme.disabled",
    });
    await writeTestSourceIndex(join(roots.userRoot, "enablement.json"), 9, [
      { enabled: false, package: disabled, path: "disabled" },
      { enabled: true, package: enabled, path: "enabled" },
    ]);
    const catalog = (await roots.platform.buildRegistry()).catalog;
    const first = await createCapabilitySnapshot({
      catalog,
      platform: process.platform,
      timestamp: "2026-08-08T00:00:00.000Z",
      workspace: roots.workspace,
    });
    const second = await createCapabilitySnapshot({
      catalog,
      platform: process.platform,
      timestamp: "2026-08-08T01:00:00.000Z",
      workspace: roots.workspace,
    });

    expect(second.snapshotId).toBe(first.snapshotId);
    expect(second.snapshotSha256).toBe(first.snapshotSha256);
    expect(second.createdAt).not.toBe(first.createdAt);
    expect(first.plugins).toHaveLength(1);
    expect(first.plugins[0]).toMatchObject({
      enabled: true,
      pluginId: enabled.pluginId,
      pluginSha256: enabled.pluginSha256,
    });
    expect(capabilitySnapshotSchema.parse(first)).toEqual(first);
    expect(() =>
      capabilitySnapshotSchema.parse({
        ...first,
        snapshotSha256: "0".repeat(64),
      }),
    ).toThrow(/identity/u);
  });

  it("keeps the capability binding optional for old strict session events", () => {
    const event = runEventSchema.parse({
      data: {
        command: "chat",
        input: { role: "user", text: "legacy" },
        model: "qwen3:1.7b",
        provider: "ollama",
        timeout_ms: 1000,
        workspace: "D:\\legacy",
      },
      event_id: "11111111-1111-4111-8111-111111111111",
      run_id: "22222222-2222-4222-8222-222222222222",
      schema_version: 1,
      seq: 1,
      session_id: "33333333-3333-4333-8333-333333333333",
      timestamp: "2026-08-08T00:00:00.000Z",
      type: "run.started",
    });
    if (event.type !== "run.started") throw new TypeError("expected run.started");
    expect(event.data.capability_snapshot).toBeUndefined();
  });
});
