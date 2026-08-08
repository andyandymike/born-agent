import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { RepositoryRulesArtifactInput, RepositoryRulesArtifactPort } from "../../src/repository-rules/root-agents-loader.js";
import type { RepositoryRulesArtifactReference } from "../../src/repository-rules/repository-rule-set.js";

export const PHASE17_SHA = "a".repeat(64);
export const phase17TemporaryDirectories: string[] = [];

export async function phase17RulesWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bornagent-phase17b-rules-"));
  phase17TemporaryDirectories.push(root);
  return root;
}

export async function writeRule(root: string, path: string, content: string | Uint8Array): Promise<void> {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

export async function cleanupPhase17Rules(): Promise<void> {
  await Promise.all(phase17TemporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
}

export class Phase17RuleArtifactStore implements RepositoryRulesArtifactPort {
  readonly inputs: RepositoryRulesArtifactInput[] = [];

  async storeRepositoryRules(input: RepositoryRulesArtifactInput): Promise<RepositoryRulesArtifactReference> {
    const hash = createHash("sha256").update(input.bytes).digest("hex");
    if (hash !== input.expectedSha256) throw new Error("expected hash mismatch");
    this.inputs.push({ ...input, bytes: Uint8Array.from(input.bytes) });
    return {
      artifactId: `sha256:${hash}`,
      bytes: input.bytes.byteLength,
      relativeRef: `artifacts/00000000-0000-4000-8000-000000000017/objects/${hash}`,
      sha256: hash,
    };
  }
}
