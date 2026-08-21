import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { canonicalJson } from "../completion/canonical-json.js";
import {
  currentHostFingerprint,
  currentProcessIdentity,
  NodeProcessIdentityProbe,
  type ProcessIdentity,
  type ProcessIdentityProbe,
} from "../sessions/process-identity.js";
import { NodeRenameDurabilityPort, type RenameDurabilityPort } from "../sessions/rename-durability.js";
import { parseStrictJson } from "../system/strict-json.js";
import { buildIndexGeneration, canonicalizeIndexRecords, type BuiltIndexGeneration } from "./index-generation.js";
import { RepositoryIndexLock } from "./index-lock.js";
import {
  buildRepositoryStorageLayoutV2,
  type EncodedRepositoryCacheObjectV2,
} from "./index-v2-layout.js";
import { RepositoryIndexV2PathPolicy } from "./index-v2-path-policy.js";
import {
  allRepositoryObjectRefsV2,
  createRepositoryCurrentPointerV2,
  createRepositoryReaderLeaseV1,
  parseRepositoryCacheObjectV2,
  repositoryCacheObjectSha256,
  repositoryCurrentPointerV2Schema,
  repositoryReaderLeaseV1Schema,
  repositoryStorageRootV2Schema,
  rootObjectRefsForKindV2,
  type RepositoryCacheObjectV2,
  type RepositoryCurrentPointerV2,
  type RepositoryFactReceiptV1,
  type RepositoryObjectRefV2,
  type RepositoryOutlineSymbolV2,
  type RepositoryReaderLeaseV1,
  type RepositoryStorageRootV2,
  type RepositorySymbolSearchEntryV2,
} from "./index-v2-schema.js";
import type {
  IndexedReference,
  IndexedSourceUnit,
  IndexedSymbol,
  RepositoryIndexRecords,
} from "./navigation-types.js";
import {
  repositoryCacheObjectKindsV2,
  repositoryCacheStoragePolicySha256,
  repositoryCacheStoragePolicyV1,
  type RepositoryCacheObjectKindV2,
} from "./repository-cache-storage-policy.js";
import { RepositoryIntelligenceError } from "./repository-intelligence-error.js";

const DECODED_CACHE_MAX_ENTRIES = 256;
const DECODED_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const MINIMUM_LEASE_RECOVERY_AGE_MS = 30_000;

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

async function forEachBounded<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      await operation(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
}

function parseCanonical(bytes: Buffer): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = parseStrictJson(text);
  if (`${canonicalJson(value)}\n` !== text) throw new Error("repository cache file is not canonical JSON");
  return value;
}

async function readBoundedRegular(path: string, maxBytes: number): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > maxBytes) {
    throw new Error("repository cache file identity or size is invalid");
  }
  const bytes = await readFile(path);
  if (bytes.byteLength !== metadata.size) throw new Error("repository cache file size changed during read");
  return bytes;
}

