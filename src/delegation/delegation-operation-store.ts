import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { parseStrictJson } from "../system/strict-json.js";
import { DelegationError } from "./delegation-errors.js";
import {
  createDelegationChildOperation,
  delegationChildOperationSchema,
  type DelegationChildOperationV1,
} from "./delegation-operation-schema.js";

function revisionName(revision: number): string {
  return `${String(revision).padStart(8, "0")}.json`;
}

export class DelegationOperationStore {
  private constructor(
    private readonly directory: string,
    readonly operationId: string,
  ) {}

  static async create(input: { readonly root: string; readonly operationId: string }): Promise<DelegationOperationStore> {
    if (!/^[0-9a-f-]{36}$/u.test(input.operationId)) {
      throw new DelegationError("delegation_child_protocol_invalid", "operation ID is invalid");
    }
    const directory = resolve(input.root, "delegations", "operations", "v1", input.operationId);
    await mkdir(directory, { recursive: true });
    return new DelegationOperationStore(directory, input.operationId);
  }

  static async openExisting(input: { readonly root: string; readonly operationId: string }): Promise<DelegationOperationStore> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(input.operationId)) {
      throw new DelegationError("delegation_child_protocol_invalid", "operation ID is invalid");
    }
    const directory = resolve(input.root, "delegations", "operations", "v1", input.operationId);
    try {
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new DelegationError("delegation_child_protocol_invalid", "operation journal path is unsafe");
      }
    } catch (error) {
      if (error instanceof DelegationError) throw error;
      throw new DelegationError("delegation_child_protocol_invalid", "operation journal is unavailable", { cause: error });
    }
    return new DelegationOperationStore(directory, input.operationId);
  }

  static async listExisting(root: string): Promise<readonly DelegationOperationStore[]> {
    const directory = resolve(root, "delegations", "operations", "v1");
    let names: readonly string[];
    try {
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new DelegationError("delegation_child_protocol_invalid", "operation journal root is unsafe");
      }
      names = await readdir(directory);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
      if (error instanceof DelegationError) throw error;
      throw new DelegationError("delegation_child_protocol_invalid", "operation journal root is unavailable", { cause: error });
    }
    const stores: DelegationOperationStore[] = [];
    for (const operationId of [...names].sort()) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(operationId)) continue;
      stores.push(await DelegationOperationStore.openExisting({ operationId, root }));
    }
    return Object.freeze(stores);
  }

  async initialize(operation: DelegationChildOperationV1): Promise<void> {
    if (operation.operationId !== this.operationId || operation.revision !== 1) {
      throw new DelegationError("delegation_child_protocol_invalid", "initial operation identity is inconsistent");
    }
    await this.#createRevision(operation);
  }

  async read(): Promise<DelegationChildOperationV1 | null> {
    const names = (await readdir(this.directory)).filter((name) => /^[0-9]{8}\.json$/u.test(name)).sort();
    const latest = names.at(-1);
    if (latest === undefined) return null;
    let handle;
    try {
      handle = await open(join(this.directory, latest), "r");
      const statBefore = await handle.stat();
      if (!statBefore.isFile() || statBefore.size < 1 || statBefore.size > 64 * 1024) {
        throw new DelegationError("delegation_child_protocol_invalid", "operation journal revision is not a bounded regular file");
      }
      const bytes = await handle.readFile();
      const statAfter = await handle.stat();
      if (statBefore.size !== statAfter.size || statBefore.mtimeMs !== statAfter.mtimeMs) {
        throw new DelegationError("delegation_child_protocol_invalid", "operation journal changed while being read");
      }
      return Object.freeze(delegationChildOperationSchema.parse(parseStrictJson(bytes.toString("utf8"))));
    } catch (error) {
      if (error instanceof DelegationError) throw error;
      throw new DelegationError("delegation_child_protocol_invalid", "operation journal is missing or corrupt", { cause: error });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async compareAndSwap(input: {
    readonly expectedSha256: string;
    readonly expectedState: DelegationChildOperationV1["state"];
    readonly now: string;
    readonly mutate: (current: DelegationChildOperationV1) => Omit<DelegationChildOperationV1, "operationSha256">;
  }): Promise<DelegationChildOperationV1> {
    const current = await this.read();
    if (
      current === null ||
      current.operationSha256 !== input.expectedSha256 ||
      current.state !== input.expectedState
    ) {
      throw new DelegationError("delegation_lease_busy", "operation journal compare-and-swap lost ownership");
    }
    const mutated = input.mutate(current);
    const content = { ...mutated };
    Reflect.deleteProperty(content, "operationSha256");
    const next = createDelegationChildOperation({
      ...content,
      operationId: current.operationId,
      revision: current.revision + 1,
      schemaVersion: 1,
      updatedAt: input.now,
    });
    await this.#createRevision(next);
    return next;
  }

  async storePayload(
    kind: "capsule" | "envelope" | "result",
    bytes: Uint8Array,
    expectedSha256: string,
  ): Promise<string> {
    if (bytes.byteLength < 1 || bytes.byteLength > 512 * 1024 || createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
      throw new DelegationError("delegation_artifact_invalid", "operation payload bytes do not match their bounded identity");
    }
    const path = join(this.directory, `${kind}.${expectedSha256}.json`);
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      try {
        const existing = await readFile(path);
        if (existing.equals(Buffer.from(bytes))) return path;
      } catch {
        // Report the original durable-create failure below.
      }
      throw new DelegationError("delegation_artifact_invalid", "operation payload could not be committed exactly", { cause: error });
    } finally {
      await handle?.close().catch(() => undefined);
    }
    return path;
  }

  async #createRevision(operation: DelegationChildOperationV1): Promise<void> {
    let handle;
    try {
      handle = await open(join(this.directory, revisionName(operation.revision)), "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(operation)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      throw new DelegationError("delegation_lease_busy", "operation journal revision already exists or could not be committed", { cause: error });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}
