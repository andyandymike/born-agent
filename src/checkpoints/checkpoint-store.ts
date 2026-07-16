import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  open,
  readFile,
  realpath,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import type { BackendIdentity } from "../model/model-backend.js";
import {
  assertCanonicalCheckpointId,
  assertCanonicalSessionId,
  SessionPathPolicy,
} from "../sessions/session-path-policy.js";
import type { SessionLock } from "../sessions/session-lock.js";
import {
  NodeRenameDurabilityPort,
  type RenameDurabilityPort,
} from "../sessions/rename-durability.js";
import type {
  ExactCheckpointReadRequest,
  ExactCheckpointWriteRequest,
  StoredCheckpointRef,
} from "./checkpoint-types.js";

const SHA256 = /^[0-9a-f]{64}$/u;

export type PrivateFileVerification =
  | { readonly status: "unverified"; readonly reason: string }
  | { readonly status: "verified" };

export interface CheckpointPrivacyVerifier {
  preflight(): Promise<PrivateFileVerification>;
  verifyFile(path: string): Promise<PrivateFileVerification>;
}

export interface CheckpointStoreOptions {
  readonly maximumBytes?: number;
  readonly policy?: SessionPathPolicy;
  readonly privacyVerifier?: CheckpointPrivacyVerifier;
  readonly randomId?: () => string;
  readonly renameDurability?: RenameDurabilityPort;
}

