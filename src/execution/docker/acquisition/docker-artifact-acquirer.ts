import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { EffectiveRuntimePolicy } from "../../../policy/policy-resolver.js";
import { assertDockerArtifactAccess } from "../../../policy/policy-resolver.js";
import type { DockerAcquisitionCommandPort } from "./docker-acquisition-port.js";
import { DockerAcquisitionError } from "./docker-acquisition-errors.js";
import {
  loadBuiltInDockerArtifact,
  type LoadedDockerArtifact,
} from "./docker-artifact-registry.js";
import type {
  DockerArtifactExecutionConfig,
  DockerExecutionImageIdentity,
} from "./docker-image-identity.js";
import {
  LocalDockerDaemonGuard,
  type LocalDockerDaemonEvidence,
} from "./local-docker-daemon-guard.js";

const SHA256_ID = /^sha256:[a-f0-9]{64}$/u;

interface DockerImageInspection {
  readonly architecture: string;
  readonly configuredUser: string;
  readonly id: `sha256:${string}`;
  readonly labels: Readonly<Record<string, string>>;
  readonly operatingSystem: string;
  readonly repoDigests: readonly string[];
}

export interface DockerArtifactStatus {
  readonly schemaVersion: 1;
  readonly artifactId: string;
  readonly artifactLockSha256: string;
  readonly artifactReady: boolean;
  readonly baseImageReady: boolean;
  readonly daemon: LocalDockerDaemonEvidence;
  readonly executionConfig: DockerArtifactExecutionConfig | null;
  readonly imageIdentity: DockerExecutionImageIdentity | null;
  readonly registryAccesses: 0 | 1;
  readonly builds: 0 | 1;
  readonly registryCredentialReads: 0;
  readonly pushes: 0;
  readonly remoteBuilds: 0;
}

function executionConfig(
  artifact: LoadedDockerArtifact,
  identity: DockerExecutionImageIdentity | null,
): DockerArtifactExecutionConfig | null {
  if (identity === null) return null;
  if (identity.kind !== "trusted_local_build") {
    throw new DockerAcquisitionError(
      "docker_acquisition_identity_mismatch",
      "built-in sandbox artifact did not produce a trusted local build identity",
      1,
    );
  }
  const labels = artifact.lock.runtime_contract.required_labels;
  const runtime = labels["org.bornagent.runtime"];
  const runtimeVersion = labels["org.bornagent.runtime-version"];
  const wrapperSha256 = labels["org.bornagent.exec-wrapper-sha256"];
  if (
    runtime === undefined ||
    runtimeVersion === undefined ||
    wrapperSha256 === undefined
  ) {
    throw new DockerAcquisitionError(
      "docker_artifact_lock_invalid",
      "built-in Docker runtime contract is incomplete",
      1,
    );
  }
  return Object.freeze({
    artifactId: artifact.lock.id,
    expectedLockfileSha256: artifact.lockSha256,
    imageIdentity: identity,
    // These Phase 13 invariants are backed by the hashed Dockerfile. A profile
    // can select the artifact but cannot redefine its runtime environment.
    imagePath: "/usr/local/bin:/usr/bin:/bin",
    runtime,
    runtimeVersion,
    supportsCUtf8: true,
    wrapperSha256,
  });
}

export interface DockerArtifactPrepareResult extends DockerArtifactStatus {
  readonly requestedSource: "build" | "pull";
  readonly outcome: "already_ready" | "base_ready" | "built";
  readonly registryAccesses: 0 | 1;
  readonly builds: 0 | 1;
}

