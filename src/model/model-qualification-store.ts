import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

import { parseStrictJson } from "../system/strict-json.js";
import {
  modelQualificationRecordSchema,
  type ModelQualificationRecordV1,
} from "./model-qualification-schema.js";
import { modelQualificationIdentitySha256 } from "./model-qualification-identity.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_RECORD_BYTES = 1024 * 1024;

export class ModelQualificationStoreError extends Error {
  override readonly name = "ModelQualificationStoreError";

  constructor(
    readonly code:
      | "qualification_record_corrupt"
      | "qualification_record_missing"
      | "qualification_store_path_unsafe",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function resolveModelQualificationStoreRoot(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
}): string {
  if (input.platform === "win32") {
    return join(
      input.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "BornAgent",
      "model-capabilities",
      "v1",
    );
  }
  return join(
    input.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "bornagent",
    "model-capabilities",
    "v1",
  );
}

async function assertSafeExistingComponents(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const relative = absolute.slice(root.length).split(/[\\/]+/u).filter(Boolean);
  let current = root;
  for (const component of relative) {
    current = join(current, component);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new ModelQualificationStoreError(
          "qualification_store_path_unsafe",
          "qualification store cannot traverse symbolic links or reparse aliases",
        );
      }
      if (current !== absolute && !metadata.isDirectory()) {
        throw new ModelQualificationStoreError(
          "qualification_store_path_unsafe",
          "qualification store parent is not a directory",
        );
      }
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
  }
}

async function writeComplete(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      offset,
    );
    if (result.bytesWritten <= 0) throw new Error("qualification record write stalled");
    offset += result.bytesWritten;
  }
}

export class ModelQualificationStore {
  private constructor(
    readonly root: string,
    private readonly platform: NodeJS.Platform,
  ) {}

  static async create(input: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly platform?: NodeJS.Platform;
    readonly root?: string;
  } = {}): Promise<ModelQualificationStore> {
    const platform = input.platform ?? process.platform;
    const root = resolve(
      input.root ??
        resolveModelQualificationStoreRoot({ env: input.env ?? process.env, platform }),
    );
    await assertSafeExistingComponents(root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await assertSafeExistingComponents(root);
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new ModelQualificationStoreError(
        "qualification_store_path_unsafe",
        "qualification store root is not a safe directory",
      );
    }
    return new ModelQualificationStore(root, platform);
  }

  pathFor(identitySha256: string): string {
    if (!SHA256.test(identitySha256)) {
      throw new TypeError("qualification identity hash must be lowercase SHA-256");
    }
    return join(this.root, `${identitySha256}.json`);
  }

  async read(identitySha256: string): Promise<ModelQualificationRecordV1 | null> {
    const path = this.pathFor(identitySha256);
    let bytes: Buffer;
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_RECORD_BYTES) {
        throw new ModelQualificationStoreError(
          "qualification_record_corrupt",
          "qualification record is not a bounded regular file",
        );
      }
      bytes = await readFile(path);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const record = modelQualificationRecordSchema.parse(parseStrictJson(text));
      if (
        record.identitySha256 !== identitySha256 ||
        modelQualificationIdentitySha256(record.identity) !== identitySha256
      ) {
        throw new Error("qualification identity hash does not match its file");
      }
      return Object.freeze(record);
    } catch (error) {
      throw new ModelQualificationStoreError(
        "qualification_record_corrupt",
        "qualification record failed strict decoding or hash verification",
        { cause: error },
      );
    }
  }

  async commit(recordInput: ModelQualificationRecordV1): Promise<void> {
    const record = modelQualificationRecordSchema.parse(recordInput);
    if (modelQualificationIdentitySha256(record.identity) !== record.identitySha256) {
      throw new ModelQualificationStoreError(
        "qualification_record_corrupt",
        "qualification record identity hash does not match",
      );
    }
    const target = this.pathFor(record.identitySha256);
    const existing = await this.read(record.identitySha256);
    if (existing !== null && existing.identitySha256 !== record.identitySha256) {
      throw new ModelQualificationStoreError(
        "qualification_record_corrupt",
        "existing qualification record has the wrong identity",
      );
    }
    const temporary = join(
      this.root,
      `.${record.identitySha256}.${randomUUID()}.tmp`,
    );
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (bytes.byteLength > MAX_RECORD_BYTES) {
      throw new ModelQualificationStoreError(
        "qualification_record_corrupt",
        "qualification record exceeds the storage bound",
      );
    }
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await writeComplete(handle, bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
      await this.syncDirectory();
      const verified = await this.read(record.identitySha256);
      if (verified?.evidenceSha256 !== record.evidenceSha256) {
        throw new ModelQualificationStoreError(
          "qualification_record_corrupt",
          "qualification record reread did not match the committed evidence",
        );
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  async remove(identitySha256: string): Promise<boolean> {
    const existing = await this.read(identitySha256);
    if (existing === null) return false;
    await unlink(this.pathFor(identitySha256));
    await this.syncDirectory();
    return (await this.read(identitySha256)) === null;
  }

  private async syncDirectory(): Promise<void> {
    if (this.platform === "win32") return;
    const handle = await open(dirname(this.pathFor("0".repeat(64))), "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
