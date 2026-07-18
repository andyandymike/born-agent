import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Canonical } from "../../../completion/canonical-json.js";
import { parseStrictJson } from "../../../policy/strict-json.js";
import { DockerAcquisitionError } from "./docker-acquisition-errors.js";
import {
  parseDockerArtifactLock,
  parseDockerContextManifest,
  type DockerArtifactLockV1,
  type DockerContextManifestV1,
} from "./docker-artifact-schema.js";

export const BUILT_IN_DOCKER_ARTIFACTS_ROOT = fileURLToPath(
  new URL("../../../../docker/artifacts/", import.meta.url),
);
export const BUILT_IN_DOCKER_ARTIFACT_ID = "bornagent-sandbox-node-v1";

const MAX_LOCK_BYTES = 64 * 1024;
const MAX_DOCKERFILE_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;

export interface LoadedDockerArtifact {
  readonly contextDirectory: string;
  readonly contextManifest: DockerContextManifestV1;
  readonly dockerfilePath: string;
  readonly lock: DockerArtifactLockV1;
  readonly lockSha256: string;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function utf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new DockerAcquisitionError(
      "docker_artifact_asset_invalid_utf8",
      "built-in Docker artifact JSON/text is not valid UTF-8",
      1,
      { cause: error },
    );
  }
}

async function readRegularFile(
  filePath: string,
  maximumBytes: number,
): Promise<Buffer> {
  const metadata = await lstat(filePath).catch((error: unknown) => {
    throw new DockerAcquisitionError(
      "docker_artifact_asset_missing",
      "built-in Docker artifact asset is missing",
      1,
      { cause: error },
    );
  });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) {
    throw new DockerAcquisitionError(
      "docker_artifact_asset_untrusted",
      "built-in Docker artifact asset must be a bounded regular non-link file",
      1,
    );
  }
  return readFile(filePath);
}

function trustedChild(root: string, relative: string): string {
  if (
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new DockerAcquisitionError(
      "docker_artifact_path_invalid",
      "Docker artifact paths must be fixed package-relative paths",
      1,
    );
  }
  const candidate = path.resolve(root, ...relative.split("/"));
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!candidate.startsWith(prefix)) {
    throw new DockerAcquisitionError(
      "docker_artifact_path_invalid",
      "Docker artifact path escaped the package registry",
      1,
    );
  }
  return candidate;
}

function assertDockerfileContract(
  text: string,
  lock: DockerArtifactLockV1,
): void {
  if (
    text.includes("\0") ||
    /\bADD\s+(?:https?:|git@)/iu.test(text) ||
    /--mount\s*=\s*type=(?:secret|ssh|cache)/iu.test(text) ||
    /\b(?:curl|wget|apk\s+add|npm\s+install|pnpm\s+install|yarn\s+install)\b/iu.test(text)
  ) {
    throw new DockerAcquisitionError(
      "dockerfile_forbidden_instruction",
      "trusted Dockerfile contains a network, secret, cache, or remote-context instruction",
      1,
    );
  }
  const from = [...text.matchAll(/^FROM\s+(\S+)\s*$/gimu)].map((match) => match[1]);
  if (
    lock.build.base_images.length !== 1 ||
    !/^ARG BORN_BASE_IMAGE=bornagent-invalid:denied$/mu.test(text) ||
    from.length !== 1 ||
    from[0] !== "${BORN_BASE_IMAGE}"
  ) {
    throw new DockerAcquisitionError(
      "dockerfile_base_drift",
      "Dockerfile must consume only the service-supplied immutable local base ID",
      1,
    );
  }
}

export async function loadBuiltInDockerArtifact(
  artifactId: string,
  root = BUILT_IN_DOCKER_ARTIFACTS_ROOT,
): Promise<LoadedDockerArtifact> {
  // PHASE15: artifact authority comes from package assets. The profile may
  // select an ID, but workspace files, prompts, and model output cannot supply
  // a registry, Dockerfile, context, digest, or builder.
  if (artifactId !== "bornagent-sandbox-node-v1") {
    throw new DockerAcquisitionError(
      "docker_artifact_unknown",
      "Docker artifact ID is not in the built-in registry",
      2,
    );
  }
  const canonicalRoot = await realpath(root).catch((error: unknown) => {
    throw new DockerAcquisitionError(
      "docker_artifact_registry_missing",
      "built-in Docker artifact registry is missing",
      1,
      { cause: error },
    );
  });
  const lockBytes = await readRegularFile(
    trustedChild(canonicalRoot, `${artifactId}.lock.json`),
    MAX_LOCK_BYTES,
  );
  let lock: DockerArtifactLockV1;
  try {
    lock = parseDockerArtifactLock(parseStrictJson(utf8(lockBytes)));
  } catch (error) {
    if (error instanceof DockerAcquisitionError) throw error;
    throw new DockerAcquisitionError(
      "docker_artifact_lock_invalid",
      "built-in Docker artifact lock is not strict UTF-8 JSON",
      1,
      { cause: error },
    );
  }
  const lockSha256 = sha256Canonical(lock);
  const dockerfilePath = trustedChild(
    canonicalRoot,
    lock.build.dockerfile_relative_path,
  );
  const dockerfile = await readRegularFile(dockerfilePath, MAX_DOCKERFILE_BYTES);
  if (sha256(dockerfile) !== lock.build.dockerfile_sha256) {
    throw new DockerAcquisitionError(
      "dockerfile_hash_mismatch",
      "built-in Dockerfile hash does not match its lock",
      1,
    );
  }
  const dockerfileText = utf8(dockerfile);
  assertDockerfileContract(dockerfileText, lock);

  const manifestPath = trustedChild(
    canonicalRoot,
    lock.build.context_manifest_relative_path,
  );
  const manifestBytes = await readRegularFile(manifestPath, MAX_MANIFEST_BYTES);
  let contextManifest: DockerContextManifestV1;
  try {
    contextManifest = parseDockerContextManifest(
      parseStrictJson(utf8(manifestBytes)),
    );
  } catch (error) {
    if (error instanceof DockerAcquisitionError) throw error;
    throw new DockerAcquisitionError(
      "docker_context_manifest_invalid",
      "built-in Docker context manifest is invalid",
      1,
      { cause: error },
    );
  }
  if (sha256Canonical(contextManifest) !== lock.build.context_manifest_sha256) {
    throw new DockerAcquisitionError(
      "docker_context_manifest_hash_mismatch",
      "Docker context manifest hash does not match its lock",
      1,
    );
  }
  const contextDirectory = trustedChild(canonicalRoot, `${artifactId}/context`);
  for (const file of contextManifest.files) {
    const bytes = await readRegularFile(
      trustedChild(contextDirectory, file.path),
      file.bytes,
    );
    if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
      throw new DockerAcquisitionError(
        "docker_context_file_hash_mismatch",
        "Docker context file does not exact-match the package manifest",
        1,
      );
    }
  }
  const wrapperSha256 =
    lock.runtime_contract.required_labels[
      "org.bornagent.exec-wrapper-sha256"
    ];
  if (
    contextManifest.files.find((file) => file.path === "born-sandbox-exec")
      ?.sha256 !== wrapperSha256
  ) {
    throw new DockerAcquisitionError(
      "docker_wrapper_hash_mismatch",
      "runtime wrapper label does not match the trusted context manifest",
      1,
    );
  }
  return Object.freeze({
    contextDirectory: path.dirname(contextDirectory),
    contextManifest,
    dockerfilePath,
    lock,
    lockSha256,
  });
}