export class CheckpointStoreError extends Error {
  constructor(
    readonly code:
      | "checkpoint_exists"
      | "checkpoint_hash_mismatch"
      | "checkpoint_identity_mismatch"
      | "checkpoint_invalid_reference"
      | "checkpoint_private_mode_unverified"
      | "checkpoint_readback_mismatch"
      | "checkpoint_size_invalid"
      | "checkpoint_write_incomplete",
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "CheckpointStoreError";
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pathKey(path: string): string {
  const normalized = resolve(path).split(sep).join("/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sameIdentity(left: BackendIdentity, right: StoredCheckpointRef): boolean {
  return (
    left.adapter === right.adapter &&
    left.adapterVersion === right.adapterVersion &&
    left.configFingerprint === right.configFingerprint &&
    left.model === right.model &&
    left.provider === right.provider
  );
}

async function writeComplete(
  handle: FileHandle,
  bytes: Uint8Array,
): Promise<void> {
  if (bytes.byteLength === 0) {
    return;
  }
  const result = await handle.write(bytes, 0, bytes.byteLength, 0);
  if (result.bytesWritten !== bytes.byteLength) {
    throw new CheckpointStoreError(
      "checkpoint_write_incomplete",
      "checkpoint artifact write was incomplete",
    );
  }
}

class NodeCheckpointPrivacyVerifier implements CheckpointPrivacyVerifier {
  async preflight(): Promise<PrivateFileVerification> {
    if (process.platform === "win32") {
      return {
        reason: "windows_acl_verifier_not_configured",
        status: "unverified",
      };
    }
    return { status: "verified" };
  }

  async verifyFile(path: string): Promise<PrivateFileVerification> {
    if (process.platform === "win32") {
      return {
        reason: "windows_acl_verifier_not_configured",
        status: "unverified",
      };
    }
    const metadata = await stat(path);
    return (metadata.mode & 0o077) === 0
      ? { status: "verified" }
      : { reason: "posix_mode_is_not_private", status: "unverified" };
  }
}

export class CheckpointStore {
  private readonly maximumBytes: number;
  private readonly privacyVerifier: CheckpointPrivacyVerifier;
  private readonly randomId: () => string;
  private readonly renameDurability: RenameDurabilityPort;

  private constructor(
    private readonly policy: SessionPathPolicy,
    options: CheckpointStoreOptions,
  ) {
    this.maximumBytes = options.maximumBytes ?? 32 * 1_024 * 1_024;
    this.privacyVerifier =
      options.privacyVerifier ?? new NodeCheckpointPrivacyVerifier();
    this.randomId = options.randomId ?? randomUUID;
    this.renameDurability =
      options.renameDurability ?? new NodeRenameDurabilityPort();
  }

  static async create(
    workspace: string,
    options: CheckpointStoreOptions = {},
  ): Promise<CheckpointStore> {
    const policy = options.policy ?? (await SessionPathPolicy.create(workspace));
    const maximumBytes = options.maximumBytes ?? 32 * 1_024 * 1_024;
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new RangeError("maximumBytes must be a positive integer");
    }
    return new CheckpointStore(policy, options);
  }

  async writeExact(
    request: ExactCheckpointWriteRequest,
    lock: SessionLock,
  ): Promise<StoredCheckpointRef> {
    this.validateWriteRequest(request, lock);
    await lock.assertOwned();
    await this.requirePrivate(await this.privacyVerifier.preflight());
    const paths = await this.policy.prepareCheckpointDirectory(
      request.context.sessionId,
    );
    await this.policy.assertSessionPathsSafe(paths);

    const bytes = await request.codec.encode(request.continuation);
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("checkpoint codec must return Uint8Array");
    }
    if (bytes.byteLength === 0 || bytes.byteLength > this.maximumBytes) {
      throw new CheckpointStoreError(
        "checkpoint_size_invalid",
        "checkpoint artifact size is outside the configured bounds",
      );
    }

    const finalPath = join(
      paths.checkpointDirectory,
      `${request.context.checkpointId}.bin`,
    );
    const tempId = this.randomId();
    assertCanonicalCheckpointId(tempId);
    const tempPath = join(
      paths.checkpointDirectory,
      `${request.context.checkpointId}.${tempId}.tmp`,
    );
    await this.assertMissing(finalPath);

    let handle: FileHandle | undefined;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await writeComplete(handle, bytes);
      if (process.platform !== "win32") {
        await handle.chmod(0o600);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.requirePrivate(await this.privacyVerifier.verifyFile(tempPath));
      await lock.assertOwned();
      await this.policy.assertSessionPathsSafe(paths);
      await this.assertMissing(finalPath);
      await this.renameDurability.install(tempPath, finalPath, bytes);
      await this.assertSafeArtifact(finalPath);
      await this.requirePrivate(await this.privacyVerifier.verifyFile(finalPath));
    } finally {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
    }

    const readback = await readFile(finalPath);
    const digest = sha256(bytes);
    if (!readback.equals(bytes) || sha256(readback) !== digest) {
      throw new CheckpointStoreError(
        "checkpoint_readback_mismatch",
        "checkpoint artifact failed durable readback verification",
      );
    }
    await lock.assertOwned();

    return {
      adapter: request.identity.adapter,
      adapterVersion: request.identity.adapterVersion,
      bytes: bytes.byteLength,
      checkpointId: request.context.checkpointId,
      codecVersion: request.codec.codecVersion,
      configFingerprint: request.identity.configFingerprint,
      model: request.identity.model,
      provider: request.identity.provider,
      relativeRef: `.bornagent/checkpoints/${request.context.sessionId}/${request.context.checkpointId}.bin`,
      runId: request.context.runId,
      sessionId: request.context.sessionId,
      sha256: digest,
      turnNumber: request.context.turnNumber,
    };
  }

  async readExact(request: ExactCheckpointReadRequest): Promise<Awaited<ReturnType<ExactCheckpointReadRequest["codec"]["decode"]>>> {
    const reference = request.reference;
    this.validateReference(reference);
    if (
      request.codec.provider !== reference.provider ||
      request.codec.codecVersion !== reference.codecVersion ||
      !sameIdentity(request.identity, reference)
    ) {
      throw new CheckpointStoreError(
        "checkpoint_identity_mismatch",
        "checkpoint backend identity or codec is incompatible",
      );
    }
    await this.requirePrivate(await this.privacyVerifier.preflight());
    const paths = await this.policy.prepareCheckpointDirectory(reference.sessionId);
    const path = join(paths.checkpointDirectory, `${reference.checkpointId}.bin`);
    const expectedRelative = `.bornagent/checkpoints/${reference.sessionId}/${reference.checkpointId}.bin`;
    if (reference.relativeRef !== expectedRelative) {
      throw new CheckpointStoreError(
        "checkpoint_invalid_reference",
        "checkpoint relative reference is not canonical",
      );
    }
    await this.policy.assertSessionPathsSafe(paths);
    await this.assertSafeArtifact(path);
    await this.requirePrivate(await this.privacyVerifier.verifyFile(path));
    const bytes = await readFile(path);
    if (bytes.byteLength !== reference.bytes || sha256(bytes) !== reference.sha256) {
      throw new CheckpointStoreError(
        "checkpoint_hash_mismatch",
        "checkpoint artifact bytes do not match the durable reference",
      );
    }
    return request.codec.decode(bytes, request.identity);
  }

  private validateWriteRequest(
    request: ExactCheckpointWriteRequest,
    lock: SessionLock,
  ): void {
    assertCanonicalCheckpointId(request.context.checkpointId);
    assertCanonicalSessionId(request.context.runId);
    assertCanonicalSessionId(request.context.sessionId);
    if (
      !Number.isSafeInteger(request.context.turnNumber) ||
      request.context.turnNumber <= 0
    ) {
      throw new RangeError("checkpoint turnNumber must be a positive integer");
    }
    if (
      request.codec.provider !== request.identity.provider ||
      request.context.sessionId !== lock.record.sessionId ||
      request.codec.codecVersion.length === 0
    ) {
      throw new CheckpointStoreError(
        "checkpoint_identity_mismatch",
        "checkpoint request does not match its writer or backend codec",
      );
    }
  }

  private validateReference(reference: StoredCheckpointRef): void {
    try {
      assertCanonicalCheckpointId(reference.checkpointId);
      assertCanonicalSessionId(reference.runId);
      assertCanonicalSessionId(reference.sessionId);
    } catch (error) {
      throw new CheckpointStoreError(
        "checkpoint_invalid_reference",
        "checkpoint reference contains an invalid identity",
        { cause: error },
      );
    }
    if (
      !SHA256.test(reference.sha256) ||
      !Number.isSafeInteger(reference.bytes) ||
      reference.bytes <= 0 ||
      reference.bytes > this.maximumBytes ||
      !Number.isSafeInteger(reference.turnNumber) ||
      reference.turnNumber <= 0
    ) {
      throw new CheckpointStoreError(
        "checkpoint_invalid_reference",
        "checkpoint reference metadata is invalid",
      );
    }
  }

  private async assertMissing(path: string): Promise<void> {
    try {
      await lstat(path);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }
    throw new CheckpointStoreError(
      "checkpoint_exists",
      "checkpoint artifact already exists",
    );
  }

  private async assertSafeArtifact(path: string): Promise<void> {
    this.policy.assertContained(path);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new CheckpointStoreError(
        "checkpoint_invalid_reference",
        "checkpoint artifact must be a regular non-link file",
      );
    }
    const canonical = await realpath(path);
    if (pathKey(canonical) !== pathKey(path)) {
      throw new CheckpointStoreError(
        "checkpoint_invalid_reference",
        "checkpoint artifact must not traverse a link or junction",
      );
    }
  }

  private async requirePrivate(
    verification: PrivateFileVerification,
  ): Promise<void> {
    if (verification.status !== "verified") {
      // PHASE9: Node file modes do not prove a restricted Windows ACL. Exact
      // resume is blocked unless a trusted platform adapter verifies privacy;
      // claiming 0600 semantics there would expose opaque provider state.
      throw new CheckpointStoreError(
        "checkpoint_private_mode_unverified",
        `checkpoint privacy could not be verified: ${verification.reason}`,
      );
    }
  }
}
