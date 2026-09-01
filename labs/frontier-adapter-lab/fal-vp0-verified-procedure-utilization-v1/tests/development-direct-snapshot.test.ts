import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import type { ModelBackend, ModelTurnRequest } from "../../../../src/model/model-backend.js";
import {
  createInjectedDevelopmentDirectExecutor,
} from "../src/development-direct-executor.js";
import { loadDevelopmentDirectFixture } from "../src/development-direct-fixture.js";
import type {
  DevelopmentPilotCase,
  DevelopmentPilotQualificationDescriptor,
} from "../src/development-pilot-fixture.js";
import {
  createDevelopmentPilotAttemptWorkspace,
  verifyDevelopmentPilotAttemptWorkspace,
} from "../src/development-pilot-workspace.js";

const repositoryRoot = process.cwd();
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })));
});

function rawSha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function temporaryRoot(label: string): Promise<string> {
  const root = join(repositoryRoot, ".cache", `${label}-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  temporaryRoots.push(root);
  return root;
}

async function copyPublicCase(caseInput: DevelopmentPilotCase, label: string): Promise<string> {
  const root = await temporaryRoot(label);
  const publicRoot = join(root, "public");
  await cp(caseInput.publicRoot, publicRoot, { errorOnExist: true, recursive: true });
  return publicRoot;
}

async function publicTreeSha256(root: string): Promise<string> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error("test public tree contains a non-file entry");
    }
  };
  await visit(root);
  return sha256Canonical(await Promise.all(files.sort().map(async (path) => ({
    path: relative(root, path).split(sep).join("/"),
    sha256: rawSha256(await readFile(path)),
  }))));
}

const qualification = Object.freeze({
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  provider: "deepseek",
  qualificationCompletedRequestCount: 1,
  qualificationEvidenceKind: "model_capability_probe_suite",
  qualificationEvidenceRef: "qualification/offline-snapshot-test",
  qualificationEvidenceSha256: "a".repeat(64),
  qualificationRequestCount: 1,
  qualificationStatus: "passed",
  qualificationUsageCapability: "complete",
  schemaVersion: 1,
}) satisfies DevelopmentPilotQualificationDescriptor;

function captureBackend(capture: (request: ModelTurnRequest) => void): ModelBackend {
  return {
    capabilities: {
      cancellation: "abort_signal",
      reasoning: "none",
      streaming: true,
      tools: "best_effort",
      usage: "complete",
    },
    identity: {
      adapter: "snapshot-test",
      adapterVersion: "1",
      configFingerprint: "b".repeat(64),
      model: "deepseek-v4-flash",
      provider: "deepseek",
    },
    resume: { capability: "canonical_only", supportsCanonicalDegradedResume: true },
    async *runTurn(request) {
      capture(request);
      yield {
        error: {
          category: "network",
          code: "offline_snapshot_test",
          message: "offline test stop",
          retryable: false,
        },
        type: "failed",
      } as const;
    },
  };
}

describe("development direct copied-snapshot and verifier boundaries", () => {
  it("builds an execute prompt from the copied attempt after the original root changes", async () => {
    const fixture = await loadDevelopmentDirectFixture(repositoryRoot);
    const originalCase = fixture.base.cases[0]!;
    const publicRoot = await copyPublicCase(originalCase, "direct-paid-source");
    const caseInput = Object.freeze({ ...originalCase, publicRoot });
    const attemptRoot = await temporaryRoot("direct-paid-attempt");
    const attempt = await createDevelopmentPilotAttemptWorkspace({
      arm: "baseline",
      attemptRoot,
      case: caseInput,
      fixture: fixture.base,
    });
    const mutation = "MUTATED_ORIGINAL_ROOT_MUST_NOT_REACH_PAID_PROMPT";
    await writeFile(join(publicRoot, "README.md"), `${mutation}\n`, "utf8");

    let capturedRequest: ModelTurnRequest | undefined;
    const executor = createInjectedDevelopmentDirectExecutor(async () =>
      captureBackend((request) => {
        capturedRequest = request;
      }));
    await executor.execute({
      arm: "baseline",
      attempt,
      case: caseInput,
      environment: { DEEPSEEK_API_KEY: "offline-only" },
      fixture,
      qualification,
    });

    expect(capturedRequest?.input.kind).toBe("user_prompt");
    if (capturedRequest?.input.kind !== "user_prompt") {
      throw new Error("offline backend did not capture a user prompt");
    }
    expect(capturedRequest.input.text).not.toContain(mutation);
    expect(capturedRequest.input.text).toContain("README.md");
  }, 30_000);

  it("rejects a copied public tree whose bytes drifted from the loaded case", async () => {
    const fixture = await loadDevelopmentDirectFixture(repositoryRoot);
    const originalCase = fixture.base.cases[0]!;
    const publicRoot = await copyPublicCase(originalCase, "direct-drifted-source");
    await writeFile(join(publicRoot, "README.md"), "drifted before copy\n", "utf8");
    const caseInput = Object.freeze({ ...originalCase, publicRoot });
    const attemptRoot = await temporaryRoot("direct-drifted-attempt");

    await expect(createDevelopmentPilotAttemptWorkspace({
      arm: "baseline",
      attemptRoot,
      case: caseInput,
      fixture: fixture.base,
    })).rejects.toThrow("copied public tree drifted during workspace creation");
  });

  it("keeps provider keys out of both verifier child-process executions", async () => {
    const fixture = await loadDevelopmentDirectFixture(repositoryRoot);
    const originalCase = fixture.base.cases[0]!;
    const publicRoot = await copyPublicCase(originalCase, "direct-verifier-env-source");
    const verifierPath = join(publicRoot, originalCase.verifier.argv[1]);
    const verifier = await readFile(verifierPath, "utf8");
    const keyNames = ["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;
    await writeFile(verifierPath, [
      'import { createHash as verifierCreateHash } from "node:crypto";',
      'import { readFileSync as verifierReadFileSync } from "node:fs";',
      `const verifierKeyNames = ${JSON.stringify(keyNames)};`,
      "const verifierLeaked = verifierKeyNames.some((name) => process.env[name]);",
      "if (verifierLeaked) {",
      `  const bytes = verifierReadFileSync(new URL(${JSON.stringify(`./${originalCase.targetRelativePath}`)}, import.meta.url));`,
      '  const current = verifierCreateHash("sha256").update(bytes).digest("hex");',
      // A leaked key makes the initial verifier falsely pass and the fresh
      // verifier fail. Thus either child-process boundary is observable.
      `  process.exit(current === ${JSON.stringify(originalCase.initialSourceSha256)} ? 0 : 73);`,
      "}",
      verifier,
    ].join("\n"), "utf8");
    const caseInput = Object.freeze({
      ...originalCase,
      publicRoot,
      publicTreeSha256: await publicTreeSha256(publicRoot),
    });
    const attemptRoot = await temporaryRoot("direct-verifier-env-attempt");
    const previous = new Map(keyNames.map((name) => [name, process.env[name]]));
    for (const name of keyNames) process.env[name] = `${name}-sentinel`;
    try {
      const attempt = await createDevelopmentPilotAttemptWorkspace({
        arm: "baseline",
        attemptRoot,
        case: caseInput,
        fixture: fixture.base,
      });
      await writeFile(
        join(attempt.workspace, ...caseInput.targetRelativePath.split("/")),
        caseInput.exactFinalSource,
        "utf8",
      );
      await expect(verifyDevelopmentPilotAttemptWorkspace(caseInput, attempt)).resolves.toMatchObject({
        verifierExitCode: 0,
      });
    } finally {
      for (const name of keyNames) {
        const value = previous.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }, 30_000);
});
