import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";

import { z } from "zod";

import { canonicalJson, sha256Canonical } from "../completion/canonical-json.js";
import { NodeRenameDurabilityPort, type RenameDurabilityPort } from "../sessions/rename-durability.js";
import { parseStrictJson } from "../system/strict-json.js";
import { indexGenerationSchema, type IndexGenerationV1 } from "./index-generation-schema.js";
import type { BuiltIndexGeneration } from "./index-generation.js";
import { RepositoryIndexPathPolicy } from "./index-path-policy.js";
import {
  indexedImportSchema,
  indexedReferenceSchema,
  indexedSourceUnitSchema,
  indexedSymbolSchema,
  sha256Schema,
  type RepositoryIndexRecords,
} from "./navigation-types.js";
import { RepositoryIntelligenceError } from "./repository-intelligence-error.js";

const DATA_MAX_BYTES = 512 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;

const storedFileSchema = z.object({ bytes: z.number().int().nonnegative().max(DATA_MAX_BYTES), sha256: sha256Schema }).strict();

const storedIndexManifestSchema = z
  .object({
    encoding: z.literal("canonical-json-v1"),
    files: z.object({ references: storedFileSchema, symbols: storedFileSchema, units: storedFileSchema }).strict(),
    generation: indexGenerationSchema,
    manifestSha256: sha256Schema,
    schemaVersion: z.literal(1),
  })
  .strict()
  .superRefine((value, context) => {
    const unsigned = { encoding: value.encoding, files: value.files, generation: value.generation, schemaVersion: value.schemaVersion };
    if (sha256Canonical(unsigned) !== value.manifestSha256) context.addIssue({ code: "custom", message: "stored index manifest hash mismatch" });
  });

const currentPointerSchema = z
  .object({
    engineIdentitySha256: sha256Schema,
    generationSha256: sha256Schema,
    pointerSha256: sha256Schema,
    ruleManifestSha256: sha256Schema,
    schemaVersion: z.literal(1),
    sourceStateSha256: sha256Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const unsigned = {
      engineIdentitySha256: value.engineIdentitySha256,
      generationSha256: value.generationSha256,
      ruleManifestSha256: value.ruleManifestSha256,
      schemaVersion: value.schemaVersion,
      sourceStateSha256: value.sourceStateSha256,
    };
    if (sha256Canonical(unsigned) !== value.pointerSha256) context.addIssue({ code: "custom", message: "index current pointer hash mismatch" });
  });

export type RepositoryIndexCurrentPointer = Readonly<z.infer<typeof currentPointerSchema>>;

export interface StoredRepositoryIndex {
  readonly generation: IndexGenerationV1;
  readonly manifestSha256: string;
  readonly records: RepositoryIndexRecords;
}

export interface RepositoryIndexLockLike {
  assertOwned(): Promise<void>;
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function writeData(path: string, value: unknown): Promise<{ readonly bytes: number; readonly sha256: string }> {
  const encoded = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  if (encoded.byteLength > DATA_MAX_BYTES) throw new RepositoryIntelligenceError("repository_index_budget_exceeded", "repository index table exceeds its hard bound", 7);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(encoded);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const readback = await readFile(path);
  if (!readback.equals(encoded)) throw new RepositoryIntelligenceError("repository_index_publish_failed", "repository index table readback mismatch");
  return Object.freeze({ bytes: encoded.byteLength, sha256: sha256Canonical(value) });
}

async function readBoundedRegular(path: string, maxBytes: number): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > maxBytes) {
    throw new Error("index cache file identity or size is invalid");
  }
  return readFile(path);
}

function parseCanonicalFile(bytes: Buffer): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = parseStrictJson(text);
  if (`${canonicalJson(value)}\n` !== text) throw new Error("index data is not canonical JSON");
  return value;
}

export class RepositoryIndexStore {
  private readonly renameDurability: RenameDurabilityPort;

  constructor(
    readonly paths: RepositoryIndexPathPolicy,
    renameDurability: RenameDurabilityPort = new NodeRenameDurabilityPort(),
  ) {
    this.renameDurability = renameDurability;
  }

  static async create(workspace: string): Promise<RepositoryIndexStore> {
    return new RepositoryIndexStore(await RepositoryIndexPathPolicy.create(workspace));
  }

