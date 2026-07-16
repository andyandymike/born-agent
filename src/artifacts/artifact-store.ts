import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  assertCanonicalSessionId,
  SessionPathPolicy,
} from "../sessions/session-path-policy.js";
import {
  ArtifactError,
  DEFAULT_ARTIFACT_CAPTURE_BYTES,
  DEFAULT_RUN_ARTIFACT_BYTES,
  DEFAULT_SESSION_ARTIFACT_BYTES,
  MAX_ARTIFACT_CAPTURE_BYTES,
  parseArtifactId,
  type ArtifactBudgets,
  type ArtifactBudgetUsage,
  type ArtifactCaptureStatus,
  type ArtifactObjectMetadata,
  type ArtifactStoreCaptureResult,
} from "./artifact-types.js";

export type SanitizedTextChunks =
  | AsyncIterable<Uint8Array>
  | Iterable<Uint8Array>;

export interface StoreSanitizedTextInput {
  readonly chunks: SanitizedTextChunks;
  readonly maximumBytes?: number;
  readonly runId: string;
}

export interface ArtifactStoreOptions {
  readonly budgets?: Partial<ArtifactBudgets>;
  readonly initialUsage?: ArtifactBudgetUsage;
  readonly sessionId: string;
  readonly workspace: string;
}

interface ArtifactPaths {
  readonly artifactRoot: string;
  readonly objectDirectory: string;
  readonly sessionDirectory: string;
  readonly workspace: string;
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function platformPath(path: string): string {
  const normalized = resolve(path).split(sep).join("/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === "" ||
    (!difference.startsWith(`..${sep}`) &&
      difference !== ".." &&
      !isAbsolute(difference))
  );
}

function validateBudgets(options: ArtifactStoreOptions): ArtifactBudgets {
  const budgets = {
    perArtifactBytes:
      options.budgets?.perArtifactBytes ?? DEFAULT_ARTIFACT_CAPTURE_BYTES,
    perRunBytes: options.budgets?.perRunBytes ?? DEFAULT_RUN_ARTIFACT_BYTES,
    perSessionBytes:
      options.budgets?.perSessionBytes ?? DEFAULT_SESSION_ARTIFACT_BYTES,
  };
  if (
    !Number.isSafeInteger(budgets.perArtifactBytes) ||
    !Number.isSafeInteger(budgets.perRunBytes) ||
    !Number.isSafeInteger(budgets.perSessionBytes) ||
    budgets.perArtifactBytes < 1 ||
    budgets.perArtifactBytes > MAX_ARTIFACT_CAPTURE_BYTES ||
    budgets.perRunBytes < budgets.perArtifactBytes ||
    budgets.perSessionBytes < budgets.perRunBytes
  ) {
    throw new ArtifactError(
      "artifact_budget_invalid",
      "artifact budgets must be ordered positive safe integers with a 16 MiB per-object cap",
    );
  }
  return Object.freeze(budgets);
}

function validateInitialUsage(
  usage: ArtifactBudgetUsage | undefined,
  budgets: ArtifactBudgets,
): { readonly runBytes: Map<string, number>; readonly sessionBytes: number } {
  const runBytes = new Map<string, number>();
  let listedRunBytes = 0;
  for (const [runId, bytes] of Object.entries(usage?.runBytes ?? {})) {
    assertCanonicalSessionId(runId);
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > budgets.perRunBytes
    ) {
      throw new ArtifactError(
        "artifact_budget_invalid",
        "initial run artifact usage is invalid",
      );
    }
    runBytes.set(runId, bytes);
    listedRunBytes += bytes;
    if (
      !Number.isSafeInteger(listedRunBytes) ||
      listedRunBytes > budgets.perSessionBytes
    ) {
      throw new ArtifactError(
        "artifact_budget_invalid",
        "initial run artifact usage exceeds the session budget",
      );
    }
  }
  const sessionBytes = usage?.sessionBytes ?? listedRunBytes;
  if (
    !Number.isSafeInteger(sessionBytes) ||
    sessionBytes < listedRunBytes ||
    sessionBytes > budgets.perSessionBytes
  ) {
    throw new ArtifactError(
      "artifact_budget_invalid",
      "initial session artifact usage is invalid",
    );
  }
  return { runBytes, sessionBytes };
}

