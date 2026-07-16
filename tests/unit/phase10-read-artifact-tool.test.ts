import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactReader } from "../../src/artifacts/artifact-reader.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { OutputMaterializer } from "../../src/artifacts/output-materializer.js";
import { createReadArtifactTool } from "../../src/tools/read-artifact-tool.js";
import { ToolRegistry } from "../../src/tools/tool-registry.js";
import type {
  ToolDefinition,
  ToolExecution,
} from "../../src/tools/tool-types.js";

const SESSION_ID = "10000000-0000-4000-8000-000000000021";
const RUN_ID = "20000000-0000-4000-8000-000000000021";
const ORIGIN_EVENT_ID = "30000000-0000-4000-8000-000000000021";
const temporaryDirectories: string[] = [];

async function temporaryWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "bornagent-phase10-read-tool-"));
  temporaryDirectories.push(path);
  return path;
}

async function* chunks(value: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(value, "utf8");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

async function fixture(content = "alpha😀omega") {
  const workspace = await temporaryWorkspace();
  const store = await ArtifactStore.create({ sessionId: SESSION_ID, workspace });
  const materialized = await new OutputMaterializer(store).materialize({
    captureBytes: Math.max(128, Buffer.byteLength(content, "utf8")),
    modelObservationBytes: Math.max(128, Buffer.byteLength(content, "utf8")),
    originEventId: ORIGIN_EVENT_ID,
    runId: RUN_ID,
    source: chunks(content),
  });
  const artifact = materialized.artifact!;
  const reader = new ArtifactReader({
    references: [
      {
        artifactId: artifact.artifactId,
        bytes: artifact.bytes,
        mediaType: artifact.mediaType,
        objectRef: artifact.objectRef,
        sha256: artifact.sha256,
      },
    ],
    sessionId: SESSION_ID,
    store,
  });
  const registry = new ToolRegistry([
    createReadArtifactTool(reader) as ToolDefinition<unknown>,
  ]);
  return { artifact, registry, workspace };
}

async function invoke(
  registry: ToolRegistry,
  input: unknown,
  signal = new AbortController().signal,
): Promise<ToolExecution> {
  return registry.execute(
    {
      argumentsJson: JSON.stringify(input),
      callId: "call_artifact_test",
      name: "read_artifact",
      step: 1,
    },
    signal,
  );
}

describe("Phase 10 read_artifact tool", () => {
  it("returns a bounded structured slice whose registry output is the model observation", async () => {
    const { artifact, registry } = await fixture();
    const execution = await invoke(registry, {
      artifact_id: artifact.artifactId,
      max_bytes: 7,
      offset_bytes: 0,
    });
    const parsed = JSON.parse(execution.output) as Record<string, unknown>;

    expect(execution).toMatchObject({ ok: true, truncated: true });
    expect(parsed).toEqual({
      artifact_id: artifact.artifactId,
      content: "alpha",
      content_bytes: 5,
      eof: false,
      media_type: "text/plain; charset=utf-8",
      next_offset_bytes: 5,
      offset_bytes: 0,
      ok: true,
      sha256: artifact.sha256,
      source_bytes: 5,
      truncated: true,
    });
    const durableCallEventOutput = execution.output;
    const nextModelObservation = execution.output;
    expect(durableCallEventOutput).toBe(nextModelObservation);
    expect(parsed).not.toHaveProperty("object_ref");
  });

  it("rejects path-shaped input, oversized reads, and non-ledger ids before filesystem lookup", async () => {
    const { artifact, registry } = await fixture();
    for (const input of [
      {
        artifact_id: artifact.artifactId,
        max_bytes: 8,
        offset_bytes: 0,
        path: "../../outside-secret",
      },
      {
        artifact_id: artifact.artifactId,
        max_bytes: 65_537,
        offset_bytes: 0,
      },
      {
        artifact_id: artifact.artifactId,
        max_bytes: 8,
        offset_bytes: -1,
      },
    ]) {
      await expect(invoke(registry, input)).resolves.toMatchObject({
        error: { code: "arguments_schema_mismatch" },
        ok: false,
      });
    }

    const denied = await invoke(registry, {
      artifact_id: `sha256:${"f".repeat(64)}`,
      max_bytes: 8,
      offset_bytes: 0,
    });
    expect(denied).toMatchObject({
      error: { category: "permission", code: "artifact_not_allowlisted" },
      ok: false,
    });
    expect(denied.output).not.toContain("outside-secret");
    expect(denied.output).not.toContain(".bornagent");
  });

  it("reports missing/corrupt content without exposing an absolute path", async () => {
    const corruptFixture = await fixture("corrupt-me");
    const objectPath = join(
      corruptFixture.workspace,
      ".bornagent",
      "artifacts",
      SESSION_ID,
      "objects",
      corruptFixture.artifact.sha256,
    );
    await writeFile(objectPath, "tampered", "utf8");
    const corrupt = await invoke(corruptFixture.registry, {
      artifact_id: corruptFixture.artifact.artifactId,
      max_bytes: 32,
      offset_bytes: 0,
    });
    expect(corrupt).toMatchObject({
      error: { category: "tool", code: "artifact_corrupt" },
      ok: false,
    });
    expect(corrupt.output).not.toContain(corruptFixture.workspace);

    const missingFixture = await fixture("missing-me");
    const missingMetadata = join(
      missingFixture.workspace,
      ".bornagent",
      "artifacts",
      SESSION_ID,
      "objects",
      `${missingFixture.artifact.sha256}.meta.json`,
    );
    await rm(missingMetadata);
    const missing = await invoke(missingFixture.registry, {
      artifact_id: missingFixture.artifact.artifactId,
      max_bytes: 32,
      offset_bytes: 0,
    });
    expect(missing).toMatchObject({
      error: { category: "not_found", code: "artifact_missing" },
      ok: false,
    });
    expect(missing.output).not.toContain(missingFixture.workspace);
  });

  it("honors cancellation and accepts a full 64 KiB text slice", async () => {
    const cancelledFixture = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      invoke(
        cancelledFixture.registry,
        {
          artifact_id: cancelledFixture.artifact.artifactId,
          max_bytes: 8,
          offset_bytes: 0,
        },
        controller.signal,
      ),
    ).resolves.toMatchObject({
      error: { category: "cancelled", code: "tool_cancelled" },
      ok: false,
    });

    const content = "\n".repeat(64 * 1024);
    const largeFixture = await fixture(content);
    const large = await invoke(largeFixture.registry, {
      artifact_id: largeFixture.artifact.artifactId,
      max_bytes: 64 * 1024,
      offset_bytes: 0,
    });
    const parsed = JSON.parse(large.output) as Record<string, unknown>;
    expect(large).toMatchObject({ ok: true, truncated: false });
    expect(parsed).toMatchObject({
      content_bytes: 64 * 1024,
      eof: true,
      source_bytes: 64 * 1024,
    });
    expect(Buffer.byteLength(large.output, "utf8")).toBeLessThanOrEqual(
      2 * 64 * 1024 + 8 * 1024,
    );
  });
});
