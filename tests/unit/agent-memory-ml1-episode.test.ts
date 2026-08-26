import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../../src/completion/canonical-json.js";
import { ExactSessionEvidenceReader } from "../../src/control-plane/exact-session-evidence-reader.js";
import { buildDeterministicMl1Episode } from "../../src/memory/episodes/deterministic-episode-builder.js";
import { inspectMl1MemoryAdmission } from "../../src/memory/episodes/memory-admission.js";

const temporary: string[] = [];
const fixtureRoot = resolve("fixtures/agent-memory/ml1");

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function workspaceWithFixture(sessionId: string, incomplete = false): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "bornagent-ml1-episode-"));
  temporary.push(workspace);
  const target = join(workspace, ".bornagent", "sessions", `${sessionId}.jsonl`);
  await mkdir(dirname(target), { recursive: true });
  if (!incomplete) {
    await copyFile(join(fixtureRoot, "session.jsonl"), target);
  } else {
    const lines = (await readFile(join(fixtureRoot, "session.jsonl"), "utf8")).trimEnd().split("\n");
    await writeFile(target, `${lines.slice(0, -1).join("\n")}\n`, "utf8");
  }
  return workspace;
}

describe("Agent memory ML1 deterministic episode", () => {
  it("ML1 deterministic episode builder matches the frozen verified run golden", async () => {
    const manifest = JSON.parse(await readFile(join(fixtureRoot, "manifest.json"), "utf8")) as {
      readonly expectedCanonicalBytes: number;
      readonly expectedCanonicalJson: string;
      readonly expectedRecord: {
        readonly scope: {
          readonly applicationRepositoryId: string;
          readonly canonicalRootIdentitySha256: string;
          readonly ownerPrincipalId: string;
        };
        readonly source: { readonly runId: string; readonly sessionId: string };
      };
    };
    const workspace = await workspaceWithFixture(manifest.expectedRecord.source.sessionId);
    const evidence = await new ExactSessionEvidenceReader().read({
      sessionId: manifest.expectedRecord.source.sessionId,
      workspace,
    });
    const built = buildDeterministicMl1Episode({
      evidence,
      repositoryId: manifest.expectedRecord.scope.applicationRepositoryId,
      runId: manifest.expectedRecord.source.runId,
      scope: manifest.expectedRecord.scope,
    });
    expect(built.status).toBe("admitted");
    if (built.status !== "admitted") throw new Error("golden episode was not admitted");
    expect(canonicalJson(built.record)).toBe(manifest.expectedCanonicalJson);
    expect(Buffer.byteLength(canonicalJson(built.record), "utf8")).toBe(manifest.expectedCanonicalBytes);

    const incompleteWorkspace = await workspaceWithFixture(manifest.expectedRecord.source.sessionId, true);
    const incompleteEvidence = await new ExactSessionEvidenceReader().read({
      sessionId: manifest.expectedRecord.source.sessionId,
      workspace: incompleteWorkspace,
    });
    expect(() => buildDeterministicMl1Episode({
      evidence: incompleteEvidence,
      repositoryId: manifest.expectedRecord.scope.applicationRepositoryId,
      runId: manifest.expectedRecord.source.runId,
      scope: manifest.expectedRecord.scope,
    })).toThrowError(expect.objectContaining({ code: "memory_episode_not_admitted" }));
  });

  it("rejects known sensitive and explicitly non-persistable episode content before storage", () => {
    for (const [value, reason] of [
      ["-----BEGIN PRIVATE KEY-----\nfixture", "private_key"],
      ["Authorization: Bearer fixture-secret", "known_secret"],
      ["github_pat_abcdefghijklmnopqrstuvwxyz123456", "known_secret"],
      ["A=one\nB=two\nC=three", "raw_environment"],
      ["This result is non-persistable", "non_persistable"],
    ] as const) {
      expect(inspectMl1MemoryAdmission([value])).toEqual({ admitted: false, reason });
    }
    expect(inspectMl1MemoryAdmission(["ordinary bounded task text"])).toEqual({ admitted: true });
  });
});
