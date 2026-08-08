import {
  appendFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import {
  CAPABILITY_STORE_RECORD_PATH,
  StablePackageReader,
} from "../capabilities/stable-package-reader.js";
import type { StableCapabilityPackage } from "../capabilities/capability-types.js";
import { parseStrictJson } from "../system/strict-json.js";
import { PluginLifecycleError } from "./plugin-errors.js";
import {
  capabilityLeaseRecordSchema,
  exactPluginSelector,
  installedPluginIndexSchema,
  installedPluginRecordSchema,
  pluginAuditEventSchema,
  pluginEnablementStateSchema,
  pluginOperationRecordSchema,
  type InstalledPluginIndexV1,
  type InstalledPluginRecordV1,
  type PluginAuditEventV1,
  type PluginEnablementStateV1,
} from "./plugin-state-schema.js";

const MAX_STATE_BYTES = 1024 * 1024;
const EXACT_SELECTOR = /^user_install:([a-z0-9](?:[a-z0-9]|[._-](?=[a-z0-9])){0,79})@([A-Za-z0-9](?:[A-Za-z0-9]|[._-](?=[A-Za-z0-9])){0,63})#sha256:([a-f0-9]{64})$/u;

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Readonly<Record<string, unknown>>)) deepFreeze(child);
  return Object.freeze(value);
}

function inside(root: string, candidate: string): boolean {
  const delta = relative(resolve(root), resolve(candidate));
  return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
}

function stateDefaults(): {
  readonly enablement: PluginEnablementStateV1;
  readonly installed: InstalledPluginIndexV1;
} {
  return {
    enablement: { packages: [], revision: 0, schema_version: 1 },
    installed: { plugins: [], revision: 0, schema_version: 1 },
  };
}

async function readJsonState<T>(
  path: string,
  parse: (value: unknown) => T,
  fallback: T,
): Promise<T> {
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_STATE_BYTES) {
      throw new PluginLifecycleError("plugin_store_corrupt", "plugin state is not a bounded unique regular file");
    }
    const bytes = await readFile(path);
    const after = await lstat(path);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.byteLength !== after.size
    ) {
      throw new PluginLifecycleError("plugin_store_busy", "plugin state changed while it was read");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return deepFreeze(parse(parseStrictJson(text)));
  } catch (error) {
    if (isMissing(error)) return deepFreeze(fallback);
    if (error instanceof PluginLifecycleError) throw error;
    throw new PluginLifecycleError("plugin_store_corrupt", "plugin state failed strict validation", 1, { cause: error });
  }
}