async function syncInstalledFile(path: string, expected: Buffer): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== expected.byteLength) {
    throw new Error("installed repository cache file identity is invalid");
  }
  if (!(await readFile(path)).equals(expected)) throw new Error("installed repository cache file readback mismatch");
  if (process.platform !== "win32") {
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

export interface RepositoryCacheRuntimeCountersV2 {
  readonly cacheBytesDecoded: number;
  readonly cacheBytesRead: number;
  readonly cacheBytesWritten: number;
  readonly dataObjectBytesReadByKind: Readonly<Record<RepositoryCacheObjectKindV2, number>>;
  readonly objectsCreated: number;
  readonly objectsOpened: number;
  readonly objectsReused: number;
  readonly pointerBytesRead: number;
  readonly rootMetadataBytesRead: number;
}

interface MutableRepositoryCacheRuntimeCountersV2 {
  cacheBytesDecoded: number;
  cacheBytesRead: number;
  cacheBytesWritten: number;
  dataObjectBytesReadByKind: Record<RepositoryCacheObjectKindV2, number>;
  objectsCreated: number;
  objectsOpened: number;
  objectsReused: number;
  pointerBytesRead: number;
  rootMetadataBytesRead: number;
}

function emptyCounters(): MutableRepositoryCacheRuntimeCountersV2 {
  return {
    cacheBytesDecoded: 0,
    cacheBytesRead: 0,
    cacheBytesWritten: 0,
    dataObjectBytesReadByKind: {
      dependency_view: 0,
      fact_receipt: 0,
      outline_view: 0,
      reference_posting: 0,
      symbol_payload: 0,
      symbol_search_directory: 0,
      unit_directory: 0,
    },
    objectsCreated: 0,
    objectsOpened: 0,
    objectsReused: 0,
    pointerBytesRead: 0,
    rootMetadataBytesRead: 0,
  };
}

export interface StoredRepositoryIndexV2 {
  readonly generation: RepositoryStorageRootV2["generation"];
  readonly manifestSha256: string;
  readonly records: RepositoryIndexRecords;
  readonly storageRoot: RepositoryStorageRootV2;
}

export interface RepositoryIndexV2LockLike {
  assertOwned(): Promise<void>;
}

export interface RepositoryIndexV2StoreOptions {
  readonly hostFingerprint?: string;
  readonly minimumLeaseRecoveryAgeMs?: number;
  readonly now?: () => Date;
  readonly ownerProbe?: ProcessIdentityProbe;
  readonly processIdentity?: ProcessIdentity;
  readonly renameDurability?: RenameDurabilityPort;
}

export interface RepositoryV2GarbageCollectionResult {
  readonly activeLeaseCount: number;
  readonly dryRun: boolean;
  readonly gcReclaimedBytes: number;
  readonly gcReclaimedEntries: number;
  readonly liveReachableBytes: number;
  readonly staleLeasesReclaimed: number;
  readonly unreachableKnownBytes: number;
  readonly unreachableKnownEntries: number;
}

interface DecodedCacheEntry {
  readonly bytes: number;
  readonly promise: Promise<RepositoryCacheObjectV2>;
}

interface GarbageCandidate {
  readonly bytes: number;
  readonly kind: "object" | "root";
  readonly path: string;
  readonly sha256: string;
}

export class RepositoryIndexV2ReadLease {
  private released = false;

  constructor(
    private readonly store: RepositoryIndexV2Store,
    readonly pointer: RepositoryCurrentPointerV2,
    readonly root: RepositoryStorageRootV2,
    readonly record: RepositoryReaderLeaseV1,
  ) {}

  async readAllRecords(options: { readonly auditAll?: boolean } = {}): Promise<RepositoryIndexRecords> {
    this.assertActive();
    return this.store.readAllRecords(this.root, options.auditAll ?? false);
  }

  async readUnits(): Promise<readonly IndexedSourceUnit[]> {
    this.assertActive();
    return this.store.readUnits(this.root);
  }

  async readOutlineSymbols(): Promise<readonly RepositoryOutlineSymbolV2[]> {
    this.assertActive();
    return this.store.readOutlineSymbols(this.root);
  }

  async readSymbolSearchDirectory(): Promise<readonly RepositorySymbolSearchEntryV2[]> {
    this.assertActive();
    return this.store.readSymbolSearchDirectory(this.root);
  }

  async readSymbolPayloads(partitionKeys: readonly string[]): Promise<readonly IndexedSymbol[]> {
    this.assertActive();
    return this.store.readSymbolPayloads(this.root, partitionKeys);
  }

  async readReferencePosting(targetSymbolRecordId: string): Promise<readonly IndexedReference[]> {
    this.assertActive();
    return this.store.readReferencePosting(this.root, targetSymbolRecordId);
  }

  async readFactReceipts(): Promise<readonly RepositoryFactReceiptV1[]> {
    this.assertActive();
    return this.store.readFactReceipts(this.root);
  }

  async release(): Promise<void> {
    if (this.released) return;
    await this.store.releaseLease(this.record);
    this.released = true;
  }

  private assertActive(): void {
    if (this.released) throw new RepositoryIntelligenceError("repository_cache_lease_invalid", "repository cache reader lease is released");
  }
}

export class RepositoryIndexV2Store {
  private counters = emptyCounters();
  private readonly decodedCache = new Map<string, DecodedCacheEntry>();
  private decodedCacheBytes = 0;
  private readonly hostFingerprint: string;
  private readonly minimumLeaseRecoveryAgeMs: number;
  private readonly now: () => Date;
  private readonly ownerProbe: ProcessIdentityProbe;
  private readonly processIdentity: ProcessIdentity;
  private readonly renameDurability: RenameDurabilityPort;

  constructor(
    readonly paths: RepositoryIndexV2PathPolicy,
    options: RepositoryIndexV2StoreOptions = {},
  ) {
    this.processIdentity = options.processIdentity ?? currentProcessIdentity();
    this.hostFingerprint = options.hostFingerprint ?? currentHostFingerprint();
    this.minimumLeaseRecoveryAgeMs = options.minimumLeaseRecoveryAgeMs ?? MINIMUM_LEASE_RECOVERY_AGE_MS;
    this.now = options.now ?? (() => new Date());
    this.ownerProbe = options.ownerProbe ?? new NodeProcessIdentityProbe(this.processIdentity);
    this.renameDurability = options.renameDurability ?? new NodeRenameDurabilityPort();
    if (!Number.isSafeInteger(this.minimumLeaseRecoveryAgeMs) || this.minimumLeaseRecoveryAgeMs < 0 || this.minimumLeaseRecoveryAgeMs > 86_400_000) {
      throw new RangeError("repository lease recovery age is outside its bounded range");
    }
  }

  static async create(workspace: string, options: RepositoryIndexV2StoreOptions = {}): Promise<RepositoryIndexV2Store> {
    return new RepositoryIndexV2Store(await RepositoryIndexV2PathPolicy.create(workspace), options);
  }

  static async openExisting(workspace: string, options: RepositoryIndexV2StoreOptions = {}): Promise<RepositoryIndexV2Store | null> {
    const paths = await RepositoryIndexV2PathPolicy.openExisting(workspace);
    return paths === null ? null : new RepositoryIndexV2Store(paths, options);
  }

  resetCounters(): void {
    this.counters = emptyCounters();
  }

  snapshotCounters(): RepositoryCacheRuntimeCountersV2 {
    return Object.freeze({
      ...this.counters,
      dataObjectBytesReadByKind: Object.freeze({ ...this.counters.dataObjectBytesReadByKind }),
    });
  }

  dispose(): void {
    this.decodedCache.clear();
    this.decodedCacheBytes = 0;
  }

  async publish(
    input: BuiltIndexGeneration,
    lock: RepositoryIndexV2LockLike,
    options: { readonly includeFactReceipts?: boolean } = {},
  ): Promise<StoredRepositoryIndexV2> {
    await lock.assertOwned();
    const layout = buildRepositoryStorageLayoutV2(input, options);
    const rootBytes = canonicalBytes(layout.root);
    if (rootBytes.byteLength > repositoryCacheStoragePolicyV1.maxRootBytes) {
      throw new RepositoryIntelligenceError("repository_index_budget_exceeded", "repository v2 root exceeds its byte bound", 7);
    }
    await this.assertPublishAdmission(layout.objects.reduce((total, object) => total + object.bytes.byteLength, rootBytes.byteLength));

    await forEachBounded(layout.objects, 16, async (object) => this.installObject(object));
    await this.installImmutable(
      this.paths.rootManifestPath(layout.root.storageManifestSha256),
      rootBytes,
      "root",
    );
    const verifiedRoot = await this.readRoot(layout.root.storageManifestSha256);
    await this.auditRoot(verifiedRoot, true);
    await lock.assertOwned();

    const leaseGcLock = await RepositoryIndexLock.acquire(this.paths, {
      lockName: "lease-gc.lock",
      signal: new AbortController().signal,
      waitMs: repositoryCacheStoragePolicyV1.leaseGcLockWaitMs,
    });
    try {
      await lock.assertOwned();
      await this.publishPointer(createRepositoryCurrentPointerV2(verifiedRoot));
    } finally {
      await leaseGcLock.release().catch(() => undefined);
    }
    return Object.freeze({
      generation: verifiedRoot.generation,
      manifestSha256: verifiedRoot.storageManifestSha256,
      records: input.records,
      storageRoot: verifiedRoot,
    });
  }

  async acquireCurrentLease(expected?: {
    readonly engineIdentitySha256: string;
    readonly ruleManifestSha256: string;
    readonly sourceStateSha256: string;
  }): Promise<RepositoryIndexV2ReadLease | null> {
    const lock = await RepositoryIndexLock.acquire(this.paths, {
      lockName: "lease-gc.lock",
      signal: new AbortController().signal,
      waitMs: repositoryCacheStoragePolicyV1.leaseGcLockWaitMs,
    });
    try {
      const pointer = await this.readPointer();
      if (pointer === null) return null;
      const root = await this.readRoot(pointer.storageManifestSha256);
      this.assertPointerRoot(pointer, root);
      if (expected !== undefined && (
        pointer.engineIdentitySha256 !== expected.engineIdentitySha256 ||
        pointer.ruleManifestSha256 !== expected.ruleManifestSha256 ||
        pointer.sourceStateSha256 !== expected.sourceStateSha256
      )) return null;
      const leaseFiles = await readdir(this.paths.leasesRoot);
      if (leaseFiles.length >= repositoryCacheStoragePolicyV1.maxActiveLeases) {
        throw new RepositoryIntelligenceError("repository_cache_lease_invalid", "repository cache active lease bound is exhausted", 7);
      }
      const leaseId = randomUUID();
      const record = createRepositoryReaderLeaseV1({
        createdAt: this.now().toISOString(),
        hostFingerprint: this.hostFingerprint,
        leaseId,
        pid: this.processIdentity.pid,
        processStartIdentity: this.processIdentity.startIdentity,
        schemaVersion: 1,
        storageManifestSha256: root.storageManifestSha256,
      });
      const bytes = canonicalBytes(record);
      if (bytes.byteLength > repositoryCacheStoragePolicyV1.maxLeaseBytes) {
        throw new RepositoryIntelligenceError("repository_cache_lease_invalid", "repository cache reader lease exceeds its byte bound", 7);
      }
      await this.installImmutable(this.paths.leasePath(leaseId), bytes, "lease");
      return new RepositoryIndexV2ReadLease(this, pointer, root, record);
    } catch (error) {
      if (error instanceof RepositoryIntelligenceError) throw error;
      throw new RepositoryIntelligenceError("repository_cache_lease_invalid", "repository cache reader lease acquisition failed", 1, { cause: error });
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  async readCurrent(): Promise<StoredRepositoryIndexV2 | null> {
    const lease = await this.acquireCurrentLease();
    if (lease === null) return null;
    try {
      const records = await lease.readAllRecords({ auditAll: true });
      return Object.freeze({
        generation: lease.root.generation,
        manifestSha256: lease.root.storageManifestSha256,
        records,
        storageRoot: lease.root,
      });
    } finally {
      await lease.release().catch(() => undefined);
    }
  }

  async readGeneration(storageManifestSha256: string): Promise<StoredRepositoryIndexV2> {
    const root = await this.readRoot(storageManifestSha256);
    const records = await this.readAllRecords(root, true);
    return Object.freeze({ generation: root.generation, manifestSha256: root.storageManifestSha256, records, storageRoot: root });
  }

  async assertCurrentGeneration(generationSha256: string): Promise<void> {
    const pointer = await this.readPointer();
    if (pointer === null || pointer.generationSha256 !== generationSha256) {
      throw new RepositoryIntelligenceError("repository_index_stale", "repository v2 current generation changed during navigation", 8);
    }
  }

  async recoverOwnedTemps(limit = 128): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 4_096) throw new RangeError("repository cache temp recovery limit is invalid");
    let recovered = 0;
    for (const entry of (await readdir(this.paths.temporaryRoot)).sort(ordinal)) {
      if (recovered >= limit) break;
      if (!/^(?:object|root|lease|key)-[0-9a-f-]{36}\.tmp$/u.test(entry)) continue;
      const path = join(this.paths.temporaryRoot, entry);
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      await unlink(path);
      recovered += 1;
    }
    for (const entry of (await readdir(this.paths.root)).sort(ordinal)) {
      if (recovered >= limit) break;
      if (!/^\.pointer-[0-9a-f-]{36}\.tmp$/u.test(entry)) continue;
      const path = join(this.paths.root, entry);
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      await unlink(path);
      recovered += 1;
    }
    recovered += await this.recoverGcPending(Math.max(0, limit - recovered));
    return recovered;
  }

  async quarantineCorruptCurrent(lock: RepositoryIndexV2LockLike): Promise<number> {
    await lock.assertOwned();
    const leaseGc = await RepositoryIndexLock.acquire(this.paths, {
      lockName: "lease-gc.lock",
      signal: new AbortController().signal,
      waitMs: repositoryCacheStoragePolicyV1.leaseGcLockWaitMs,
    });
    try {
      await lock.assertOwned();
      const leaseRecords: RepositoryReaderLeaseV1[] = [];
      for (const name of (await readdir(this.paths.leasesRoot)).sort(ordinal)) {
        if (!/^[0-9a-f-]{36}\.json$/u.test(name)) throw new RepositoryIntelligenceError("repository_cache_lease_invalid", "cannot quarantine while lease inventory is unknown");
        const bytes = await readBoundedRegular(join(this.paths.leasesRoot, name), repositoryCacheStoragePolicyV1.maxLeaseBytes);
        leaseRecords.push(repositoryReaderLeaseV1Schema.parse(parseCanonical(bytes)));
      }

      let pointer: RepositoryCurrentPointerV2;
      try {
        const selected = await this.readPointer();
        if (selected === null) return 0;
        pointer = selected;
      } catch {
        await this.assertQuarantineCapacity(1, (await lstat(this.paths.currentPointerPath())).size);
        await rename(
          this.paths.currentPointerPath(),
          join(this.paths.quarantineRootsRoot, `pointer.${randomUUID()}.corrupt`),
        );
        return 1;
      }

      let root: RepositoryStorageRootV2 | null = null;
      let rootCorrupt = false;
      try {
        root = await this.readRoot(pointer.storageManifestSha256);
        this.assertPointerRoot(pointer, root);
      } catch {
        rootCorrupt = true;
      }
      const corruptObjects: { readonly path: string; readonly ref: RepositoryObjectRefV2 }[] = [];
      if (root !== null) {
        for (const ref of allRepositoryObjectRefsV2(root)) {
          try {
            await this.readObject(ref, true);
          } catch {
            corruptObjects.push({ path: await this.paths.objectPath(ref.sha256), ref });
          }
        }
        if (corruptObjects.length === 0) {
          try {
            await this.auditRoot(root, true);
          } catch {
            rootCorrupt = true;
          }
        }
      }
      if (!rootCorrupt && corruptObjects.length === 0) return 0;
      if (leaseRecords.some((lease) => lease.storageManifestSha256 === pointer.storageManifestSha256)) {
        throw new RepositoryIntelligenceError("quarantine_blocked_by_reader", "corrupt current root is still protected by a reader lease", 8);
      }

      const rootPath = this.paths.rootManifestPath(pointer.storageManifestSha256);
      const rootBytes = await lstat(rootPath).then((metadata) => metadata.size).catch(() => 0);
      const pointerBytes = await lstat(this.paths.currentPointerPath()).then((metadata) => metadata.size).catch(() => 0);
      const objectBytes = await Promise.all(corruptObjects.map((entry) => lstat(entry.path).then((metadata) => metadata.size)));
      await this.assertQuarantineCapacity(2 + corruptObjects.length, rootBytes + pointerBytes + objectBytes.reduce((total, bytes) => total + bytes, 0));

      await rename(
        this.paths.currentPointerPath(),
        join(this.paths.quarantineRootsRoot, `pointer.${randomUUID()}.corrupt`),
      );
      try {
        await rename(
          rootPath,
          join(this.paths.quarantineRootsRoot, `${pointer.storageManifestSha256}.${randomUUID()}.corrupt`),
        );
      } catch (error) {
        if (!isCode(error, "ENOENT")) throw error;
      }
      for (const entry of corruptObjects) {
        await rename(
          entry.path,
          join(this.paths.quarantineObjectsRoot, `${entry.ref.sha256}.${randomUUID()}.corrupt`),
        );
      }
      return 2 + corruptObjects.length;
    } catch (error) {
      if (error instanceof RepositoryIntelligenceError) throw error;
      throw new RepositoryIntelligenceError("repository_cache_storage_invalid", "repository corrupt-current quarantine failed", 1, { cause: error });
    } finally {
      await leaseGc.release().catch(() => undefined);
    }
  }

  async collectGarbage(options: { readonly dryRun: boolean; readonly signal?: AbortSignal }): Promise<RepositoryV2GarbageCollectionResult> {
    const signal = options.signal ?? new AbortController().signal;
    const writer = await RepositoryIndexLock.acquire(this.paths, { signal });
    let pending: { readonly candidates: readonly GarbageCandidate[]; readonly sweepRoot: string } | null = null;
    let result: RepositoryV2GarbageCollectionResult;
    try {
      const leaseGc = await RepositoryIndexLock.acquire(this.paths, {
        lockName: "lease-gc.lock",
        signal,
        waitMs: repositoryCacheStoragePolicyV1.leaseGcLockWaitMs,
      });
      try {
        const snapshot = await this.captureGcSnapshot(!options.dryRun);
        const selected = snapshot.candidates.slice(0, repositoryCacheStoragePolicyV1.maxGcEntriesPerPass)
          .reduce<{ entries: GarbageCandidate[]; bytes: number }>((state, candidate) => {
            if (state.bytes + candidate.bytes > repositoryCacheStoragePolicyV1.maxGcBytesPerPass) return state;
            state.entries.push(candidate);
            state.bytes += candidate.bytes;
            return state;
          }, { bytes: 0, entries: [] });
        if (!options.dryRun && selected.entries.length > 0) {
          const sweepId = randomUUID();
          const sweepRoot = this.paths.gcPendingSweepPath(sweepId);
          const roots = join(sweepRoot, "roots");
          const objects = join(sweepRoot, "objects");
          await mkdir(sweepRoot);
          await mkdir(roots);
          await mkdir(objects);
          for (const candidate of selected.entries) {
            const target = join(candidate.kind === "root" ? roots : objects, `${candidate.sha256}.${candidate.kind === "root" ? "json" : "data"}`);
            await rename(candidate.path, target);
          }
          pending = Object.freeze({ candidates: Object.freeze([...selected.entries]), sweepRoot });
        }
        result = Object.freeze({
          activeLeaseCount: snapshot.activeLeaseCount,
          dryRun: options.dryRun,
          gcReclaimedBytes: options.dryRun ? 0 : selected.bytes,
          gcReclaimedEntries: options.dryRun ? 0 : selected.entries.length,
          liveReachableBytes: snapshot.liveReachableBytes,
          staleLeasesReclaimed: snapshot.staleLeasesReclaimed,
          unreachableKnownBytes: snapshot.candidates.reduce((total, entry) => total + entry.bytes, 0),
          unreachableKnownEntries: snapshot.candidates.length,
        });
      } finally {
        await leaseGc.release().catch(() => undefined);
      }
    } finally {
      await writer.release().catch(() => undefined);
    }
    if (pending !== null) await this.deletePendingSweep(pending.sweepRoot);
    return result!;
  }

  async releaseLease(record: RepositoryReaderLeaseV1): Promise<void> {
    const lock = await RepositoryIndexLock.acquire(this.paths, {
      lockName: "lease-gc.lock",
      signal: new AbortController().signal,
      waitMs: repositoryCacheStoragePolicyV1.leaseGcLockWaitMs,
    });
    try {
      const path = this.paths.leasePath(record.leaseId);
      const bytes = await readBoundedRegular(path, repositoryCacheStoragePolicyV1.maxLeaseBytes);
      const current = repositoryReaderLeaseV1Schema.parse(parseCanonical(bytes));
      if (current.leaseSha256 !== record.leaseSha256 || current.processStartIdentity !== record.processStartIdentity) {
        throw new RepositoryIntelligenceError("repository_cache_lease_invalid", "repository reader lease ownership changed");
      }
      await unlink(path);
    } catch (error) {
      if (isCode(error, "ENOENT")) return;
      if (error instanceof RepositoryIntelligenceError) throw error;
      throw new RepositoryIntelligenceError("repository_cache_lease_invalid", "repository reader lease release failed", 1, { cause: error });
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  async readAllRecords(root: RepositoryStorageRootV2, auditAll: boolean): Promise<RepositoryIndexRecords> {
    if (auditAll) return this.auditRoot(root, true);
    const [units, payloads] = await Promise.all([
      this.readObjectsForKind(root, "unit_directory", false),
      this.readObjectsForKind(root, "symbol_payload", false),
    ]);
    return this.recordsFromObjects(root, [...units, ...payloads]);
  }

  async readUnits(root: RepositoryStorageRootV2): Promise<readonly IndexedSourceUnit[]> {
    const objects = await this.readObjectsForKind(root, "unit_directory", false);
    return Object.freeze(objects.flatMap((object) => object.kind === "unit_directory" ? object.units : []));
  }

  async readOutlineSymbols(root: RepositoryStorageRootV2): Promise<readonly RepositoryOutlineSymbolV2[]> {
    const objects = await this.readObjectsForKind(root, "outline_view", false);
    return Object.freeze(objects.flatMap((object) => object.kind === "outline_view" ? object.symbols.map((entry) => ({
      kind: entry[2],
      name: entry[3],
      recordId: entry[1],
      relativePath: entry[0],
      startLine: entry[4],
    })) : []));
  }

  async readSymbolSearchDirectory(root: RepositoryStorageRootV2): Promise<readonly RepositorySymbolSearchEntryV2[]> {
    const objects = await this.readObjectsForKind(root, "symbol_search_directory", false);
    return Object.freeze(objects.flatMap((object) => object.kind === "symbol_search_directory" ? object.entries.map((entry) => ({
      kind: entry[3],
      name: entry[0],
      payloadPartitionKey: entry[5],
      qualifiedName: entry[1],
      recordId: entry[4],
      relativePath: entry[2],
    })) : []));
  }

  async readSymbolPayloads(root: RepositoryStorageRootV2, partitionKeys: readonly string[]): Promise<readonly IndexedSymbol[]> {
    const selected = new Set(partitionKeys);
    const refs = rootObjectRefsForKindV2(root, "symbol_payload").filter((ref) => selected.has(ref.logicalPartitionKey));
    const objects = await Promise.all(refs.map((ref) => this.readObject(ref, false)));
    return Object.freeze(objects.flatMap((object) => object.kind === "symbol_payload"
      ? object.units.flatMap((unit) => unit[2])
      : []));
  }

  async readReferencePosting(root: RepositoryStorageRootV2, targetSymbolRecordId: string): Promise<readonly IndexedReference[]> {
    if (!/^[a-f0-9]{64}$/u.test(targetSymbolRecordId)) throw new TypeError("target symbol record identity is invalid");
    const prefix = `bucket/${targetSymbolRecordId.slice(0, 1)}/`;
    const refs = rootObjectRefsForKindV2(root, "reference_posting").filter((ref) => ref.logicalPartitionKey.startsWith(prefix));
    const objects = await Promise.all(refs.map((ref) => this.readObject(ref, false)));
    return Object.freeze(objects.flatMap((object) => object.kind === "reference_posting"
      ? object.references.filter((entry) => entry.targetSymbolRecordId === targetSymbolRecordId)
      : []));
  }

  async readFactReceipts(root: RepositoryStorageRootV2): Promise<readonly RepositoryFactReceiptV1[]> {
    const objects = await this.readObjectsForKind(root, "fact_receipt", false);
    return Object.freeze(objects.flatMap((object) => object.kind === "fact_receipt" ? object.receipts : []));
  }

  private async readPointer(): Promise<RepositoryCurrentPointerV2 | null> {
    try {
      const bytes = await readBoundedRegular(this.paths.currentPointerPath(), repositoryCacheStoragePolicyV1.maxRootBytes);
      this.counters.cacheBytesRead += bytes.byteLength;
      this.counters.pointerBytesRead += bytes.byteLength;
      return repositoryCurrentPointerV2Schema.parse(parseCanonical(bytes));
    } catch (error) {
      if (isCode(error, "ENOENT")) return null;
      throw new RepositoryIntelligenceError("repository_cache_storage_invalid", "repository v2 current pointer failed strict validation", 1, { cause: error });
    }
  }

  private async readRoot(storageManifestSha256: string): Promise<RepositoryStorageRootV2> {
    try {
      const bytes = await readBoundedRegular(this.paths.rootManifestPath(storageManifestSha256), repositoryCacheStoragePolicyV1.maxRootBytes);
      this.counters.cacheBytesRead += bytes.byteLength;
      this.counters.rootMetadataBytesRead += bytes.byteLength;
      const root = repositoryStorageRootV2Schema.parse(parseCanonical(bytes));
      if (root.storageManifestSha256 !== storageManifestSha256 || root.storagePolicySha256 !== repositoryCacheStoragePolicySha256) {
        throw new Error("repository storage root identity or policy mismatch");
      }
      return root;
    } catch (error) {
      if (isCode(error, "ENOENT")) throw error;
      throw new RepositoryIntelligenceError("repository_cache_storage_invalid", "repository v2 storage root failed strict validation", 1, { cause: error });
    }
  }

  private assertPointerRoot(pointer: RepositoryCurrentPointerV2, root: RepositoryStorageRootV2): void {
    if (
      pointer.storageManifestSha256 !== root.storageManifestSha256 ||
      pointer.generationSha256 !== root.generation.generationSha256 ||
      pointer.engineIdentitySha256 !== root.generation.engineIdentitySha256 ||
      pointer.sourceStateSha256 !== root.generation.sourceStateSha256 ||
      pointer.ruleManifestSha256 !== root.generation.ruleManifestSha256 ||
      pointer.storagePolicySha256 !== root.storagePolicySha256
    ) throw new RepositoryIntelligenceError("repository_cache_storage_invalid", "repository v2 pointer and root disagree");
  }

  private async readObject(ref: RepositoryObjectRefV2, bypassCache: boolean): Promise<RepositoryCacheObjectV2> {
    const cacheKey = `${ref.sha256}:${repositoryCacheStoragePolicyV1.decoderIdentitySha256}`;
    if (!bypassCache) {
      const hit = this.decodedCache.get(cacheKey);
      if (hit !== undefined) {
        this.decodedCache.delete(cacheKey);
        this.decodedCache.set(cacheKey, hit);
        this.counters.objectsReused += 1;
        return hit.promise;
      }
    }
    const load = this.loadObject(ref);
    if (bypassCache) return load;
    const entry: DecodedCacheEntry = Object.freeze({ bytes: ref.bytes, promise: load });
    this.decodedCache.set(cacheKey, entry);
    this.decodedCacheBytes += entry.bytes;
    this.evictDecodedCache();
    void load.catch(() => {
      if (this.decodedCache.get(cacheKey) === entry) {
        this.decodedCache.delete(cacheKey);
        this.decodedCacheBytes -= entry.bytes;
      }
    });
    return load;
  }

  private async loadObject(ref: RepositoryObjectRefV2): Promise<RepositoryCacheObjectV2> {
    try {
      const path = await this.paths.objectPath(ref.sha256);
      const bytes = await readBoundedRegular(path, repositoryCacheStoragePolicyV1.maxObjectBytes);
      this.counters.cacheBytesRead += bytes.byteLength;
      this.counters.cacheBytesDecoded += bytes.byteLength;
      this.counters.dataObjectBytesReadByKind[ref.kind] += bytes.byteLength;
      this.counters.objectsOpened += 1;
      if (bytes.byteLength !== ref.bytes || repositoryCacheObjectSha256(ref, bytes) !== ref.sha256) {
        throw new Error("repository cache object size or digest mismatch");
      }
      const object = parseRepositoryCacheObjectV2(ref.kind, parseCanonical(bytes));
      if (object.logicalPartitionKey !== ref.logicalPartitionKey || object.kind !== ref.kind) {
        throw new Error("repository cache object logical identity mismatch");
      }
      return object;
    } catch (error) {
      throw new RepositoryIntelligenceError("repository_cache_storage_invalid", "repository cache object failed strict validation", 1, { cause: error });
    }
  }

  private evictDecodedCache(): void {
    while (this.decodedCache.size > DECODED_CACHE_MAX_ENTRIES || this.decodedCacheBytes > DECODED_CACHE_MAX_BYTES) {
      const oldest = this.decodedCache.entries().next().value as [string, DecodedCacheEntry] | undefined;
      if (oldest === undefined) break;
      this.decodedCache.delete(oldest[0]);
      this.decodedCacheBytes -= oldest[1].bytes;
    }
  }

  private async readObjectsForKind(
    root: RepositoryStorageRootV2,
    kind: RepositoryCacheObjectKindV2,
    bypassCache: boolean,
  ): Promise<readonly RepositoryCacheObjectV2[]> {
    return Promise.all(rootObjectRefsForKindV2(root, kind).map((ref) => this.readObject(ref, bypassCache)));
  }

  private async auditRoot(root: RepositoryStorageRootV2, bypassCache: boolean): Promise<RepositoryIndexRecords> {
    const refs = allRepositoryObjectRefsV2(root);
    const objects = await Promise.all(refs.map((ref) => this.readObject(ref, bypassCache)));
    const records = this.recordsFromObjects(root, objects);
    this.assertDerivedViews(root, objects, records);
    const expected = buildRepositoryStorageLayoutV2(
      { generation: root.generation, records },
      { includeFactReceipts: root.factReceiptObjects.length > 0 || root.dependencyObjects.length > 0 },
    );
    if (canonicalJson(expected.root) !== canonicalJson(root)) {
      throw new RepositoryIntelligenceError("repository_cache_storage_invalid", "repository v2 root is not the deterministic layout for its semantic generation");
    }
    return records;
  }

  private recordsFromObjects(root: RepositoryStorageRootV2, objects: readonly RepositoryCacheObjectV2[]): RepositoryIndexRecords {
    const units = objects.flatMap((object) => object.kind === "unit_directory" ? object.units : []);
    const symbols = objects.flatMap((object) => object.kind === "symbol_payload"
      ? object.units.flatMap((unit) => unit[2])
      : []);
    const references = objects.flatMap((object) => object.kind === "reference_posting" ? object.references : []);
    const imports = objects.flatMap((object) => object.kind === "symbol_payload"
      ? object.units.flatMap((unit) => unit[1])
      : []);
    const records = canonicalizeIndexRecords({ imports, references, symbols, units });
    const rebuilt = buildIndexGeneration({
      engineIdentitySha256: root.generation.engineIdentitySha256,
      records,
      ruleManifestSha256: root.generation.ruleManifestSha256,
      sourceCoverage: root.generation.coverage,
      sourceStateSha256: root.generation.sourceStateSha256,
    });
    if (canonicalJson(rebuilt.generation) !== canonicalJson(root.generation)) {
      throw new RepositoryIntelligenceError("repository_cache_storage_invalid", "repository v2 objects do not reproduce the semantic generation");
    }
    return records;
  }

  private assertDerivedViews(
    root: RepositoryStorageRootV2,
    objects: readonly RepositoryCacheObjectV2[],
    records: RepositoryIndexRecords,
  ): void {
    const search = objects.flatMap((object) => object.kind === "symbol_search_directory" ? object.entries : []);
    const payloadKeyByUnit = new Map(objects.flatMap((object) => object.kind === "symbol_payload"
      ? object.units.map((unit) => [unit[0], object.logicalPartitionKey] as const)
      : []));
    const expectedSearch = records.symbols.map((entry) => [
      entry.name,
      entry.qualifiedName,
      entry.relativePath,
      entry.kind,
      entry.recordId,
      payloadKeyByUnit.get(entry.relativePath),
    ]);
    if (canonicalJson(search) !== canonicalJson(expectedSearch)) throw new RepositoryIntelligenceError("repository_cache_storage_invalid", "repository symbol search view is incomplete");

    const outline = objects.flatMap((object) => object.kind === "outline_view" ? object.symbols : []);
    const expectedOutline = records.symbols.filter((entry) => !entry.qualifiedName.includes(".")).map((entry) => [
      entry.relativePath,
      entry.recordId,
      entry.kind,
      entry.name,
      entry.range.startLine,
    ]);
    if (canonicalJson(outline) !== canonicalJson(expectedOutline)) throw new RepositoryIntelligenceError("repository_cache_storage_invalid", "repository outline view is incomplete");

    const referenceOrder = (entry: IndexedReference) => `${entry.sourcePath}\0${String(entry.range.startByte).padStart(16, "0")}\0${entry.relation}\0${entry.targetSymbolRecordId ?? ""}`;
    const postings = objects.flatMap((object) => object.kind === "reference_posting" ? object.references : [])
      .sort((left, right) => ordinal(referenceOrder(left), referenceOrder(right)));
    const expectedPostings = [...records.references]
      .sort((left, right) => ordinal(referenceOrder(left), referenceOrder(right)));
    if (canonicalJson(postings) !== canonicalJson(expectedPostings)) throw new RepositoryIntelligenceError("repository_cache_storage_invalid", "repository reference posting view is incomplete");

    const receipts = objects.flatMap((object) => object.kind === "fact_receipt" ? object.receipts : []);
    this.assertReceiptGraph(root, receipts);
  }

  private assertReceiptGraph(root: RepositoryStorageRootV2, receipts: readonly RepositoryFactReceiptV1[]): void {
    const byHash = new Map(receipts.map((receipt) => [receipt.receiptSha256, receipt]));
    if (byHash.size !== receipts.length) throw new RepositoryIntelligenceError("repository_cache_storage_invalid", "repository fact receipts repeat an identity");
    const objectHashes = new Set(allRepositoryObjectRefsV2(root).map((ref) => ref.sha256));
    const visiting = new Set<string>();
    const complete = new Set<string>();
    const visit = (receipt: RepositoryFactReceiptV1): void => {
      if (complete.has(receipt.receiptSha256)) return;
      if (visiting.has(receipt.receiptSha256)) throw new RepositoryIntelligenceError("repository_cache_storage_invalid", "repository fact receipt graph contains a cycle");
      if (!objectHashes.has(receipt.outputObjectSha256)) throw new RepositoryIntelligenceError("repository_cache_storage_invalid", "repository fact receipt output is absent");
      if (receipt.engineIdentitySha256 !== root.generation.engineIdentitySha256) throw new RepositoryIntelligenceError("repository_cache_storage_invalid", "repository fact receipt engine identity changed");
      visiting.add(receipt.receiptSha256);
      for (const dependency of receipt.dependencyFactSha256s) {
        const target = byHash.get(dependency);
        if (target === undefined) throw new RepositoryIntelligenceError("repository_cache_storage_invalid", "repository fact receipt dependency is absent");
        visit(target);
      }
      visiting.delete(receipt.receiptSha256);
      complete.add(receipt.receiptSha256);
    };
    for (const receipt of receipts) visit(receipt);
  }

  private async installObject(object: EncodedRepositoryCacheObjectV2): Promise<void> {
    const target = await this.paths.objectPath(object.ref.sha256, true);
    const created = await this.installImmutable(target, object.bytes, "object");
    if (created) this.counters.objectsCreated += 1;
    else this.counters.objectsReused += 1;
  }

  private async installImmutable(
    target: string,
    bytes: Buffer,
    kind: "lease" | "object" | "root",
  ): Promise<boolean> {
    const temporary = this.paths.temporaryFilePath(`${kind}-${randomUUID()}.tmp`);
    await this.paths.assertKnownPath(temporary, this.paths.temporaryRoot);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    let created = true;
    try {
      await link(temporary, target);
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      created = false;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    try {
      await syncInstalledFile(target, bytes);
    } catch (error) {
      throw new RepositoryIntelligenceError("repository_cache_storage_invalid", "repository cache immutable install collision or readback failure", 1, { cause: error });
    }
    if (created) this.counters.cacheBytesWritten += bytes.byteLength;
    return created;
  }

  private async publishPointer(pointer: RepositoryCurrentPointerV2): Promise<void> {
    const bytes = canonicalBytes(pointer);
    const temporary = join(this.paths.root, `.pointer-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await this.renameDurability.install(temporary, this.paths.currentPointerPath(), bytes);
      this.counters.cacheBytesWritten += bytes.byteLength;
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new RepositoryIntelligenceError("repository_index_publish_failed", "repository v2 current pointer publish failed", 1, { cause: error });
    }
    const verified = await this.readPointer();
    if (verified?.pointerSha256 !== pointer.pointerSha256) throw new RepositoryIntelligenceError("repository_index_publish_failed", "repository v2 pointer readback changed");
  }

  private async assertPublishAdmission(prospectiveBytes: number): Promise<void> {
    const v1Root = join(this.paths.repositoryCacheRoot, "v1");
    const [protectedV1Bytes, managedV2PhysicalBytes] = await Promise.all([
      this.measurePlainTree(v1Root),
      this.measurePlainTree(this.paths.root),
    ]);
    const required = protectedV1Bytes + managedV2PhysicalBytes + Math.max(repositoryCacheStoragePolicyV1.publishHeadroomBytes, prospectiveBytes);
    if (required > repositoryCacheStoragePolicyV1.softTotalBudgetBytes) {
      throw new RepositoryIntelligenceError(
        "repository_index_budget_exceeded",
        "repository cache publish cannot satisfy the combined v1/v2 soft budget",
        7,
      );
    }
  }

  private async assertQuarantineCapacity(additionalEntries: number, additionalBytes: number): Promise<void> {
    const entries = (await readdir(this.paths.quarantineRootsRoot)).length + (await readdir(this.paths.quarantineObjectsRoot)).length;
    const bytes = await this.measurePlainTree(this.paths.quarantineRoot);
    if (entries + additionalEntries > repositoryCacheStoragePolicyV1.maxQuarantineEntries ||
        bytes + additionalBytes > repositoryCacheStoragePolicyV1.maxQuarantineBytes) {
      throw new RepositoryIntelligenceError("repository_cache_storage_invalid", "repository cache quarantine capacity is exhausted", 7);
    }
  }

  private async measurePlainTree(root: string): Promise<number> {
    try {
      const metadata = await lstat(root);
      if (metadata.isSymbolicLink()) throw new Error("repository cache budget path is a link");
      if (metadata.isFile()) return metadata.size;
      if (!metadata.isDirectory()) throw new Error("repository cache budget path has an unsupported identity");
      let bytes = 0;
      for (const entry of await readdir(root)) bytes += await this.measurePlainTree(join(root, entry));
      return bytes;
    } catch (error) {
      if (isCode(error, "ENOENT")) return 0;
      throw new RepositoryIntelligenceError("repository_cache_storage_invalid", "repository cache budget accounting failed closed", 1, { cause: error });
    }
  }

  private async captureGcSnapshot(reclaimStaleLeases: boolean): Promise<{
    readonly activeLeaseCount: number;
    readonly candidates: readonly GarbageCandidate[];
    readonly liveReachableBytes: number;
    readonly staleLeasesReclaimed: number;
  }> {
    const pointer = await this.readPointer();
    const leaseNames = (await readdir(this.paths.leasesRoot)).sort(ordinal);
    if (leaseNames.length > repositoryCacheStoragePolicyV1.maxActiveLeases) throw new RepositoryIntelligenceError("repository_cache_lease_invalid", "repository lease directory exceeds its entry bound", 7);
    const decoded: { readonly bytes: number; readonly path: string; readonly record: RepositoryReaderLeaseV1 }[] = [];
    for (const name of leaseNames) {
      if (!/^[0-9a-f-]{36}\.json$/u.test(name)) throw new RepositoryIntelligenceError("repository_cache_lease_invalid", "repository lease directory has an unknown entry");
      const path = join(this.paths.leasesRoot, name);
      const bytes = await readBoundedRegular(path, repositoryCacheStoragePolicyV1.maxLeaseBytes);
      const record = repositoryReaderLeaseV1Schema.parse(parseCanonical(bytes));
      if (`${record.leaseId}.json` !== name) throw new RepositoryIntelligenceError("repository_cache_lease_invalid", "repository lease filename and identity disagree");
      decoded.push({ bytes: bytes.byteLength, path, record });
    }
    const stale: typeof decoded = [];
    const active: typeof decoded = [];
    for (const lease of decoded) {
      const age = this.now().getTime() - Date.parse(lease.record.createdAt);
      if (lease.record.hostFingerprint === this.hostFingerprint && Number.isFinite(age) && age >= this.minimumLeaseRecoveryAgeMs) {
        const owner = await this.ownerProbe.probe({ pid: lease.record.pid, startIdentity: lease.record.processStartIdentity });
        if (owner === "missing" || owner === "different") {
          stale.push(lease);
          continue;
        }
      }
      active.push(lease);
    }

    const reachableRoots = new Set<string>();
    if (pointer !== null) reachableRoots.add(pointer.storageManifestSha256);
    for (const lease of active) reachableRoots.add(lease.record.storageManifestSha256);
    const reachableObjects = new Map<string, RepositoryObjectRefV2>();
    let liveReachableBytes = 0;
    for (const rootSha of [...reachableRoots].sort(ordinal)) {
      const path = this.paths.rootManifestPath(rootSha);
      const metadata = await lstat(path);
      const root = await this.readRoot(rootSha);
      liveReachableBytes += metadata.size;
      for (const ref of allRepositoryObjectRefsV2(root)) {
        const previous = reachableObjects.get(ref.sha256);
        if (previous !== undefined && canonicalJson(previous) !== canonicalJson(ref)) {
          throw new RepositoryIntelligenceError("repository_cache_storage_invalid", "one repository object hash has conflicting root metadata");
        }
        reachableObjects.set(ref.sha256, ref);
      }
    }
    for (const [sha, ref] of [...reachableObjects].sort(([left], [right]) => ordinal(left, right))) {
      const metadata = await lstat(await this.paths.objectPath(sha));
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== ref.bytes) throw new RepositoryIntelligenceError("repository_cache_storage_invalid", "reachable repository object identity is invalid");
      await this.readObject(ref, true);
      liveReachableBytes += metadata.size;
    }

    const candidates: GarbageCandidate[] = [];
    const rootNames = (await readdir(this.paths.rootsRoot)).sort(ordinal);
    if (rootNames.length > repositoryCacheStoragePolicyV1.maxKnownRoots) throw new RepositoryIntelligenceError("repository_cache_gc_blocked", "repository root inventory exceeds its bound", 7);
    for (const name of rootNames) {
      const match = /^([a-f0-9]{64})\.json$/u.exec(name);
      if (match === null) continue;
      const sha = match[1]!;
      const path = join(this.paths.rootsRoot, name);
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      await this.readRoot(sha);
      if (!reachableRoots.has(sha)) candidates.push({ bytes: metadata.size, kind: "root", path, sha256: sha });
    }
    let objectCount = 0;
    for (const prefix of (await readdir(this.paths.objectsRoot)).sort(ordinal)) {
      if (!/^[a-f0-9]{2}$/u.test(prefix)) continue;
      const prefixPath = join(this.paths.objectsRoot, prefix);
      const prefixMetadata = await lstat(prefixPath);
      if (!prefixMetadata.isDirectory() || prefixMetadata.isSymbolicLink()) continue;
      for (const name of (await readdir(prefixPath)).sort(ordinal)) {
        const match = /^([a-f0-9]{64})\.data$/u.exec(name);
        if (match === null || !match[1]!.startsWith(prefix)) continue;
        objectCount += 1;
        if (objectCount > repositoryCacheStoragePolicyV1.maxManagedObjects) throw new RepositoryIntelligenceError("repository_cache_gc_blocked", "repository object inventory exceeds its bound", 7);
        const sha = match[1]!;
        const path = join(prefixPath, name);
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
        if (!reachableObjects.has(sha)) {
          await this.validateUnreferencedObject(path, sha);
          candidates.push({ bytes: metadata.size, kind: "object", path, sha256: sha });
        }
      }
    }
    if (reclaimStaleLeases) for (const lease of stale) await unlink(lease.path);
    return Object.freeze({
      activeLeaseCount: active.length,
      candidates: Object.freeze(candidates.sort((left, right) => ordinal(`${left.kind}\0${left.sha256}`, `${right.kind}\0${right.sha256}`))),
      liveReachableBytes,
      staleLeasesReclaimed: reclaimStaleLeases ? stale.length : 0,
    });
  }

  private async recoverGcPending(limit: number): Promise<number> {
    let recovered = 0;
    for (const sweep of (await readdir(this.paths.gcPendingRoot)).sort(ordinal)) {
      if (recovered >= limit) break;
      if (!/^[0-9a-f-]{36}$/u.test(sweep)) continue;
      const sweepRoot = join(this.paths.gcPendingRoot, sweep);
      await this.deletePendingSweep(sweepRoot);
      recovered += 1;
    }
    return recovered;
  }

  private async validateUnreferencedObject(path: string, sha256: string): Promise<void> {
    const bytes = await readBoundedRegular(path, repositoryCacheStoragePolicyV1.maxObjectBytes);
    const raw = parseCanonical(bytes);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw) || !("kind" in raw) || typeof raw.kind !== "string" ||
        !repositoryCacheObjectKindsV2.includes(raw.kind as RepositoryCacheObjectKindV2) ||
        !("logicalPartitionKey" in raw) || typeof raw.logicalPartitionKey !== "string") {
      throw new RepositoryIntelligenceError("repository_cache_gc_blocked", "unreferenced repository object has no strict logical identity");
    }
    const kind = raw.kind as RepositoryCacheObjectKindV2;
    const object = parseRepositoryCacheObjectV2(kind, raw);
    const ref = {
      bytes: bytes.byteLength,
      encoding: "canonical-json-v1" as const,
      kind,
      logicalPartitionKey: object.logicalPartitionKey,
      objectSchemaVersion: 1 as const,
      sha256,
    };
    if (repositoryCacheObjectSha256(ref, bytes) !== sha256) {
      throw new RepositoryIntelligenceError("repository_cache_gc_blocked", "unreferenced repository object digest is invalid");
    }
  }

  private async deletePendingSweep(sweepRoot: string): Promise<void> {
    for (const category of ["objects", "roots"] as const) {
      const root = join(sweepRoot, category);
      try {
        for (const name of await readdir(root)) {
          const valid = category === "objects" ? /^[a-f0-9]{64}\.data$/u.test(name) : /^[a-f0-9]{64}\.json$/u.test(name);
          if (!valid) throw new RepositoryIntelligenceError("repository_cache_gc_blocked", "GC pending directory contains an unknown entry");
          const path = join(root, name);
          const metadata = await lstat(path);
          if (!metadata.isFile() || metadata.isSymbolicLink()) throw new RepositoryIntelligenceError("repository_cache_gc_blocked", "GC pending entry is not a regular file");
          await unlink(path);
        }
        await rmdir(root);
      } catch (error) {
        if (!isCode(error, "ENOENT")) throw error;
      }
    }
    await rmdir(sweepRoot).catch((error: unknown) => {
      if (!isCode(error, "ENOENT")) throw error;
    });
  }
}
