import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type { ResolvedAgentConfig } from "../agent/agent-types.js";
import {
  AGENT_SYSTEM_INSTRUCTIONS,
  READ_ONLY_AGENT_SYSTEM_INSTRUCTIONS,
} from "../agent/system-instructions.js";
import { sha256Canonical } from "../completion/canonical-json.js";
import { finishTaskInputSchema } from "../completion/finish-task-tool.js";
import type { ModelBackend } from "../model/model-backend.js";
import {
  LOCAL_FREE_PERMISSION_POLICY_ID,
  LOCAL_FREE_PERMISSION_POLICY_VERSION,
} from "../permissions/local-free-policy.js";
import { applyPatchInputSchema } from "../tools/apply-patch-tool.js";
import { listFilesInputSchema } from "../tools/list-files-tool.js";
import { readFileInputSchema } from "../tools/read-file-tool.js";
import { runCommandInputSchema } from "../tools/run-command-tool.js";
import { searchInputSchema } from "../tools/search-tool.js";
import { SourceStateDigestBuilder } from "../verification/source-state-digest.js";
import type { SourceStateDigest } from "../verification/source-state-digest.js";
import {
  createWorkspaceResumeFingerprint,
  type WorkspaceResumeFingerprint,
} from "./workspace-resume-fingerprint.js";

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalRootIdentity(path: string, platform: NodeJS.Platform): string {
  const normalized = path.replaceAll("\\", "/").normalize("NFC");
  return sha256Canonical({
    path: platform === "win32" ? normalized.toLowerCase() : normalized,
    platform_path_semantics: platform === "win32" ? "case_insensitive" : "case_sensitive",
    version: 1,
  });
}

async function portableSourceState(workspace: string): Promise<SourceStateDigest> {
  const root = await realpath(workspace);
  const files: { bytesSha256: string; path: string; type: "file" }[] = [];
  let totalBytes = 0;
  const visit = async (absolute: string, relative: string): Promise<void> => {
    for (const name of (await readdir(absolute)).sort((left, right) =>
      left.localeCompare(right, "en"),
    )) {
      if (relative === "" && [".bornagent", ".git"].includes(name.toLowerCase())) {
        continue;
      }
      const childAbsolute = join(absolute, name);
      const childRelative = relative === "" ? name : `${relative}/${name}`;
      const metadata = await lstat(childAbsolute);
      if (metadata.isSymbolicLink()) {
        throw new Error("resume fingerprint does not follow symbolic links");
      }
      if (metadata.isDirectory()) {
        await visit(childAbsolute, childRelative);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error("resume fingerprint supports regular files only");
      }
      if (files.length >= 100_000 || metadata.size > 64 * 1024 * 1024) {
        throw new Error("resume fingerprint source limits exceeded");
      }
      totalBytes += metadata.size;
      if (totalBytes > 1024 * 1024 * 1024) {
        throw new Error("resume fingerprint source limits exceeded");
      }
      files.push({
        bytesSha256: createHash("sha256")
          .update(await readFile(childAbsolute))
          .digest("hex"),
        path: childRelative.replaceAll("\\", "/").normalize("NFC"),
        type: "file",
      });
    }
  };
  await visit(root, "");
  return Object.freeze({
    files: Object.freeze(files.map((file) => Object.freeze(file))),
    gitHeadSha256: sha256Canonical({ state: "not_a_git_workspace", version: 1 }),
    gitIndexSha256: sha256Canonical({ state: "not_a_git_workspace", version: 1 }),
    sourceStateSha256: sha256Canonical({ files, version: 1 }),
  });
}

async function buildSourceState(workspace: string): Promise<SourceStateDigest> {
  try {
    return await new SourceStateDigestBuilder().build(workspace);
  } catch {
    return portableSourceState(workspace);
  }
}

function schema(schema: z.ZodType): Readonly<Record<string, unknown>> {
  return z.toJSONSchema(schema, { target: "draft-7" });
}

export function agentToolSchemaSha256(
  taskProfile: ResolvedAgentConfig["taskProfile"],
): string {
  const definitions = [
    { name: "list_files", schema: schema(listFilesInputSchema) },
    { name: "read_file", schema: schema(readFileInputSchema) },
    { name: "search", schema: schema(searchInputSchema) },
    ...(taskProfile === "read-only"
      ? []
      : [
          { name: "apply_patch", schema: schema(applyPatchInputSchema) },
          { name: "finish_task", schema: schema(finishTaskInputSchema) },
          { name: "run_command", schema: schema(runCommandInputSchema) },
        ]),
  ].sort((left, right) => left.name.localeCompare(right.name, "en"));
  return sha256Canonical({ definitions, strict: true, version: 1 });
}

export function agentPolicySha256(config: ResolvedAgentConfig): string {
  return sha256Canonical({
    command_approval: config.commandApproval,
    edit_approval: config.editApproval,
    permission_policy: {
      id: LOCAL_FREE_PERMISSION_POLICY_ID,
      version: LOCAL_FREE_PERMISSION_POLICY_VERSION,
    },
    mcp_servers: config.mcpServerIds ?? [],
    task_profile: config.taskProfile,
    version: 1,
  });
}

export interface WorkspaceResumeFingerprintBuildInput {
  readonly backend: ModelBackend;
  readonly config: ResolvedAgentConfig;
  readonly platform: NodeJS.Platform;
  readonly workspace: string;
}

export async function buildWorkspaceResumeFingerprint(
  input: WorkspaceResumeFingerprintBuildInput,
): Promise<WorkspaceResumeFingerprint> {
  const [root, sourceState] = await Promise.all([
    realpath(input.workspace),
    buildSourceState(input.workspace),
  ]);
  const instructions =
    input.config.taskProfile === "read-only"
      ? READ_ONLY_AGENT_SYSTEM_INSTRUCTIONS
      : AGENT_SYSTEM_INSTRUCTIONS;
  // PHASE9: exact resume compares code/policy/tool identities and repository
  // bytes independently. A matching path alone cannot authorize opaque state
  // produced under a different tool catalog or changed working tree.
  return createWorkspaceResumeFingerprint({
    backend: input.backend.identity,
    canonicalRootIdentity: canonicalRootIdentity(root, input.platform),
    checkpointCodecVersion:
      input.backend.resume.capability === "exact_checkpoint"
        ? input.backend.resume.checkpointCodec.codecVersion
        : null,
    completionSchemaSha256: sha256Canonical({
      completion_policy: input.config.completionPolicy,
      require_verification: input.config.requireVerification,
      schema_version: 1,
    }),
    policySha256: agentPolicySha256(input.config),
    sourceState: {
      gitHeadSha256: sourceState.gitHeadSha256,
      gitIndexSha256: sourceState.gitIndexSha256,
      sourceStateSha256: sourceState.sourceStateSha256,
    },
    systemInstructionsSha256: sha256Text(instructions),
    taskProfile: input.config.taskProfile,
    toolSchemaSha256: agentToolSchemaSha256(input.config.taskProfile),
  });
}