async function fsyncPath(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch {
    // Directory fsync is not uniformly available on Windows. File handles are
    // still synced before rename and the rename remains same-filesystem.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function atomicJson(path: string, value: unknown, operationId: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${operationId}.tmp`);
  const bytes = `${canonicalJson(value)}\n`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await fsyncPath(dirname(path));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

interface StateLock {
  readonly nonce: string;
  release(): Promise<void>;
}

export interface PluginInspectionV1 {
  readonly components: readonly Readonly<Record<string, unknown>>[];
  readonly inspectionId: string;
  readonly inventorySha256: string;
  readonly manifestSha256: string;
  readonly pluginId: string;
  readonly pluginSha256: string;
  readonly pluginVersion: string;
  readonly requestedEffects: readonly string[];
  readonly schemaVersion: 1;
  readonly sourceDisplayName: string;
  readonly sourceSnapshotSha256: string;
  readonly status: "valid_schema";
  readonly warnings: readonly string[];
}

export interface PluginMutationResultV1 {
  readonly afterRevision: number;
  readonly beforeRevision: number;
  readonly changed: boolean;
  readonly deduplicated: boolean;
  readonly exactSelector: string;
  readonly operation: "disable" | "enable" | "install" | "remove";
  readonly operationId: string;
  readonly pendingNextRun: boolean;
  readonly retainedContent: boolean;
  readonly schemaVersion: 1;
  readonly warnings: readonly string[];
}

export interface PluginListEntryV1 {
  readonly enabled: boolean;
  readonly exactSelector: string;
  readonly installedAt: string;
  readonly pluginId: string;
  readonly pluginSha256: string;
  readonly pluginVersion: string;
  readonly retainedContent: boolean;
  readonly source: "user_install";
}

export interface CapabilityContentLease {
  readonly leaseId: string;
  readonly pluginSha256: string;
  readonly runId: string;
  release(): Promise<void>;
}

export interface PluginLifecycleLike {
  acquireLeases(pluginSha256s: readonly string[], runId: string): Promise<readonly CapabilityContentLease[]>;
  disable(selector: string): Promise<PluginMutationResultV1>;
  doctor(): Promise<Readonly<Record<string, unknown>>>;
  enable(selector: string): Promise<PluginMutationResultV1>;
  inspect(source: string): Promise<PluginInspectionV1>;
  install(source: string, expectedSha256?: string): Promise<PluginMutationResultV1>;
  list(filter?: "all" | "enabled" | "installed"): Promise<readonly PluginListEntryV1[]>;
  remove(selector: string): Promise<PluginMutationResultV1>;
  show(selector: string): Promise<PluginListEntryV1>;
}

export class PluginLifecycle implements PluginLifecycleLike {
  readonly #root: string;

  constructor(private readonly options: {
    readonly isProcessAlive: (pid: number) => boolean;
    readonly now: () => string;
    readonly randomUUID: () => string;
    readonly root: string;
    readonly workspace: string;
  }) {
    this.#root = resolve(options.root);
  }

  #paths() {
    return {
      audit: join(this.#root, "audit", "v1", "events.jsonl"),
      enablement: join(this.#root, "enablement", "v1", "state.json"),
      installed: join(this.#root, "indexes", "v1", "installed.json"),
      leases: join(this.#root, "leases", "v1"),
      lock: join(this.#root, "locks", "capability-state.lock"),
      operations: join(this.#root, "tmp", "operations"),
      store: join(this.#root, "store", "v1", "sha256"),
      tmp: join(this.#root, "tmp"),
    } as const;
  }

  async #ensureLayout(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    const rootMetadata = await lstat(this.#root);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new PluginLifecycleError(
        "plugin_store_corrupt",
        "Plugin user-state root must be a non-link directory",
      );
    }
    const targets = [
      "audit/v1",
      "enablement/v1",
      "indexes/v1",
      "leases/v1",
      "locks",
      "store/v1/sha256",
      "tmp/operations",
    ];
    for (const target of targets) {
      let cursor = this.#root;
      for (const segment of target.split("/")) {
        cursor = join(cursor, segment);
        try {
          const metadata = await lstat(cursor);
          if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
            throw new PluginLifecycleError(
              "plugin_store_corrupt",
              "Plugin state layout contains a link or non-directory entry",
            );
          }
        } catch (error) {
          if (!isMissing(error)) throw error;
          try {
            await mkdir(cursor, { recursive: false });
          } catch (createError) {
            if (!isExists(createError)) throw createError;
            const metadata = await lstat(cursor);
            if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
              throw new PluginLifecycleError(
                "plugin_store_corrupt",
                "Plugin state layout raced with a non-directory entry",
              );
            }
          }
        }
      }
    }
  }

  async #acquireLock(): Promise<StateLock> {
    const paths = this.#paths();
    await this.#ensureLayout();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const nonce = this.options.randomUUID();
      try {
        const handle = await open(paths.lock, "wx");
        try {
          await handle.writeFile(`${canonicalJson({
            created_at: this.options.now(),
            nonce,
            pid: process.pid,
            schema_version: 1,
          })}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        let released = false;
        return Object.freeze({
          nonce,
          release: async () => {
            if (released) return;
            released = true;
            try {
              const current = parseStrictJson(await readFile(paths.lock, "utf8")) as Record<string, unknown>;
              if (current.nonce !== nonce) {
                throw new PluginLifecycleError("plugin_store_busy", "capability-state lock ownership changed");
              }
              await unlink(paths.lock);
            } catch (error) {
              if (!isMissing(error)) throw error;
            }
          },
        });
      } catch (error) {
        if (!isExists(error)) throw error;
        try {
          const current = parseStrictJson(await readFile(paths.lock, "utf8")) as Record<string, unknown>;
          const pid = current.pid;
          const currentNonce = current.nonce;
          if (
            typeof pid !== "number" ||
            !Number.isInteger(pid) ||
            pid <= 0 ||
            typeof currentNonce !== "string" ||
            this.options.isProcessAlive(pid)
          ) {
            await new Promise((resolveWait) => setTimeout(resolveWait, 25));
            continue;
          }
          await rename(paths.lock, join(dirname(paths.lock), `stale-${currentNonce}.lock`));
        } catch (readError) {
          if (!isMissing(readError)) {
            await new Promise((resolveWait) => setTimeout(resolveWait, 25));
          }
        }
      }
    }
    throw new PluginLifecycleError("plugin_store_busy", "capability-state lock is held by another live process");
  }

  async #states(): Promise<{
    readonly enablement: PluginEnablementStateV1;
    readonly installed: InstalledPluginIndexV1;
  }> {
    const paths = this.#paths();
    const defaults = stateDefaults();
    const [enablement, installed] = await Promise.all([
      readJsonState(paths.enablement, (value) => pluginEnablementStateSchema.parse(value), defaults.enablement),
      readJsonState(paths.installed, (value) => installedPluginIndexSchema.parse(value), defaults.installed),
    ]);
    return { enablement, installed };
  }

  #sourcePath(source: string): string {
    if (
      source.startsWith("http:") ||
      source.startsWith("https:") ||
      source.startsWith("git:") ||
      source.startsWith("file:") ||
      source.startsWith("\\\\") ||
      source.startsWith("//")
    ) {
      throw new PluginLifecycleError("plugin_source_invalid", "only a local non-UNC directory may be inspected or installed");
    }
    const path = resolve(this.options.workspace, source);
    if (inside(this.#root, path)) {
      throw new PluginLifecycleError("plugin_source_invalid", "the user capability store cannot be used as an install source");
    }
    return path;
  }

  async #readSource(source: string): Promise<StableCapabilityPackage> {
    try {
      return await StablePackageReader.read(this.#sourcePath(source));
    } catch (error) {
      if (error instanceof PluginLifecycleError) throw error;
      throw new PluginLifecycleError("plugin_install_invalid", "local Plugin package failed stable validation", 2, { cause: error });
    }
  }

  async inspect(source: string): Promise<PluginInspectionV1> {
    const stable = await this.#readSource(source);
    const requestedEffects = [...new Set(stable.components.flatMap((component) => component.requestedEffects))].sort();
    const warnings = [
      ...(requestedEffects.length === 0 ? [] : [`requested_effects:${requestedEffects.join(",")}`]),
      ...stable.components
        .filter((component) =>
          component.kind === "mcp_server" ||
          (component.kind === "hook" && component.metadata.kind === "hook" && component.metadata.handler.type === "command")
        )
        .map((component) => `contains_external_process:${component.kind}/${component.componentId}`),
    ].sort();
    return deepFreeze({
      components: stable.components.map((component) => ({
        componentId: component.componentId,
        componentSha256: component.componentSha256,
        kind: component.kind,
        requestedEffects: component.requestedEffects,
      })),
      inspectionId: sha256Canonical({
        inventorySha256: stable.inventorySha256,
        pluginSha256: stable.pluginSha256,
        schemaVersion: 1,
      }),
      inventorySha256: stable.inventorySha256,
      manifestSha256: stable.manifestSha256,
      pluginId: stable.pluginId,
      pluginSha256: stable.pluginSha256,
      pluginVersion: stable.pluginVersion,
      requestedEffects,
      schemaVersion: 1,
      sourceDisplayName: basename(stable.packageRoot),
      sourceSnapshotSha256: stable.pluginSha256,
      status: "valid_schema",
      warnings,
    });
  }

  async #operation(
    operation: "install" | "enable" | "disable" | "remove",
    pluginSha256?: string,
  ): Promise<{ readonly id: string; complete(): Promise<void> }> {
    const id = this.options.randomUUID();
    const path = join(this.#paths().operations, `${id}.json`);
    await mkdir(dirname(path), { recursive: true });
    const base = {
      operation,
      operation_id: id,
      ...(pluginSha256 === undefined ? {} : { plugin_sha256: pluginSha256 }),
      requested_at: this.options.now(),
      schema_version: 1 as const,
    };
    await atomicJson(path, pluginOperationRecordSchema.parse({ ...base, state: "requested" }), id);
    return Object.freeze({
      id,
      complete: async () => atomicJson(
        path,
        pluginOperationRecordSchema.parse({ ...base, state: "completed" }),
        this.options.randomUUID(),
      ),
    });
  }

  async #appendAudit(event: PluginAuditEventV1): Promise<void> {
    const parsed = pluginAuditEventSchema.parse(event);
    const path = this.#paths().audit;
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${canonicalJson(parsed)}\n`, { encoding: "utf8", flag: "a" });
    await fsyncPath(path);
  }

  #audit(
    operationId: string,
    operation: PluginAuditEventV1["operation"],
    record: InstalledPluginRecordV1,
    previous: number,
    next: number,
    result: PluginAuditEventV1["result"],
  ): PluginAuditEventV1 {
    return pluginAuditEventSchema.parse({
      event_id: this.options.randomUUID(),
      next_enablement_revision: next,
      occurred_at: this.options.now(),
      operation,
      operation_id: operationId,
      plugin: {
        plugin_id: record.pluginId,
        plugin_sha256: record.pluginSha256,
        plugin_version: record.pluginVersion,
        source: "user_install",
      },
      previous_enablement_revision: previous,
      result,
      schema_version: 1,
    });
  }

  async #verifyStore(entry: InstalledPluginIndexV1["plugins"][number]): Promise<void> {
    const path = resolve(this.#root, ...entry.store_relative_path.split("/"));
    if (!inside(this.#paths().store, path)) {
      throw new PluginLifecycleError("plugin_store_corrupt", "installed index path escapes the content-addressed store");
    }
    try {
      const stable = await StablePackageReader.read(path);
      if (
        stable.pluginSha256 !== entry.record.pluginSha256 ||
        stable.pluginId !== entry.record.pluginId ||
        stable.pluginVersion !== entry.record.pluginVersion ||
        stable.inventorySha256 !== entry.record.inventorySha256 ||
        stable.manifestSha256 !== entry.record.manifestSha256
      ) {
        throw new Error("stored bytes do not match installed identity");
      }
    } catch (error) {
      throw new PluginLifecycleError("plugin_tampered", "installed Plugin bytes no longer match their exact identity", 8, { cause: error });
    }
  }

  async doctor(): Promise<Readonly<Record<string, unknown>>> {
    const states = await this.#states();
    await Promise.all(states.installed.plugins.map((entry) => this.#verifyStore(entry)));
    for (const enabled of states.enablement.packages) {
      const installed = states.installed.plugins.find((entry) =>
        entry.record.pluginSha256 === enabled.expected_plugin_sha256 &&
        entry.record.pluginId === enabled.plugin_id &&
        entry.record.pluginVersion === enabled.plugin_version &&
        entry.store_relative_path === enabled.path
      );
      if (installed === undefined) {
        throw new PluginLifecycleError(
          "plugin_enablement_stale",
          "enablement references an absent or mismatched installed Plugin",
        );
      }
    }
    const paths = this.#paths();
    let auditEvents: PluginAuditEventV1[] = [];
    try {
      const bytes = await readFile(paths.audit);
      if (bytes.byteLength > 4 * 1024 * 1024) {
        throw new PluginLifecycleError("plugin_store_corrupt", "Plugin audit log exceeds its byte limit");
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const lines = text.split("\n").filter((line) => line.length > 0);
      auditEvents = lines.map((line) => pluginAuditEventSchema.parse(parseStrictJson(line)));
      if (
        new Set(auditEvents.map((event) => event.event_id)).size !== auditEvents.length ||
        new Set(auditEvents.map((event) => event.operation_id)).size !== auditEvents.length
      ) {
        throw new PluginLifecycleError("plugin_store_corrupt", "Plugin audit identities must be unique");
      }
    } catch (error) {
      if (!isMissing(error)) {
        if (error instanceof PluginLifecycleError) throw error;
        throw new PluginLifecycleError("plugin_store_corrupt", "Plugin audit log failed strict validation", 1, { cause: error });
      }
    }
    const incompleteOperations: string[] = [];
    try {
      const entries = await readdir(paths.operations, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          throw new PluginLifecycleError("plugin_store_corrupt", "operation journal contains an unexpected entry");
        }
        const record = pluginOperationRecordSchema.parse(
          parseStrictJson(await readFile(join(paths.operations, entry.name), "utf8")),
        );
        if (record.state === "requested") incompleteOperations.push(record.operation_id);
      }
    } catch (error) {
      if (!isMissing(error)) {
        if (error instanceof PluginLifecycleError) throw error;
        throw new PluginLifecycleError("plugin_store_corrupt", "operation journal failed strict validation", 1, { cause: error });
      }
    }
    let activeLeaseCount = 0;
    try {
      const entries = await readdir(paths.leases, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          throw new PluginLifecycleError("plugin_store_corrupt", "lease store contains an unexpected entry");
        }
        capabilityLeaseRecordSchema.parse(
          parseStrictJson(await readFile(join(paths.leases, entry.name), "utf8")),
        );
        activeLeaseCount += 1;
      }
    } catch (error) {
      if (!isMissing(error)) {
        if (error instanceof PluginLifecycleError) throw error;
        throw new PluginLifecycleError("plugin_store_corrupt", "lease store failed strict validation", 1, { cause: error });
      }
    }
    return deepFreeze({
      activeLeaseCount,
      auditEventCount: auditEvents.length,
      enabledPluginCount: states.enablement.packages.length,
      enablementRevision: states.enablement.revision,
      incompleteOperationCount: incompleteOperations.length,
      installedIndexRevision: states.installed.revision,
      installedPluginCount: states.installed.plugins.length,
      schemaVersion: 1,
      status: incompleteOperations.length === 0 ? "valid" : "degraded",
      warnings: incompleteOperations.map((operationId) => `incomplete_operation:${operationId}`),
    });
  }

  async install(source: string, expectedSha256?: string): Promise<PluginMutationResultV1> {
    const initial = await this.#readSource(source);
    if (expectedSha256 !== undefined && expectedSha256 !== initial.pluginSha256) {
      throw new PluginLifecycleError("plugin_digest_mismatch", "local Plugin digest does not match --expect-sha256");
    }
    const lock = await this.#acquireLock();
    try {
      const stable = await this.#readSource(source);
      if (stable.pluginSha256 !== initial.pluginSha256 || (expectedSha256 !== undefined && expectedSha256 !== stable.pluginSha256)) {
        throw new PluginLifecycleError("plugin_digest_mismatch", "local Plugin source changed before publish");
      }
      const states = await this.#states();
      const existing = states.installed.plugins.find((entry) => entry.record.pluginSha256 === stable.pluginSha256);
      if (existing !== undefined) {
        await this.#verifyStore(existing);
        return deepFreeze({
          afterRevision: states.enablement.revision,
          beforeRevision: states.enablement.revision,
          changed: false,
          deduplicated: true,
          exactSelector: exactPluginSelector(existing.record),
          operation: "install",
          operationId: this.options.randomUUID(),
          pendingNextRun: false,
          retainedContent: true,
          schemaVersion: 1,
          warnings: [],
        });
      }
      const operation = await this.#operation("install", stable.pluginSha256);
      const paths = this.#paths();
      const destination = join(paths.store, stable.pluginSha256);
      const temporary = join(paths.tmp, `install-${operation.id}`);
      let record = installedPluginRecordSchema.parse({
        installedAt: this.options.now(),
        inventorySha256: stable.inventorySha256,
        manifestSha256: stable.manifestSha256,
        pluginId: stable.pluginId,
        pluginSha256: stable.pluginSha256,
        pluginVersion: stable.pluginVersion,
        schemaVersion: 1,
        source: {
          displayName: basename(stable.packageRoot),
          kind: "local_directory",
          sourceSnapshotSha256: stable.pluginSha256,
        },
      });
      let published = false;
      try {
        const destinationMetadata = await lstat(destination);
        if (!destinationMetadata.isDirectory() || destinationMetadata.isSymbolicLink()) {
          throw new PluginLifecycleError("plugin_store_corrupt", "content-addressed destination is not a stable directory");
        }
        const orphan = await StablePackageReader.read(destination);
        if (orphan.pluginSha256 !== stable.pluginSha256) {
          throw new PluginLifecycleError("plugin_store_corrupt", "content-addressed destination contains different bytes");
        }
        record = installedPluginRecordSchema.parse(
          parseStrictJson(await readFile(join(destination, CAPABILITY_STORE_RECORD_PATH), "utf8")),
        );
        published = true;
      } catch (error) {
        if (!isMissing(error)) {
          if (error instanceof PluginLifecycleError) throw error;
          throw new PluginLifecycleError("plugin_store_corrupt", "orphaned content-addressed package is invalid", 1, { cause: error });
        }
      }
      if (!published) try {
        await mkdir(temporary, { recursive: false });
        // PHASE18: install publishes only exact bytes captured by the stable
        // reader. It never imports or spawns package code, and enablement is a
        // separate user mutation performed later.
        for (const file of stable.files) {
          const target = join(temporary, ...file.path.split("/"));
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, file.bytes, { flag: "wx" });
          await fsyncPath(target);
        }
        await writeFile(
          join(temporary, CAPABILITY_STORE_RECORD_PATH),
          `${canonicalJson(record)}\n`,
          { encoding: "utf8", flag: "wx" },
        );
        await fsyncPath(join(temporary, CAPABILITY_STORE_RECORD_PATH));
        const verified = await StablePackageReader.read(temporary);
        if (verified.pluginSha256 !== stable.pluginSha256) {
          throw new PluginLifecycleError("plugin_store_corrupt", "temporary Plugin publish did not preserve exact bytes");
        }
        await mkdir(paths.store, { recursive: true });
        try {
          await rename(temporary, destination);
          await fsyncPath(paths.store);
        } catch (error) {
          if (!isExists(error)) throw error;
          const concurrent = await StablePackageReader.read(destination);
          if (concurrent.pluginSha256 !== stable.pluginSha256) {
            throw new PluginLifecycleError("plugin_store_corrupt", "content-addressed destination contains different bytes");
          }
          await rm(temporary, { recursive: true, force: true });
        }
      } catch (error) {
        if (inside(paths.tmp, temporary)) await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      const storeRelativePath = `store/v1/sha256/${stable.pluginSha256}`;
      const nextInstalled = installedPluginIndexSchema.parse({
        plugins: [...states.installed.plugins, { record, store_relative_path: storeRelativePath }]
          .sort((left, right) => left.record.pluginSha256.localeCompare(right.record.pluginSha256)),
        revision: states.installed.revision + 1,
        schema_version: 1,
      });
      await atomicJson(paths.installed, nextInstalled, operation.id);
      await this.#appendAudit(this.#audit(
        operation.id,
        "installed",
        record,
        states.enablement.revision,
        states.enablement.revision,
        "changed",
      ));
      await operation.complete();
      return deepFreeze({
        afterRevision: states.enablement.revision,
        beforeRevision: states.enablement.revision,
        changed: true,
        deduplicated: false,
        exactSelector: exactPluginSelector(record),
        operation: "install",
        operationId: operation.id,
        pendingNextRun: false,
        retainedContent: true,
        schemaVersion: 1,
        warnings: [],
      });
    } finally {
      await lock.release();
    }
  }

  #parseSelector(selector: string): { readonly id: string; readonly sha256: string; readonly version: string } {
    const match = EXACT_SELECTOR.exec(selector);
    if (match === null) {
      throw new PluginLifecycleError("plugin_not_installed", "mutation commands require an exact user_install plugin selector");
    }
    return { id: match[1]!, version: match[2]!, sha256: match[3]! };
  }

  #findInstalled(selector: string, state: InstalledPluginIndexV1) {
    const exact = this.#parseSelector(selector);
    const entry = state.plugins.find((candidate) =>
      candidate.record.pluginId === exact.id &&
      candidate.record.pluginVersion === exact.version &&
      candidate.record.pluginSha256 === exact.sha256
    );
    if (entry === undefined) throw new PluginLifecycleError("plugin_not_installed", "exact Plugin is not installed");
    return entry;
  }

  async #setEnabled(selector: string, enabled: boolean): Promise<PluginMutationResultV1> {
    const lock = await this.#acquireLock();
    try {
      const states = await this.#states();
      const entry = this.#findInstalled(selector, states.installed);
      await this.#verifyStore(entry);
      const current = states.enablement.packages.find((candidate) =>
        candidate.expected_plugin_sha256 === entry.record.pluginSha256
      );
      if ((current !== undefined) === enabled) {
        return deepFreeze({
          afterRevision: states.enablement.revision,
          beforeRevision: states.enablement.revision,
          changed: false,
          deduplicated: true,
          exactSelector: selector,
          operation: enabled ? "enable" : "disable",
          operationId: this.options.randomUUID(),
          pendingNextRun: false,
          retainedContent: true,
          schemaVersion: 1,
          warnings: [],
        });
      }
      if (enabled) {
        const conflict = states.enablement.packages.find((candidate) =>
          candidate.plugin_id === entry.record.pluginId &&
          candidate.plugin_version === entry.record.pluginVersion &&
          candidate.expected_plugin_sha256 !== entry.record.pluginSha256
        );
        if (conflict !== undefined) {
          throw new PluginLifecycleError(
            "plugin_enablement_conflict",
            "a different digest for the same Plugin ID/version is already enabled",
          );
        }
      }
      const operationName = enabled ? "enable" : "disable";
      const operation = await this.#operation(operationName, entry.record.pluginSha256);
      const packages = enabled
        ? [
            ...states.enablement.packages,
            {
              enabled: true as const,
              expected_plugin_sha256: entry.record.pluginSha256,
              path: entry.store_relative_path,
              plugin_id: entry.record.pluginId,
              plugin_version: entry.record.pluginVersion,
            },
          ]
        : states.enablement.packages.filter((candidate) =>
            candidate.expected_plugin_sha256 !== entry.record.pluginSha256
          );
      const next = pluginEnablementStateSchema.parse({
        packages: packages.sort((left, right) =>
          left.expected_plugin_sha256.localeCompare(right.expected_plugin_sha256)
        ),
        revision: states.enablement.revision + 1,
        schema_version: 1,
      });
      await atomicJson(this.#paths().enablement, next, operation.id);
      await this.#appendAudit(this.#audit(
        operation.id,
        enabled ? "enabled" : "disabled",
        entry.record,
        states.enablement.revision,
        next.revision,
        "changed",
      ));
      await operation.complete();
      // PHASE18: enablement only selects exact bytes for a future run. It does
      // not grant any process, MCP, Hook, workspace, or network permission.
      return deepFreeze({
        afterRevision: next.revision,
        beforeRevision: states.enablement.revision,
        changed: true,
        deduplicated: false,
        exactSelector: selector,
        operation: operationName,
        operationId: operation.id,
        pendingNextRun: true,
        retainedContent: true,
        schemaVersion: 1,
        warnings: ["enablement_applies_to_new_runs_only"],
      });
    } finally {
      await lock.release();
    }
  }

  enable(selector: string): Promise<PluginMutationResultV1> {
    return this.#setEnabled(selector, true);
  }

  disable(selector: string): Promise<PluginMutationResultV1> {
    return this.#setEnabled(selector, false);
  }

  async remove(selector: string): Promise<PluginMutationResultV1> {
    const lock = await this.#acquireLock();
    try {
      const states = await this.#states();
      const entry = this.#findInstalled(selector, states.installed);
      if (states.enablement.packages.some((candidate) => candidate.expected_plugin_sha256 === entry.record.pluginSha256)) {
        throw new PluginLifecycleError("plugin_remove_requires_disable", "disable the exact Plugin before removing its logical installation");
      }
      await this.#verifyStore(entry);
      const operation = await this.#operation("remove", entry.record.pluginSha256);
      const next = installedPluginIndexSchema.parse({
        plugins: states.installed.plugins.filter((candidate) => candidate.record.pluginSha256 !== entry.record.pluginSha256),
        revision: states.installed.revision + 1,
        schema_version: 1,
      });
      await atomicJson(this.#paths().installed, next, operation.id);
      await this.#appendAudit(this.#audit(
        operation.id,
        "removed",
        entry.record,
        states.enablement.revision,
        states.enablement.revision,
        "changed",
      ));
      await operation.complete();
      // PHASE18: M9 remove is deliberately logical-only. Immutable bytes are
      // retained so an active frozen run and artifact-backed replay never
      // depend on the current installation index or the original source.
      return deepFreeze({
        afterRevision: states.enablement.revision,
        beforeRevision: states.enablement.revision,
        changed: true,
        deduplicated: false,
        exactSelector: selector,
        operation: "remove",
        operationId: operation.id,
        pendingNextRun: false,
        retainedContent: true,
        schemaVersion: 1,
        warnings: ["content_retained_no_background_gc"],
      });
    } finally {
      await lock.release();
    }
  }

  async list(filter: "all" | "enabled" | "installed" = "all"): Promise<readonly PluginListEntryV1[]> {
    const states = await this.#states();
    const enabled = new Set(states.enablement.packages.map((entry) => entry.expected_plugin_sha256));
    const values = states.installed.plugins
      .filter((entry) => filter !== "enabled" || enabled.has(entry.record.pluginSha256))
      .map((entry): PluginListEntryV1 => Object.freeze({
        enabled: enabled.has(entry.record.pluginSha256),
        exactSelector: exactPluginSelector(entry.record),
        installedAt: entry.record.installedAt,
        pluginId: entry.record.pluginId,
        pluginSha256: entry.record.pluginSha256,
        pluginVersion: entry.record.pluginVersion,
        retainedContent: true,
        source: "user_install",
      }))
      .sort((left, right) => left.exactSelector.localeCompare(right.exactSelector));
    return Object.freeze(values);
  }

  async show(selector: string): Promise<PluginListEntryV1> {
    const states = await this.#states();
    const installed = this.#findInstalled(selector, states.installed);
    await this.#verifyStore(installed);
    const enabled = states.enablement.packages.some((candidate) =>
      candidate.expected_plugin_sha256 === installed.record.pluginSha256
    );
    return Object.freeze({
      enabled,
      exactSelector: exactPluginSelector(installed.record),
      installedAt: installed.record.installedAt,
      pluginId: installed.record.pluginId,
      pluginSha256: installed.record.pluginSha256,
      pluginVersion: installed.record.pluginVersion,
      retainedContent: true,
      source: "user_install",
    });
  }

  async acquireLeases(
    pluginSha256s: readonly string[],
    runId: string,
  ): Promise<readonly CapabilityContentLease[]> {
    const unique = [...new Set(pluginSha256s)].sort();
    if (unique.length === 0) return Object.freeze([]);
    const lock = await this.#acquireLock();
    const created: string[] = [];
    try {
      const states = await this.#states();
      const leases: CapabilityContentLease[] = [];
      await mkdir(this.#paths().leases, { recursive: true });
      for (const digest of unique) {
        const installed = states.installed.plugins.find((entry) => entry.record.pluginSha256 === digest);
        if (installed === undefined) throw new PluginLifecycleError("plugin_not_installed", "frozen Plugin is no longer logically installed before lease acquisition", 8);
        await this.#verifyStore(installed);
        const leaseId = this.options.randomUUID();
        const path = join(this.#paths().leases, `${leaseId}.json`);
        const record = capabilityLeaseRecordSchema.parse({
          acquired_at: this.options.now(),
          lease_id: leaseId,
          plugin_sha256: digest,
          run_id: runId,
          schema_version: 1,
        });
        await atomicJson(path, record, this.options.randomUUID());
        created.push(path);
        let released = false;
        leases.push(Object.freeze({
          leaseId,
          pluginSha256: digest,
          release: async () => {
            if (released) return;
            released = true;
            try {
              const current = capabilityLeaseRecordSchema.parse(parseStrictJson(await readFile(path, "utf8")));
              if (current.lease_id !== leaseId || current.plugin_sha256 !== digest || current.run_id !== runId) {
                throw new PluginLifecycleError("plugin_active_lease", "capability content lease identity changed");
              }
              await unlink(path);
            } catch (error) {
              if (!isMissing(error)) throw error;
            }
          },
          runId,
        }));
      }
      return Object.freeze(leases);
    } catch (error) {
      await Promise.all(created.map((path) => unlink(path).catch(() => undefined)));
      throw error;
    } finally {
      await lock.release();
    }
  }
}