  static async openExisting(workspace: string): Promise<RepositoryIndexStore | null> {
    const paths = await RepositoryIndexPathPolicy.openExisting(workspace);
    return paths === null ? null : new RepositoryIndexStore(paths);
  }

  async publish(input: BuiltIndexGeneration, lock: RepositoryIndexLockLike): Promise<StoredRepositoryIndex> {
    await lock.assertOwned();
    const generationPath = this.paths.generationPath(input.generation.generationSha256);
    let corruptGeneration: boolean;
    try {
      const existing = await this.readGeneration(input.generation.generationSha256);
      if (existing.generation.sourceStateSha256 !== input.generation.sourceStateSha256) throw new Error("existing generation identity collision");
      await this.publishPointer(existing.generation, lock);
      return existing;
    } catch (error) {
      if (!isCode(error, "ENOENT") && !(error instanceof RepositoryIntelligenceError && error.code === "repository_index_corrupt")) throw error;
      corruptGeneration = error instanceof RepositoryIntelligenceError && error.code === "repository_index_corrupt";
    }

    if (corruptGeneration) await this.quarantineCorruptGeneration(input.generation.generationSha256, lock);

    const temporaryName = `build-${randomUUID()}`;
    const temporary = this.paths.temporaryGenerationPath(temporaryName);
    await this.paths.assertKnownPath(temporary, this.paths.temporaryRoot);
    await mkdir(temporary);
    try {
      const units = await writeData(join(temporary, "units.data"), input.records.units);
      const symbols = await writeData(join(temporary, "symbols.data"), input.records.symbols);
      const references = await writeData(join(temporary, "references.data"), { imports: input.records.imports, references: input.records.references });
      const unsignedManifest = {
        encoding: "canonical-json-v1" as const,
        files: { references, symbols, units },
        generation: input.generation,
        schemaVersion: 1 as const,
      };
      const manifest = storedIndexManifestSchema.parse({ ...unsignedManifest, manifestSha256: sha256Canonical(unsignedManifest) });
      await writeData(join(temporary, "manifest.json"), manifest);
      await lock.assertOwned();
      try {
        await rename(temporary, generationPath);
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
      }
      // PHASE17: the immutable directory becomes addressable before current.json. A crash can
      // leave an orphan complete generation, never a pointer to half-written data.
      const installed = await this.readGeneration(input.generation.generationSha256);
      await this.publishPointer(installed.generation, lock);
      return installed;
    } catch (error) {
      throw error instanceof RepositoryIntelligenceError
        ? error
        : new RepositoryIntelligenceError("repository_index_publish_failed", "repository index generation publish failed", 1, { cause: error });
    } finally {
      await rm(temporary, { force: true, recursive: true }).catch(() => undefined);
    }
  }

  async readCurrent(): Promise<StoredRepositoryIndex | null> {
    const path = join(this.paths.root, "current.json");
    let pointer: RepositoryIndexCurrentPointer;
    try {
      pointer = currentPointerSchema.parse(parseCanonicalFile(await readBoundedRegular(path, MANIFEST_MAX_BYTES)));
    } catch (error) {
      if (isCode(error, "ENOENT")) return null;
      throw new RepositoryIntelligenceError("repository_index_corrupt", "repository index current pointer is invalid", 1, { cause: error });
    }
    const stored = await this.readGeneration(pointer.generationSha256);
    if (
      stored.generation.engineIdentitySha256 !== pointer.engineIdentitySha256 ||
      stored.generation.sourceStateSha256 !== pointer.sourceStateSha256 ||
      stored.generation.ruleManifestSha256 !== pointer.ruleManifestSha256
    ) throw new RepositoryIntelligenceError("repository_index_corrupt", "repository index pointer does not match its generation");
    return stored;
  }

