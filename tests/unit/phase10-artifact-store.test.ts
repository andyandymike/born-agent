import { createHash } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import {
  DEFAULT_ARTIFACT_CAPTURE_BYTES,
  DEFAULT_RUN_ARTIFACT_BYTES,
  DEFAULT_SESSION_ARTIFACT_BYTES,
} from "../../src/artifacts/artifact-types.js";

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const RUN_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_RUN_ID = "20000000-0000-4000-8000-000000000002";
const temporaryDirectories: string[] = [];

async function temporaryWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "bornagent-phase10-artifacts-"));
  temporaryDirectories.push(path);
  return path;
}

async function* chunks(
  ...values: readonly (string | Uint8Array)[]
): AsyncIterable<Uint8Array> {
  for (const value of values) {
    yield typeof value === "string" ? Buffer.from(value, "utf8") : value;
  }
}

function objectPath(workspace: string, sha256: string): string {
  return join(
    workspace,
    ".bornagent",
    "artifacts",
    SESSION_ID,
    "objects",
    sha256,
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

describe("Phase 10 artifact store", () => {
  it("persists intrinsic metadata and verifies the final hash before returning a ref", async () => {
    const workspace = await temporaryWorkspace();
    const store = await ArtifactStore.create({ sessionId: SESSION_ID, workspace });
    const result = await store.storeSanitizedText({
      chunks: chunks("hello ", "世界"),
      runId: RUN_ID,
    });
    const expected = Buffer.from("hello 世界", "utf8");
    const sha256 = createHash("sha256").update(expected).digest("hex");

    expect(store.budgets).toEqual({
      perArtifactBytes: DEFAULT_ARTIFACT_CAPTURE_BYTES,
      perRunBytes: DEFAULT_RUN_ARTIFACT_BYTES,
      perSessionBytes: DEFAULT_SESSION_ARTIFACT_BYTES,
    });
    expect(result).toMatchObject({
      artifact: {
        artifactId: `sha256:${sha256}`,
        bytes: expected.byteLength,
        deduplicated: false,
        objectRef: `artifacts/${SESSION_ID}/objects/${sha256}`,
        sha256,
      },
      captureStatus: "complete",
      captureTruncated: false,
    });
    await expect(store.readVerified(`sha256:${sha256}`)).resolves.toMatchObject({
      bytes: expected,
      metadata: { bytes: expected.byteLength, schema_version: 1, sha256 },
    });

    const metadata = JSON.parse(
      await readFile(`${objectPath(workspace, sha256)}.meta.json`, "utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual([
      "bytes",
      "schema_version",
      "sha256",
    ]);
    expect(JSON.stringify(metadata)).not.toMatch(/origin|media|status|time/iu);
  });

  it("deduplicates concurrent equal content while charging each bounded capture", async () => {
    const workspace = await temporaryWorkspace();
    const store = await ArtifactStore.create({ sessionId: SESSION_ID, workspace });
    const [first, second] = await Promise.all([
      store.storeSanitizedText({ chunks: chunks("same"), runId: RUN_ID }),
      store.storeSanitizedText({ chunks: chunks("same"), runId: RUN_ID }),
    ]);

    expect([first.artifact?.deduplicated, second.artifact?.deduplicated].sort()).toEqual([
      false,
      true,
    ]);
    expect(first.artifact?.artifactId).toBe(second.artifact?.artifactId);
    expect(store.usage()).toEqual({
      runBytes: { [RUN_ID]: 8 },
      sessionBytes: 8,
    });
    const names = await readdir(
      join(workspace, ".bornagent", "artifacts", SESSION_ID, "objects"),
    );
    expect(names.filter((name) => !name.endsWith(".meta.json"))).toHaveLength(1);
    expect(names).toHaveLength(2);
  });

  it("marks artifact, run, session, and exhausted boundaries deterministically", async () => {
    const workspace = await temporaryWorkspace();
    const store = await ArtifactStore.create({
      budgets: { perArtifactBytes: 5, perRunBytes: 8, perSessionBytes: 10 },
      sessionId: SESSION_ID,
      workspace,
    });

    const artifactLimited = await store.storeSanitizedText({
      chunks: chunks("abcdef"),
      maximumBytes: 5,
      runId: RUN_ID,
    });
    expect(artifactLimited).toMatchObject({
      captureStatus: "truncated_artifact_limit",
      captureTruncated: true,
      capturedBytes: 5,
    });

    const runLimited = await store.storeSanitizedText({
      chunks: chunks("wxyz"),
      maximumBytes: 5,
      runId: RUN_ID,
    });
    expect(runLimited).toMatchObject({
      captureStatus: "truncated_run_budget",
      captureTruncated: true,
      capturedBytes: 3,
    });

    const sessionLimited = await store.storeSanitizedText({
      chunks: chunks("1234"),
      maximumBytes: 5,
      runId: OTHER_RUN_ID,
    });
    expect(sessionLimited).toMatchObject({
      captureStatus: "truncated_session_budget",
      captureTruncated: true,
      capturedBytes: 2,
    });

    await expect(
      store.storeSanitizedText({
        chunks: chunks("not-consumed"),
        maximumBytes: 5,
        runId: OTHER_RUN_ID,
      }),
    ).resolves.toEqual({
      artifact: null,
      captureStatus: "budget_exhausted",
      captureTruncated: true,
      capturedBytes: 0,
    });
    expect(store.usage()).toEqual({
      runBytes: { [OTHER_RUN_ID]: 2, [RUN_ID]: 8 },
      sessionBytes: 10,
    });
  });

  it("stops pulling a stream at the cap and never writes a partial UTF-8 code point", async () => {
    const workspace = await temporaryWorkspace();
    const store = await ArtifactStore.create({
      budgets: { perArtifactBytes: 4, perRunBytes: 8, perSessionBytes: 16 },
      sessionId: SESSION_ID,
      workspace,
    });
    let pulls = 0;
    async function* source(): AsyncIterable<Uint8Array> {
      for (const value of ["a", "😀", "never-pulled"]) {
        pulls += 1;
        yield Buffer.from(value, "utf8");
      }
    }

    const result = await store.storeSanitizedText({
      chunks: source(),
      maximumBytes: 4,
      runId: RUN_ID,
    });
    expect(result).toMatchObject({ captureTruncated: true, capturedBytes: 1 });
    expect(pulls).toBe(2);
    const verified = await store.readVerified(result.artifact!.artifactId);
    expect(verified.bytes.toString("utf8")).toBe("a");
  });

  it("cleans a failed temp capture and fails closed for corrupt or missing files", async () => {
    const workspace = await temporaryWorkspace();
    const store = await ArtifactStore.create({ sessionId: SESSION_ID, workspace });
    await expect(
      store.storeSanitizedText({
        chunks: chunks(Uint8Array.from([0xff])),
        runId: RUN_ID,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "artifact_source_invalid_utf8" }),
    );
    const directory = join(
      workspace,
      ".bornagent",
      "artifacts",
      SESSION_ID,
      "objects",
    );
    expect(await readdir(directory)).toEqual([]);

    const corrupt = await store.storeSanitizedText({
      chunks: chunks("integrity"),
      runId: RUN_ID,
    });
    await writeFile(
      objectPath(workspace, corrupt.artifact!.sha256),
      "tampered",
      "utf8",
    );
    await expect(store.readVerified(corrupt.artifact!.artifactId)).rejects.toEqual(
      expect.objectContaining({ code: "artifact_corrupt" }),
    );

    const missing = await store.storeSanitizedText({
      chunks: chunks("missing-meta"),
      runId: OTHER_RUN_ID,
    });
    await rm(`${objectPath(workspace, missing.artifact!.sha256)}.meta.json`);
    await expect(store.readVerified(missing.artifact!.artifactId)).rejects.toEqual(
      expect.objectContaining({ code: "artifact_missing" }),
    );
  });
});