async function ensurePrivateDirectory(root: string, path: string): Promise<void> {
  if (!isContained(root, path)) {
    throw new ArtifactError(
      "artifact_path_unsafe",
      "artifact directory escapes the canonical workspace",
    );
  }
  try {
    await mkdir(path, { mode: 0o700, recursive: false });
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) throw error;
  }
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new ArtifactError(
      "artifact_path_unsafe",
      "artifact storage directories must be real directories",
    );
  }
  if (platformPath(await realpath(path)) !== platformPath(path)) {
    throw new ArtifactError(
      "artifact_path_unsafe",
      "artifact storage must not traverse a symbolic link or junction",
    );
  }
  if (process.platform !== "win32") await chmod(path, 0o700);
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength === 0) return;
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      null,
    );
    if (result.bytesWritten < 1) {
      throw new ArtifactError(
        "artifact_persist_failed",
        "artifact write made no progress",
      );
    }
    offset += result.bytesWritten;
  }
}

function utf8Prefix(bytes: Uint8Array, maximumBytes: number): Uint8Array {
  if (bytes.byteLength <= maximumBytes) return bytes;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = Math.max(0, maximumBytes);
  while (end > 0) {
    try {
      decoder.decode(bytes.subarray(0, end));
      return bytes.subarray(0, end);
    } catch {
      end -= 1;
    }
  }
  return bytes.subarray(0, 0);
}

function objectReference(sessionId: string, sha256: string): string {
  return `artifacts/${sessionId}/objects/${sha256}`;
}

export class ArtifactStore {
  readonly budgets: ArtifactBudgets;
  readonly sessionId: string;
  readonly workspace: string;
  private gate: Promise<void> = Promise.resolve();
  private readonly paths: ArtifactPaths;
  private readonly runBytes: Map<string, number>;
  private sessionBytes: number;

  private constructor(
    options: ArtifactStoreOptions,
    paths: ArtifactPaths,
    budgets: ArtifactBudgets,
    usage: { readonly runBytes: Map<string, number>; readonly sessionBytes: number },
  ) {
    this.budgets = budgets;
    this.paths = paths;
    this.runBytes = usage.runBytes;
    this.sessionBytes = usage.sessionBytes;
    this.sessionId = options.sessionId;
    this.workspace = paths.workspace;
  }

  static async create(options: ArtifactStoreOptions): Promise<ArtifactStore> {
    assertCanonicalSessionId(options.sessionId);
    if (!isAbsolute(options.workspace)) {
      throw new ArtifactError(
        "artifact_path_unsafe",
        "artifact workspace must be an absolute path",
      );
    }
    // Reuse the Phase 9 component-by-component policy: Windows may spell the
    // same real directory through an 8.3 alias, while links/junctions still
    // fail closed before artifact directories are prepared.
    const workspace = (
      await SessionPathPolicy.create(options.workspace)
    ).workspaceRealPath;
    const agentDirectory = join(workspace, ".bornagent");
    const artifactRoot = join(agentDirectory, "artifacts");
    const sessionDirectory = join(artifactRoot, options.sessionId);
    const objectDirectory = join(sessionDirectory, "objects");
    for (const path of [
      agentDirectory,
      artifactRoot,
      sessionDirectory,
      objectDirectory,
    ]) {
      await ensurePrivateDirectory(workspace, path);
    }
    const budgets = validateBudgets(options);
    const usage = validateInitialUsage(options.initialUsage, budgets);
    return new ArtifactStore(
      options,
      { artifactRoot, objectDirectory, sessionDirectory, workspace },
      budgets,
      usage,
    );
  }

