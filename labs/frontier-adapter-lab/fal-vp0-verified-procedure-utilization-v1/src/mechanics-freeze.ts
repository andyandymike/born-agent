import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import {
  isStrictlySortedUnique,
  rawSha256,
  relativeArtifactRefSchema,
  sha256Schema,
} from "./protocol.js";
import {
  falVp0MechanicsFreezeEvidenceSchema,
  type FalVp0MechanicsFreezeEvidence,
} from "./receipt-schema.js";

const execFileAsync = promisify(execFile);

async function git(
  repositoryRoot: string,
  args: readonly string[],
  encoding: BufferEncoding | "buffer" = "utf8",
): Promise<string | Buffer> {
  const result = await execFileAsync("git", ["-C", repositoryRoot, ...args], {
    encoding: encoding === "buffer" ? "buffer" : encoding,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  return result.stdout;
}

export async function verifyFalVp0MechanicsFreeze(input: {
  readonly actorPreflightSha256: string;
  readonly mechanicsFreezeCommit: string;
  readonly protectedRelativeRefs: readonly string[];
  readonly repositoryRoot: string;
}): Promise<FalVp0MechanicsFreezeEvidence> {
  const actorPreflightSha256 = sha256Schema.parse(input.actorPreflightSha256);
  const protectedRelativeRefs = input.protectedRelativeRefs.map((entry) =>
    relativeArtifactRefSchema.parse(entry)).sort();
  if (protectedRelativeRefs.length === 0 ||
      !isStrictlySortedUnique(protectedRelativeRefs) ||
      new Set(protectedRelativeRefs).size !== input.protectedRelativeRefs.length) {
    throw new Error("FAL-VP0 mechanics freeze requires unique protected relative refs");
  }
  const resolvedCommit = String(await git(input.repositoryRoot, [
    "rev-parse",
    `${input.mechanicsFreezeCommit}^{commit}`,
  ])).trim();
  const headCommit = String(await git(input.repositoryRoot, ["rev-parse", "HEAD^{commit}"])).trim();
  if (resolvedCommit !== headCommit) {
    throw new Error("FAL-VP0 mechanics freeze commit must be the checked-out HEAD");
  }
  const parentCommit = String(await git(input.repositoryRoot, [
    "rev-parse",
    `${resolvedCommit}^`,
  ])).trim();
  const dirty = String(await git(input.repositoryRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ...protectedRelativeRefs,
  ])).trim();
  if (dirty.length > 0) {
    throw new Error("FAL-VP0 mechanics protected bytes are dirty or untracked");
  }
  const treeInventory = await git(input.repositoryRoot, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    resolvedCommit,
    "--",
    ...protectedRelativeRefs,
  ], "buffer") as Buffer;
  if (treeInventory.byteLength === 0) {
    throw new Error("FAL-VP0 mechanics freeze tree inventory is empty");
  }
  const mechanicsTreeSha256 = rawSha256(treeInventory);
  const ancestryEvidenceSha256 = sha256Canonical({
    actorPreflightCommit: resolvedCommit,
    actorPreflightSha256,
    mechanicsFreezeCommit: resolvedCommit,
    mechanicsParentCommit: parentCommit,
    mechanicsTreeSha256,
    protectedRelativeRefs,
  });
  return falVp0MechanicsFreezeEvidenceSchema.parse({
    mechanicsFreezeCommit: resolvedCommit,
    mechanicsParentCommit: parentCommit,
    actorPreflightCommit: resolvedCommit,
    mechanicsTreeSha256,
    actorPreflightSha256,
    ancestryEvidenceSha256,
  });
}
