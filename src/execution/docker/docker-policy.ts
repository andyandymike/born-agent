const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_LABEL_VALUE = /^[\x20-\x7e]{1,500}$/u;

export const DOCKER_SANDBOX_POLICY_VERSION = "phase13-docker-v1";
export const DOCKER_SANDBOX_WRAPPER = "/usr/local/bin/born-sandbox-exec";

export interface DockerResourceLimits {
  readonly cpus: number;
  readonly memoryMiB: number;
  readonly pids: number;
  readonly tmpMiB: number;
}

export interface DigestPinnedImageReference {
  readonly digest: `sha256:${string}`;
  readonly reference: string;
  readonly repository: string;
}

export interface DockerImagePolicyInput {
  readonly expectedLockfileSha256?: string | null;
  readonly image: string;
  readonly imagePath: string;
  readonly imagePolicyVersion?: string;
  readonly runtime: string;
  readonly runtimeVersion: string;
  readonly supportsCUtf8: boolean;
  readonly wrapperSha256: string;
}

export interface DockerImagePolicy {
  readonly expectedLockfileSha256: string | null;
  readonly image: DigestPinnedImageReference;
  readonly imagePath: string;
  readonly imagePolicyVersion: string;
  readonly runtime: string;
  readonly runtimeVersion: string;
  readonly supportsCUtf8: boolean;
  readonly wrapperSha256: string;
}

export interface LocalDockerImageInspection {
  readonly architecture: string;
  readonly configuredUser: string;
  readonly id: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly operatingSystem: string;
  readonly repoDigests: readonly string[];
}

export interface ValidatedLocalDockerImage {
  readonly architecture: string;
  readonly configImageId: string;
  readonly image: DigestPinnedImageReference;
  readonly nonRootUser: `${number}:${number}`;
  readonly policy: DockerImagePolicy;
}

export interface LocalDockerImageInspector {
  /** Inspect only an already-present image. Implementations must never pull or build. */
  inspectLocal(
    reference: DigestPinnedImageReference,
  ): Promise<LocalDockerImageInspection | null>;
}

export class DockerPolicyError extends Error {
  override readonly name = "DockerPolicyError";

  public constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function assertSafeLabel(value: string, field: string): void {
  if (!SAFE_LABEL_VALUE.test(value)) {
    throw new DockerPolicyError(
      `invalid_${field}`,
      `${field} must be a bounded printable policy value`,
    );
  }
}

function assertSha256(value: string, field: string): void {
  if (!SHA256.test(value)) {
    throw new DockerPolicyError(
      `invalid_${field}`,
      `${field} must be a lowercase SHA-256 digest`,
    );
  }
}

export function parseDigestPinnedImageReference(
  value: string,
): DigestPinnedImageReference {
  if (
    value.length < 73 ||
    value.length > 500 ||
    value !== value.toLowerCase() ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r") ||
    value.includes(" ") ||
    value.includes("://")
  ) {
    throw new DockerPolicyError(
      "invalid_image_reference",
      "Docker image must be a bounded lowercase repository@sha256 reference",
    );
  }
  const separator = value.lastIndexOf("@sha256:");
  if (separator <= 0 || value.indexOf("@") !== separator) {
    throw new DockerPolicyError(
      "image_not_digest_pinned",
      "Docker image must use an exact repository@sha256 digest",
    );
  }
  const repository = value.slice(0, separator);
  const digestHex = value.slice(separator + "@sha256:".length);
  if (
    !SHA256.test(digestHex) ||
    !/^[a-z0-9][a-z0-9._:/-]*[a-z0-9]$/u.test(repository) ||
    repository.includes("//") ||
    repository.includes("..")
  ) {
    throw new DockerPolicyError(
      "invalid_image_reference",
      "Docker image repository or digest is invalid",
    );
  }
  const lastSegment = repository.slice(repository.lastIndexOf("/") + 1);
  if (lastSegment.includes(":")) {
    throw new DockerPolicyError(
      "tagged_image_reference_denied",
      "Docker image policy accepts name@digest, not tag@digest",
    );
  }
  return Object.freeze({
    digest: `sha256:${digestHex}`,
    reference: value,
    repository,
  });
}

function validateImagePath(value: string): string {
  const parts = value.split(":");
  if (
    value.length === 0 ||
    value.length > 2_048 ||
    parts.some(
      (part) =>
        !part.startsWith("/") ||
        part.length > 500 ||
        part.includes("//") ||
        part.split("/").some((segment) => segment === "." || segment === "..") ||
        !/^[a-zA-Z0-9_./-]+$/u.test(part),
    )
  ) {
    throw new DockerPolicyError(
      "invalid_image_path",
      "image PATH must contain only fixed absolute Linux directories",
    );
  }
  return value;
}

export function validateDockerImagePolicy(
  input: DockerImagePolicyInput,
): DockerImagePolicy {
  const expectedLockfileSha256 = input.expectedLockfileSha256 ?? null;
  if (expectedLockfileSha256 !== null) {
    assertSha256(expectedLockfileSha256, "lockfile_sha256");
  }
  assertSha256(input.wrapperSha256, "wrapper_sha256");
  assertSafeLabel(input.runtime, "runtime");
  assertSafeLabel(input.runtimeVersion, "runtime_version");
  const imagePolicyVersion =
    input.imagePolicyVersion ?? DOCKER_SANDBOX_POLICY_VERSION;
  assertSafeLabel(imagePolicyVersion, "image_policy_version");
  return Object.freeze({
    expectedLockfileSha256,
    image: parseDigestPinnedImageReference(input.image),
    imagePath: validateImagePath(input.imagePath),
    imagePolicyVersion,
    runtime: input.runtime,
    runtimeVersion: input.runtimeVersion,
    supportsCUtf8: input.supportsCUtf8,
    wrapperSha256: input.wrapperSha256,
  });
}

export function validateDockerResourceLimits(
  input: DockerResourceLimits,
): DockerResourceLimits {
  if (
    !Number.isFinite(input.cpus) ||
    input.cpus < 0.25 ||
    input.cpus > 8 ||
    Math.round(input.cpus * 100) !== input.cpus * 100
  ) {
    throw new DockerPolicyError(
      "invalid_cpu_limit",
      "sandbox CPUs must be from 0.25 through 8 with at most two decimals",
    );
  }
  const integerFields = [
    ["memory", input.memoryMiB, 256, 8_192],
    ["pids", input.pids, 32, 1_024],
    ["tmp", input.tmpMiB, 16, 1_024],
  ] as const;
  for (const [name, value, minimum, maximum] of integerFields) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new DockerPolicyError(
        `invalid_${name}_limit`,
        `sandbox ${name} limit must be an integer from ${minimum} through ${maximum}`,
      );
    }
  }
  return Object.freeze({ ...input });
}