  async readGeneration(generationSha256: string): Promise<StoredRepositoryIndex> {
    try {
      const root = this.paths.generationPath(generationSha256);
      await this.paths.assertKnownPath(root, this.paths.generationsRoot);
      const canonicalRoot = await realpath(root);
      if (basename(canonicalRoot) !== generationSha256) throw new Error("generation path was redirected");
      const names = (await readdir(root)).sort();
      if (canonicalJson(names) !== canonicalJson(["manifest.json", "references.data", "symbols.data", "units.data"])) {
        throw new Error("generation contains unknown or missing files");
      }
      const manifest = storedIndexManifestSchema.parse(parseCanonicalFile(await readBoundedRegular(join(root, "manifest.json"), MANIFEST_MAX_BYTES)));
      if (manifest.generation.generationSha256 !== generationSha256) throw new Error("generation directory name does not match manifest");
      const [unitsBytes, symbolsBytes, referencesBytes] = await Promise.all([
        readBoundedRegular(join(root, "units.data"), DATA_MAX_BYTES),
        readBoundedRegular(join(root, "symbols.data"), DATA_MAX_BYTES),
        readBoundedRegular(join(root, "references.data"), DATA_MAX_BYTES),
      ]);
      const unitsRaw = parseCanonicalFile(unitsBytes);
      const symbolsRaw = parseCanonicalFile(symbolsBytes);
      const referencesRaw = parseCanonicalFile(referencesBytes);
      const referencesEnvelope = z.object({ imports: z.array(indexedImportSchema), references: z.array(indexedReferenceSchema) }).strict().parse(referencesRaw);
      const records = {
        imports: referencesEnvelope.imports,
        references: referencesEnvelope.references,
        symbols: z.array(indexedSymbolSchema).parse(symbolsRaw),
        units: z.array(indexedSourceUnitSchema).parse(unitsRaw),
      };
      if (
        manifest.files.units.bytes !== unitsBytes.byteLength ||
        manifest.files.symbols.bytes !== symbolsBytes.byteLength ||
        manifest.files.references.bytes !== referencesBytes.byteLength ||
        manifest.files.units.sha256 !== sha256Canonical(records.units) ||
        manifest.files.symbols.sha256 !== sha256Canonical(records.symbols) ||
        manifest.files.references.sha256 !== sha256Canonical({ imports: records.imports, references: records.references })
      ) throw new Error("generation table hash or size mismatch");
      return Object.freeze({ generation: manifest.generation, manifestSha256: manifest.manifestSha256, records: Object.freeze(records) });
    } catch (error) {
      if (error instanceof RepositoryIntelligenceError) throw error;
      throw new RepositoryIntelligenceError("repository_index_corrupt", "repository index generation is corrupt", 1, { cause: error });
    }
  }

  async recoverOwnedTemps(limit = 128): Promise<number> {
    const names = (await readdir(this.paths.temporaryRoot)).filter((name) =>
      /^build-[0-9a-f-]{36}$/u.test(name)).slice(0, limit);
    for (const name of names) {
      const path = this.paths.temporaryGenerationPath(name);
      await this.paths.assertKnownPath(path, this.paths.temporaryRoot);
      const metadata = await lstat(path);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue;
      await rm(path, { force: true, recursive: true });
    }
    return names.length;
  }

  private async quarantineCorruptGeneration(
    generationSha256: string,
    lock: RepositoryIndexLockLike,
  ): Promise<void> {
    await lock.assertOwned();
    const source = this.paths.generationPath(generationSha256);
    const target = this.paths.quarantineGenerationPath(generationSha256, randomUUID());
    await this.paths.assertKnownPath(source, this.paths.generationsRoot);
    await this.paths.assertKnownPath(target, this.paths.quarantineRoot);
    try {
      const metadata = await lstat(source);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new RepositoryIntelligenceError(
          "repository_index_corrupt",
          "repository index generation cannot be safely quarantined",
        );
      }
      await lock.assertOwned();
      await rename(source, target);
    } catch (error) {
      if (isCode(error, "ENOENT")) return;
      throw error;
    }
  }

  private async publishPointer(generation: IndexGenerationV1, lock: RepositoryIndexLockLike): Promise<void> {
    await lock.assertOwned();
    const unsigned = {
      engineIdentitySha256: generation.engineIdentitySha256,
      generationSha256: generation.generationSha256,
      ruleManifestSha256: generation.ruleManifestSha256,
      schemaVersion: 1 as const,
      sourceStateSha256: generation.sourceStateSha256,
    };
    const pointer = currentPointerSchema.parse({ ...unsigned, pointerSha256: sha256Canonical(unsigned) });
    const bytes = Buffer.from(`${canonicalJson(pointer)}\n`, "utf8");
    const target = join(this.paths.root, "current.json");
    const temporary = join(this.paths.root, `.current.${process.pid}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await lock.assertOwned();
    try {
      await this.renameDurability.install(temporary, target, bytes);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