  availableCaptureBytes(runId: string, requestedBytes = this.budgets.perArtifactBytes): number {
    assertCanonicalSessionId(runId);
    if (
      !Number.isSafeInteger(requestedBytes) ||
      requestedBytes < 1 ||
      requestedBytes > MAX_ARTIFACT_CAPTURE_BYTES
    ) {
      throw new ArtifactError(
        "artifact_limit_invalid",
        "artifact capture limit must be a positive safe integer at most 16 MiB",
      );
    }
    return Math.max(
      0,
      Math.min(
        requestedBytes,
        this.budgets.perArtifactBytes,
        this.budgets.perRunBytes - (this.runBytes.get(runId) ?? 0),
        this.budgets.perSessionBytes - this.sessionBytes,
      ),
    );
  }

  usage(): { readonly runBytes: Readonly<Record<string, number>>; readonly sessionBytes: number } {
    return Object.freeze({
      runBytes: Object.freeze(Object.fromEntries(this.runBytes)),
      sessionBytes: this.sessionBytes,
    });
  }

  async storeSanitizedText(
    input: StoreSanitizedTextInput,
  ): Promise<ArtifactStoreCaptureResult> {
    return this.exclusive(async () => this.storeExclusive(input));
  }

  async readVerified(artifactId: string): Promise<{
    readonly bytes: Buffer;
    readonly metadata: ArtifactObjectMetadata;
    readonly objectRef: string;
  }> {
    const { sha256 } = parseArtifactId(artifactId);
    await this.assertDirectoriesSafe();
    const objectPath = join(this.paths.objectDirectory, sha256);
    const metadataPath = `${objectPath}.meta.json`;
    let metadataBytes: Buffer;
    let objectSize: number;
    try {
      objectSize = await this.assertRegularFile(objectPath);
      const metadataSize = await this.assertRegularFile(metadataPath);
      if (objectSize > MAX_ARTIFACT_CAPTURE_BYTES) {
        throw new ArtifactError(
          "artifact_corrupt",
          "artifact object exceeds the supported content bound",
        );
      }
      if (metadataSize > 4_096) {
        throw new ArtifactError(
          "artifact_metadata_corrupt",
          "artifact content metadata exceeds its fixed bound",
        );
      }
      metadataBytes = await readFile(metadataPath);
      if (metadataBytes.byteLength > 4_096) {
        throw new ArtifactError(
          "artifact_metadata_corrupt",
          "artifact content metadata exceeds its fixed bound",
        );
      }
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        throw new ArtifactError(
          "artifact_missing",
          "artifact object or metadata is missing",
        );
      }
      if (error instanceof ArtifactError) throw error;
      throw new ArtifactError(
        "artifact_missing",
        "artifact object or metadata could not be read",
        { cause: error },
      );
    }
    let metadata: ArtifactObjectMetadata;
    try {
      const value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(metadataBytes),
      ) as unknown;
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "bytes,schema_version,sha256"
      ) {
        throw new Error("invalid metadata shape");
      }
      const record = value as Record<string, unknown>;
      if (
        record.schema_version !== 1 ||
        record.sha256 !== sha256 ||
        !Number.isSafeInteger(record.bytes) ||
        (record.bytes as number) < 0 ||
        (record.bytes as number) > MAX_ARTIFACT_CAPTURE_BYTES
      ) {
        throw new Error("invalid metadata fields");
      }
      metadata = {
        bytes: record.bytes as number,
        schema_version: 1,
        sha256,
      };
    } catch (error) {
      throw new ArtifactError(
        "artifact_metadata_corrupt",
        "artifact content metadata is invalid",
        { cause: error },
      );
    }
    if (objectSize !== metadata.bytes) {
      throw new ArtifactError(
        "artifact_corrupt",
        "artifact size does not match content metadata",
      );
    }
    const bytes = await readFile(objectPath);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== metadata.bytes || actualHash !== sha256) {
      throw new ArtifactError(
        "artifact_corrupt",
        "artifact bytes do not match content metadata",
      );
    }
    return {
      bytes,
      metadata: Object.freeze(metadata),
      objectRef: objectReference(this.sessionId, sha256),
    };
  }

  private async storeExclusive(
    input: StoreSanitizedTextInput,
  ): Promise<ArtifactStoreCaptureResult> {
    assertCanonicalSessionId(input.runId);
    const requested = input.maximumBytes ?? this.budgets.perArtifactBytes;
    const available = this.availableCaptureBytes(input.runId, requested);
    if (available === 0) {
      return Object.freeze({
        artifact: null,
        captureStatus: "budget_exhausted" as const,
        captureTruncated: true,
        capturedBytes: 0,
      });
    }
    await this.assertDirectoriesSafe();
    const temporaryPath = join(
      this.paths.objectDirectory,
      `.capture.${randomUUID()}.tmp`,
    );
    let handle: FileHandle | undefined;
    let capturedBytes = 0;
    let sourceTruncated = false;
    const hash = createHash("sha256");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      for await (const chunk of input.chunks) {
        let text: string;
        try {
          text = decoder.decode(chunk, { stream: true });
        } catch (error) {
          throw new ArtifactError(
            "artifact_source_invalid_utf8",
            "sanitized artifact chunks must be valid UTF-8 text",
            { cause: error },
          );
        }
        if (text.length === 0) continue;
        const encoded = Buffer.from(text, "utf8");
        const remaining = available - capturedBytes;
        if (encoded.byteLength > remaining) {
          const accepted = utf8Prefix(encoded, remaining);
          await writeAll(handle, accepted);
          hash.update(accepted);
          capturedBytes += accepted.byteLength;
          sourceTruncated = true;
          break;
        }
        await writeAll(handle, encoded);
        hash.update(encoded);
        capturedBytes += encoded.byteLength;
      }
      if (!sourceTruncated) {
        let remainder: string;
        try {
          remainder = decoder.decode();
        } catch (error) {
          throw new ArtifactError(
            "artifact_source_invalid_utf8",
            "sanitized artifact ended inside an invalid UTF-8 sequence",
            { cause: error },
          );
        }
        const encoded = Buffer.from(remainder, "utf8");
        const remaining = available - capturedBytes;
        if (encoded.byteLength > remaining) {
          const accepted = utf8Prefix(encoded, remaining);
          await writeAll(handle, accepted);
          hash.update(accepted);
          capturedBytes += accepted.byteLength;
          sourceTruncated = true;
        } else {
          await writeAll(handle, encoded);
          hash.update(encoded);
          capturedBytes += encoded.byteLength;
        }
      }
      await handle.sync();
      if (process.platform !== "win32") await handle.chmod(0o600);
      await handle.close();
      handle = undefined;

      const sha256 = hash.digest("hex");
      await this.verifyFile(temporaryPath, sha256, capturedBytes);
      const objectPath = join(this.paths.objectDirectory, sha256);
      let deduplicated = false;
      try {
        await this.verifyFile(objectPath, sha256, capturedBytes);
        deduplicated = true;
        await unlink(temporaryPath);
      } catch (error) {
        if (!isErrorCode(error, "ENOENT")) throw error;
        await rename(temporaryPath, objectPath);
      }
      // PHASE10: temp+sync+rename prevents a visible partial object, but it does
      // not prove the final pathname still contains the expected bytes. Hash and
      // size readback after rename is the authority before any ref can escape.
      await this.verifyFile(objectPath, sha256, capturedBytes);
      await this.persistMetadata(sha256, capturedBytes);
      await this.readVerified(`sha256:${sha256}`);

      const captureStatus = sourceTruncated
        ? this.captureStatus(input.runId, requested, available)
        : "complete";
      this.sessionBytes += capturedBytes;
      this.runBytes.set(
        input.runId,
        (this.runBytes.get(input.runId) ?? 0) + capturedBytes,
      );
      return Object.freeze({
        artifact: Object.freeze({
          artifactId: `sha256:${sha256}`,
          bytes: capturedBytes,
          deduplicated,
          objectRef: objectReference(this.sessionId, sha256),
          sha256,
        }),
        captureStatus,
        captureTruncated: sourceTruncated,
        capturedBytes,
      });
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      if (error instanceof ArtifactError) throw error;
      throw new ArtifactError(
        "artifact_persist_failed",
        "artifact capture could not be persisted durably",
        { cause: error },
      );
    }
  }

  private captureStatus(
    runId: string,
    requested: number,
    available: number,
  ): ArtifactCaptureStatus {
    const sessionRemaining = this.budgets.perSessionBytes - this.sessionBytes;
    const runRemaining =
      this.budgets.perRunBytes - (this.runBytes.get(runId) ?? 0);
    if (sessionRemaining === available && sessionRemaining < requested) {
      return "truncated_session_budget";
    }
    if (runRemaining === available && runRemaining < requested) {
      return "truncated_run_budget";
    }
    return "truncated_artifact_limit";
  }

  private async persistMetadata(sha256: string, bytes: number): Promise<void> {
    const metadataPath = join(this.paths.objectDirectory, `${sha256}.meta.json`);
    const encoded = Buffer.from(
      JSON.stringify({ bytes, schema_version: 1, sha256 }),
      "utf8",
    );
    try {
      const existingSize = await this.assertRegularFile(metadataPath);
      if (existingSize > 4_096) {
        throw new ArtifactError(
          "artifact_metadata_corrupt",
          "existing artifact metadata exceeds its fixed bound",
        );
      }
      const existing = await readFile(metadataPath);
      if (!existing.equals(encoded)) {
        throw new ArtifactError(
          "artifact_metadata_corrupt",
          "existing artifact metadata conflicts with content identity",
        );
      }
      return;
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
    }
    const temporaryPath = join(
      this.paths.objectDirectory,
      `.metadata.${randomUUID()}.tmp`,
    );
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await writeAll(handle, encoded);
      await handle.sync();
      if (process.platform !== "win32") await handle.chmod(0o600);
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, metadataPath);
      await this.assertRegularFile(metadataPath);
      if (!(await readFile(metadataPath)).equals(encoded)) {
        throw new ArtifactError(
          "artifact_metadata_corrupt",
          "artifact metadata failed readback verification",
        );
      }
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  private async verifyFile(
    path: string,
    expectedSha256: string,
    expectedBytes: number,
  ): Promise<void> {
    const size = await this.assertRegularFile(path);
    if (size !== expectedBytes || size > MAX_ARTIFACT_CAPTURE_BYTES) {
      throw new ArtifactError(
        "artifact_corrupt",
        "artifact object failed size verification",
      );
    }
    const bytes = await readFile(path);
    if (
      bytes.byteLength !== expectedBytes ||
      createHash("sha256").update(bytes).digest("hex") !== expectedSha256
    ) {
      throw new ArtifactError(
        "artifact_corrupt",
        "artifact object failed hash/size verification",
      );
    }
  }

  private async assertDirectoriesSafe(): Promise<void> {
    for (const path of [
      this.paths.artifactRoot,
      this.paths.sessionDirectory,
      this.paths.objectDirectory,
    ]) {
      const metadata = await lstat(path);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isDirectory() ||
        platformPath(await realpath(path)) !== platformPath(path)
      ) {
        throw new ArtifactError(
          "artifact_path_unsafe",
          "artifact storage directory identity changed",
        );
      }
    }
  }

  private async assertRegularFile(path: string): Promise<number> {
    if (!isContained(this.paths.objectDirectory, path)) {
      throw new ArtifactError(
        "artifact_path_unsafe",
        "artifact object path escapes its object directory",
      );
    }
    const metadata = await lstat(path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      platformPath(await realpath(path)) !== platformPath(path)
    ) {
      throw new ArtifactError(
        "artifact_path_unsafe",
        "artifact object must be a canonical regular file",
      );
    }
    return metadata.size;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.gate;
    let release: (() => void) | undefined;
    this.gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}