function parseNonRootUser(value: string): `${number}:${number}` {
  if (!/^\d{1,10}:\d{1,10}$/u.test(value)) {
    throw new DockerPolicyError(
      "image_user_not_numeric",
      "Docker image must configure an exact numeric uid:gid",
    );
  }
  const [uidText, gidText] = value.split(":");
  const uid = Number(uidText);
  const gid = Number(gidText);
  if (
    !Number.isSafeInteger(uid) ||
    !Number.isSafeInteger(gid) ||
    uid <= 0 ||
    gid <= 0 ||
    uid > 2_147_483_647 ||
    gid > 2_147_483_647
  ) {
    throw new DockerPolicyError(
      "image_user_is_root",
      "Docker image uid and gid must both be non-root numeric identities",
    );
  }
  return `${uid}:${gid}`;
}

function requireLabel(
  inspection: LocalDockerImageInspection,
  name: string,
  expected: string,
): void {
  if (inspection.labels[name] !== expected) {
    throw new DockerPolicyError(
      "image_label_mismatch",
      `local Docker image label ${name} does not match trusted policy`,
    );
  }
}

export function validateLocalDockerImage(
  policy: DockerImagePolicy,
  inspection: LocalDockerImageInspection | null,
): ValidatedLocalDockerImage {
  // PHASE13: A digest pin freezes image identity; it does not attest that the
  // image is benign. This boundary only inspects a local image and never pulls,
  // builds, or contacts a registry when the image is missing.
  if (inspection === null) {
    throw new DockerPolicyError(
      "image_missing_local",
      "digest-pinned Docker image is not present locally",
    );
  }
  if (inspection.operatingSystem !== "linux") {
    throw new DockerPolicyError(
      "image_platform_denied",
      "Docker sandbox requires a Linux container image",
    );
  }
  if (!inspection.repoDigests.includes(policy.image.reference)) {
    throw new DockerPolicyError(
      "image_digest_mismatch",
      "local Docker image does not expose the approved repository digest",
    );
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(inspection.id)) {
    throw new DockerPolicyError(
      "invalid_image_id",
      "Docker image inspection returned an invalid config image id",
    );
  }
  requireLabel(inspection, "org.bornagent.runtime", policy.runtime);
  requireLabel(
    inspection,
    "org.bornagent.runtime-version",
    policy.runtimeVersion,
  );
  requireLabel(
    inspection,
    "org.bornagent.image-policy-version",
    policy.imagePolicyVersion,
  );
  requireLabel(
    inspection,
    "org.bornagent.exec-wrapper-sha256",
    policy.wrapperSha256,
  );
  if (policy.expectedLockfileSha256 !== null) {
    requireLabel(
      inspection,
      "org.bornagent.lockfile-sha256",
      policy.expectedLockfileSha256,
    );
  }
  assertSafeLabel(inspection.architecture, "architecture");
  return Object.freeze({
    architecture: inspection.architecture,
    configImageId: inspection.id,
    image: policy.image,
    nonRootUser: parseNonRootUser(inspection.configuredUser),
    policy,
  });
}