function parseInspect(text: string): DockerImageInspection {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new DockerAcquisitionError(
      "docker_image_inspect_invalid",
      "Docker image inspection returned invalid JSON",
      3,
      { cause: error },
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DockerAcquisitionError(
      "docker_image_inspect_invalid",
      "Docker image inspection returned an invalid object",
      3,
    );
  }
  const record = value as Record<string, unknown>;
  const config =
    record.Config !== null &&
    typeof record.Config === "object" &&
    !Array.isArray(record.Config)
      ? (record.Config as Record<string, unknown>)
      : {};
  const rawLabels =
    config.Labels !== null &&
    typeof config.Labels === "object" &&
    !Array.isArray(config.Labels)
      ? (config.Labels as Record<string, unknown>)
      : {};
  const labels = Object.fromEntries(
    Object.entries(rawLabels).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  if (
    typeof record.Id !== "string" ||
    !SHA256_ID.test(record.Id) ||
    typeof record.Os !== "string" ||
    typeof record.Architecture !== "string"
  ) {
    throw new DockerAcquisitionError(
      "docker_image_inspect_invalid",
      "Docker image inspection is missing immutable identity fields",
      3,
    );
  }
  return Object.freeze({
    architecture: record.Architecture,
    configuredUser: typeof config.User === "string" ? config.User : "",
    id: record.Id as `sha256:${string}`,
    labels: Object.freeze(labels),
    operatingSystem: record.Os,
    repoDigests: Object.freeze(
      Array.isArray(record.RepoDigests)
        ? record.RepoDigests.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [],
    ),
  });
}

function absent(stderr: string): boolean {
  return /no such (?:image|object)/iu.test(stderr);
}

async function inspect(
  port: DockerAcquisitionCommandPort,
  reference: string,
): Promise<DockerImageInspection | null> {
  const result = await port.run([
    "image",
    "inspect",
    reference,
    "--format",
    "{{json .}}",
  ]);
  if (result.exitCode !== 0) {
    if (absent(`${result.stderr}\n${result.stdout}`)) return null;
    throw new DockerAcquisitionError(
      "docker_image_inspect_failed",
      "could not inspect the exact local Docker image",
      3,
    );
  }
  return parseInspect(result.stdout.trim());
}

function platformArchitecture(platform: "linux/amd64" | "linux/arm64"): string {
  return platform.slice("linux/".length);
}

function normalizedRepositoryDigest(value: string): string {
  return value.startsWith("docker.io/library/")
    ? value.slice("docker.io/library/".length)
    : value;
}

function internalBaseTag(artifact: LoadedDockerArtifact): string {
  const digest = artifact.lock.pull.image.slice(
    artifact.lock.pull.image.lastIndexOf("@sha256:") + "@sha256:".length,
  );
  return `bornagent-internal-base:sha256-${digest}`;
}

function internalArtifactTag(artifact: LoadedDockerArtifact): string {
  return `bornagent-internal-artifact:${artifact.lockSha256}`;
}

async function prepareInternalBaseTag(
  artifact: LoadedDockerArtifact,
  base: DockerImageInspection,
  port: DockerAcquisitionCommandPort,
): Promise<string> {
  const tag = internalBaseTag(artifact);
  const existing = await inspect(port, tag);
  if (existing !== null && existing.id !== base.id) {
    throw new DockerAcquisitionError(
      "docker_internal_base_tag_conflict",
      "BornAgent internal base tag exists with a different immutable image ID",
      2,
    );
  }
  if (existing === null) {
    const tagged = await port.run([
      "image",
      "tag",
      artifact.lock.pull.image,
      tag,
    ]);
    if (tagged.exitCode !== 0) {
      throw new DockerAcquisitionError(
        "docker_internal_base_tag_failed",
        "could not create the verified local-only base alias",
        3,
      );
    }
  }
  const verified = await inspect(port, tag);
  if (verified?.id !== base.id) {
    throw new DockerAcquisitionError(
      "docker_internal_base_tag_drift",
      "local base alias changed before the trusted build",
      1,
    );
  }
  return tag;
}

function assertBuiltImage(
  artifact: LoadedDockerArtifact,
  inspection: DockerImageInspection,
): DockerExecutionImageIdentity {
  if (
    inspection.operatingSystem !== "linux" ||
    inspection.architecture !== platformArchitecture(artifact.lock.platform) ||
    inspection.configuredUser !== artifact.lock.runtime_contract.numeric_user
  ) {
    throw new DockerAcquisitionError(
      "docker_built_image_contract_mismatch",
      "locally built image does not match platform or numeric non-root user",
      3,
    );
  }
  for (const [name, expected] of Object.entries(
    artifact.lock.runtime_contract.required_labels,
  )) {
    if (inspection.labels[name] !== expected) {
      throw new DockerAcquisitionError(
        "docker_built_image_label_mismatch",
        "locally built image does not match the exact runtime labels",
        3,
      );
    }
  }
  if (
    inspection.labels["org.bornagent.lockfile-sha256"] !==
    artifact.lockSha256
  ) {
    throw new DockerAcquisitionError(
      "docker_built_image_lock_mismatch",
      "locally built image does not bind the current artifact lock",
      3,
    );
  }
  // PHASE15: a local build has no registry RepoDigest. Its executable identity
  // is the config image ID plus recipe/context/base/lock hashes; a mutable tag
  // is never emitted or accepted as evidence.
  return Object.freeze({
    artifactId: artifact.lock.id,
    artifactLockSha256: artifact.lockSha256,
    baseImageDigests: Object.freeze([...artifact.lock.build.base_images]),
    configImageId: inspection.id,
    contextManifestSha256: artifact.lock.build.context_manifest_sha256,
    dockerfileSha256: artifact.lock.build.dockerfile_sha256,
    kind: "trusted_local_build",
  });
}

async function exactBaseInspection(
  artifact: LoadedDockerArtifact,
  port: DockerAcquisitionCommandPort,
): Promise<DockerImageInspection | null> {
  const inspection = await inspect(port, artifact.lock.pull.image);
  return inspection !== null &&
    inspection.operatingSystem === "linux" &&
    inspection.architecture === platformArchitecture(artifact.lock.platform) &&
    inspection.repoDigests
      .map(normalizedRepositoryDigest)
      .includes(normalizedRepositoryDigest(artifact.lock.pull.image))
    ? inspection
    : null;
}

async function findBuiltIdentity(
  artifact: LoadedDockerArtifact,
  port: DockerAcquisitionCommandPort,
): Promise<DockerExecutionImageIdentity | null> {
  const candidate = await inspect(port, internalArtifactTag(artifact));
  return candidate === null ? null : assertBuiltImage(artifact, candidate);
}

export class DockerArtifactAcquirer {
  public constructor(
    private readonly port: DockerAcquisitionCommandPort,
    private readonly environment: Readonly<Record<string, string | undefined>>,
    private readonly platform: NodeJS.Platform,
    private readonly artifactsRoot?: string,
  ) {}

  private async preflight(
    policy: EffectiveRuntimePolicy,
    artifactId: string,
  ): Promise<{
    readonly artifact: LoadedDockerArtifact;
    readonly daemon: LocalDockerDaemonEvidence;
  }> {
    // Policy/artifact denial precedes the first Docker argv and therefore also
    // precedes daemon, registry, builder, and credential-helper interaction.
    assertDockerArtifactAccess(policy, artifactId);
    const artifact = await loadBuiltInDockerArtifact(
      artifactId,
      this.artifactsRoot,
    );
    const daemon = await new LocalDockerDaemonGuard(
      this.environment,
      this.platform,
    ).assertLocal(this.port);
    if (`${daemon.operatingSystem}/${daemon.architecture}` !== artifact.lock.platform) {
      throw new DockerAcquisitionError(
        "docker_artifact_platform_mismatch",
        "artifact platform does not match the local Linux Docker daemon",
        3,
      );
    }
    return { artifact, daemon };
  }

  async status(input: {
    readonly policy: EffectiveRuntimePolicy;
    readonly artifactId: string;
  }): Promise<DockerArtifactStatus> {
    const { artifact, daemon } = await this.preflight(
      input.policy,
      input.artifactId,
    );
    // PHASE15: keep the two cold-daemon image-store reads deterministic.
    // Docker Desktop can transiently hide one tag when independent CLI clients
    // inspect the base and artifact concurrently; status must not add retries or
    // prepare side effects merely to compensate for that visibility race.
    const baseImageReady =
      (await exactBaseInspection(artifact, this.port)) !== null;
    const imageIdentity = await findBuiltIdentity(artifact, this.port);
    return Object.freeze({
      artifactId: artifact.lock.id,
      artifactLockSha256: artifact.lockSha256,
      artifactReady: imageIdentity !== null,
      baseImageReady,
      builds: 0,
      daemon,
      executionConfig: executionConfig(artifact, imageIdentity),
      imageIdentity,
      pushes: 0,
      registryAccesses: 0,
      registryCredentialReads: 0,
      remoteBuilds: 0,
      schemaVersion: 1,
    });
  }

  async prepare(input: {
    readonly policy: EffectiveRuntimePolicy;
    readonly artifactId: string;
    readonly source?: "build" | "pull" | undefined;
  }): Promise<DockerArtifactPrepareResult> {
    const { artifact, daemon } = await this.preflight(
      input.policy,
      input.artifactId,
    );
    const source = input.source ?? artifact.lock.preferred_source;
    const access = input.policy.entry.profile.dockerAcquisition;
    if (
      access.kind !== "local_locked" ||
      (source === "pull"
        ? access.pull !== "allow_public_digest_pinned"
        : access.build !== "allow_trusted_local_context")
    ) {
      throw new DockerAcquisitionError(
        "docker_acquisition_source_denied",
        "selected Docker acquisition source is denied by the effective profile",
        2,
      );
    }
    let registryAccesses: 0 | 1 = 0;
    let baseInspection = await exactBaseInspection(artifact, this.port);
    if (baseInspection === null) {
      const pulled = await this.port.run(
        [
          "image",
          "pull",
          "--platform",
          artifact.lock.platform,
          artifact.lock.pull.image,
        ],
        { timeoutMs: 240_000 },
      );
      registryAccesses = 1;
      if (pulled.exitCode !== 0) {
        throw new DockerAcquisitionError(
          "docker_public_pull_failed",
          "anonymous public exact-digest Docker pull failed; no login, mirror, or fallback was attempted",
          5,
        );
      }
      baseInspection = await exactBaseInspection(artifact, this.port);
      if (baseInspection === null) {
        throw new DockerAcquisitionError(
          "docker_public_pull_identity_mismatch",
          "pulled image did not expose the locked repository digest",
          1,
        );
      }
    }
    const baseImageReady = true;
    let imageIdentity = await findBuiltIdentity(artifact, this.port);
    if (source === "pull") {
      // This first-party artifact has no published prebuilt image yet. Its
      // locked anonymous pull is explicitly the build-base acquisition path;
      // it never pretends the unlabelled upstream Node image is sandbox-ready.
      return Object.freeze({
        artifactId: artifact.lock.id,
        artifactLockSha256: artifact.lockSha256,
        artifactReady: imageIdentity !== null,
        baseImageReady,
        builds: 0,
        daemon,
        executionConfig: executionConfig(artifact, imageIdentity),
        imageIdentity,
        outcome: imageIdentity === null ? "base_ready" : "already_ready",
        pushes: 0,
        registryAccesses,
        registryCredentialReads: 0,
        remoteBuilds: 0,
        requestedSource: source,
        schemaVersion: 1,
      });
    }
    if (imageIdentity !== null) {
      return Object.freeze({
        artifactId: artifact.lock.id,
        artifactLockSha256: artifact.lockSha256,
        artifactReady: true,
        baseImageReady,
        builds: 0,
        daemon,
        executionConfig: executionConfig(artifact, imageIdentity),
        imageIdentity,
        outcome: "already_ready",
        pushes: 0,
        registryAccesses,
        registryCredentialReads: 0,
        remoteBuilds: 0,
        requestedSource: source,
        schemaVersion: 1,
      });
    }
    const temp = await mkdtemp(path.join(tmpdir(), "bornagent-docker-build-"));
    try {
      const iidfile = path.join(temp, "image-id");
      const baseTag = await prepareInternalBaseTag(
        artifact,
        baseInspection,
        this.port,
      );
      const built = await this.port.run(
        [
          "build",
          "--pull=false",
          "--network=none",
          "--platform",
          artifact.lock.platform,
          "--tag",
          internalArtifactTag(artifact),
          "--iidfile",
          iidfile,
          "--build-arg",
          `BORN_BASE_IMAGE=${baseTag}`,
          "--build-arg",
          `BORN_ARTIFACT_LOCK_SHA256=${artifact.lockSha256}`,
          "--file",
          artifact.dockerfilePath,
          artifact.contextDirectory,
        ],
        { timeoutMs: 300_000 },
      );
      if (built.exitCode !== 0) {
        throw new DockerAcquisitionError(
          "docker_local_build_failed",
          "trusted local Docker build failed; no remote builder or fallback was attempted",
          5,
          {
            cause: new Error(
              built.stderr.trim().slice(-2_000) ||
                "Docker build returned a non-zero exit code without stderr",
            ),
          },
        );
      }
      const imageId = (await readFile(iidfile, "utf8")).trim();
      if (!SHA256_ID.test(imageId)) {
        throw new DockerAcquisitionError(
          "docker_local_build_identity_invalid",
          "Docker iidfile did not contain an immutable config image ID",
          1,
        );
      }
      const inspected = await inspect(this.port, imageId);
      if (inspected === null) {
        throw new DockerAcquisitionError(
          "docker_local_build_missing",
          "locally built config image ID is not present",
          1,
        );
      }
      const taggedArtifact = await inspect(
        this.port,
        internalArtifactTag(artifact),
      );
      if (taggedArtifact?.id !== inspected.id) {
        throw new DockerAcquisitionError(
          "docker_local_build_tag_drift",
          "local discovery alias does not point to the built immutable image ID",
          1,
        );
      }
      const baseAfterBuild = await inspect(this.port, baseTag);
      if (baseAfterBuild?.id !== baseInspection.id) {
        throw new DockerAcquisitionError(
          "docker_internal_base_tag_drift",
          "local base alias changed during the trusted build",
          1,
        );
      }
      imageIdentity = assertBuiltImage(artifact, inspected);
      return Object.freeze({
        artifactId: artifact.lock.id,
        artifactLockSha256: artifact.lockSha256,
        artifactReady: true,
        baseImageReady,
        builds: 1,
        daemon,
        executionConfig: executionConfig(artifact, imageIdentity),
        imageIdentity,
        outcome: "built",
        pushes: 0,
        registryAccesses,
        registryCredentialReads: 0,
        remoteBuilds: 0,
        requestedSource: source,
        schemaVersion: 1,
      });
    } finally {
      await rm(temp, { force: true, recursive: true }).catch(() => undefined);
    }
  }
}
