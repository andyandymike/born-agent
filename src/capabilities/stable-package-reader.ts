import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve } from "node:path";

import { sha256Canonical } from "../completion/canonical-json.js";
import { SessionPathPolicy } from "../sessions/session-path-policy.js";
import { CapabilityError } from "./capability-errors.js";
import type {
  CapabilityComponentMetadata,
  CapabilityKind,
  PackageInventoryEntry,
  RequestedEffect,
  StableCapabilityPackageFile,
  StableCapabilityPackage,
} from "./capability-types.js";
import {
  MAX_CAPABILITY_PATH_BYTES,
  MAX_CAPABILITY_PATH_DEPTH,
  parseCapabilityComponentBytes,
  parsePluginManifestBytes,
  type ParsedCapabilityComponent,
  type ParsedPluginManifest,
} from "./plugin-manifest-schema.js";
import { installedPluginRecordSchema } from "../plugins/plugin-state-schema.js";
import { parseStrictJson } from "../system/strict-json.js";

export const MAX_CAPABILITY_PACKAGE_FILES = 512;
export const MAX_CAPABILITY_PACKAGE_BYTES = 16 * 1024 * 1024;
export const CAPABILITY_STORE_RECORD_PATH = ".bornagent-package-record.json";

interface FileIdentity {
  readonly ctimeMs: number;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly size: number;
}

interface StableReadFile {
  readonly bytes: Uint8Array;
  readonly identity: FileIdentity;
  readonly path: string;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function fileIdentity(stats: Stats): FileIdentity {
  return Object.freeze({
    ctimeMs: stats.ctimeMs,
    dev: stats.dev,
    ino: stats.ino,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  });
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Readonly<Record<string, unknown>>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function mediaType(path: string): string {
  const extension = posix.extname(path).toLowerCase();
  if (extension === ".json") return "application/json";
  if (extension === ".md") return "text/markdown; charset=utf-8";
  if ([".txt", ".ts", ".js", ".mjs", ".cjs", ".ps1", ".cmd", ".bat"].includes(extension)) {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

function isInside(root: string, candidate: string): boolean {
  const delta = relative(root, candidate);
  return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || code === 0x7f;
  });
}

function validateInventoryPath(path: string): void {
  const segments = path.split("/");
  if (
    segments.length > MAX_CAPABILITY_PATH_DEPTH ||
    Buffer.byteLength(path, "utf8") > MAX_CAPABILITY_PATH_BYTES
  ) {
    throw new CapabilityError(
      "capability_limit_exceeded",
      "package path exceeds its depth or byte limit",
    );
  }
  if (
    path.length === 0 ||
    path !== path.normalize("NFC") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    segments.some((segment) =>
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      hasControlCharacters(segment) ||
      /[<>:"|?*]/u.test(segment) ||
      /[. ]$/u.test(segment)
    )
  ) {
    throw new CapabilityError(
      "capability_path_invalid",
      "package contains a non-canonical or over-limit path",
    );
  }
}

async function stableReadFile(root: string, absolutePath: string): Promise<StableReadFile> {
  const lexical = resolve(absolutePath);
  if (!isInside(root, lexical)) {
    throw new CapabilityError("capability_path_invalid", "package file escapes its root");
  }
  const pathMetadata = await lstat(lexical);
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink() || pathMetadata.nlink !== 1) {
    throw new CapabilityError(
      "capability_source_untrusted",
      "package entries must be unique regular non-link files",
    );
  }
  const canonical = await realpath(lexical);
  if (!isInside(root, canonical) || resolve(canonical) !== lexical) {
    throw new CapabilityError(
      "capability_source_untrusted",
      "package file resolves through a link, junction, or alias",
    );
  }
  const handle = await open(lexical, "r");
  try {
    const beforeStats = await handle.stat();
    if (!beforeStats.isFile() || beforeStats.nlink !== 1) {
      throw new CapabilityError(
        "capability_source_untrusted",
        "package file handle is not a unique regular file",
      );
    }
    const before = fileIdentity(beforeStats);
    const bytes = await handle.readFile();
    const after = fileIdentity(await handle.stat());
    const current = fileIdentity(await lstat(lexical));
    if (
      !sameIdentity(before, after) ||
      !sameIdentity(after, current) ||
      bytes.byteLength !== after.size
    ) {
      throw new CapabilityError(
        "capability_source_unstable",
        "package file changed while it was being read",
      );
    }
    return Object.freeze({ bytes, identity: after, path: lexical });
  } finally {
    await handle.close();
  }
}

async function enumeratePaths(root: string): Promise<readonly string[]> {
  const paths: string[] = [];
  let totalBytes = 0;
  const seenCaseFolded = new Set<string>();
  const visit = async (absolute: string, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_CAPABILITY_PATH_DEPTH) {
      throw new CapabilityError("capability_limit_exceeded", "package path depth exceeds its limit");
    }
    const entries = await readdir(absolute, { withFileTypes: true });
    entries.sort((left, right) => ordinal(left.name, right.name));
    for (const entry of entries) {
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      validateInventoryPath(relativePath);
      const folded = relativePath.toLowerCase();
      if (seenCaseFolded.has(folded)) {
        throw new CapabilityError(
          "capability_path_invalid",
          "package paths collide under Windows path semantics",
        );
      }
      seenCaseFolded.add(folded);
      const child = join(absolute, entry.name);
      const metadata = await lstat(child);
      if (metadata.isSymbolicLink()) {
        throw new CapabilityError(
          "capability_source_untrusted",
          "package must not contain symbolic links or junctions",
        );
      }
      if (metadata.isDirectory()) {
        await visit(child, relativePath, depth + 1);
        continue;
      }
      if (!metadata.isFile() || metadata.nlink !== 1) {
        throw new CapabilityError(
          "capability_source_untrusted",
          "package supports unique regular files only",
        );
      }
      paths.push(relativePath);
      totalBytes += metadata.size;
      if (paths.length > MAX_CAPABILITY_PACKAGE_FILES || totalBytes > MAX_CAPABILITY_PACKAGE_BYTES) {
        throw new CapabilityError(
          "capability_limit_exceeded",
          "package exceeds its file-count or byte limit",
        );
      }
    }
  };
  await visit(root, "", 0);
  return Object.freeze(paths.sort(ordinal));
}

function relativeFromComponent(componentPath: string, declaredPath: string): string {
  const directory = posix.dirname(componentPath);
  const resolved = directory === "." ? declaredPath : posix.join(directory, declaredPath);
  validateInventoryPath(resolved);
  return resolved;
}

function assertDeclaredFilesExist(
  componentPath: string,
  component: ParsedCapabilityComponent,
  inventory: ReadonlyMap<string, StableReadFile>,
): void {
  const required: string[] = [];
  if (component.kind === "skill") {
    required.push(component.entry, ...(component.resources ?? []).map((resource) => resource.path));
  } else if (component.kind === "hook" && component.handler.type === "command") {
    required.push(component.handler.executable);
  } else if (component.kind === "mcp_server") {
    required.push(component.executable, ...component.integrity_files);
  }
  for (const declared of required) {
    const path = relativeFromComponent(componentPath, declared);
    if (!inventory.has(path)) {
      throw new CapabilityError(
        "capability_component_invalid",
        `component references a missing package file: ${path}`,
      );
    }
  }
}

function expectedKind(
  manifest: ParsedPluginManifest,
  componentPath: string,
): CapabilityKind | undefined {
  if (manifest.components.skills?.includes(componentPath) === true) return "skill";
  if (manifest.components.hooks?.includes(componentPath) === true) return "hook";
  if (manifest.components.mcp_servers?.includes(componentPath) === true) return "mcp_server";
  return undefined;
}

function componentPaths(manifest: ParsedPluginManifest): readonly string[] {
  return Object.freeze([
    ...(manifest.components.skills ?? []),
    ...(manifest.components.hooks ?? []),
    ...(manifest.components.mcp_servers ?? []),
  ].sort(ordinal));
}

function freezeEffects(values: readonly RequestedEffect[] | undefined): readonly RequestedEffect[] {
  return Object.freeze([...(values ?? [])].sort(ordinal));
}

function componentMetadata(
  path: string,
  file: StableReadFile,
  parsed: ParsedCapabilityComponent,
): CapabilityComponentMetadata {
  return Object.freeze({
    componentId: parsed.component_id,
    componentPath: path,
    componentSha256: createHash("sha256").update(file.bytes).digest("hex"),
    description: parsed.description,
    displayName: parsed.display_name,
    kind: parsed.kind,
    metadata: deepFreeze(parsed),
    requestedEffects: freezeEffects(
      parsed.kind === "skill" ? undefined : parsed.requested_effects,
    ),
  });
}

export class StablePackageReader {
  static async read(packageRoot: string): Promise<StableCapabilityPackage> {
    if (!isAbsolute(packageRoot)) {
      throw new CapabilityError(
        "capability_source_untrusted",
        "capability package root must be absolute",
      );
    }
    let policy: SessionPathPolicy;
    try {
      policy = await SessionPathPolicy.create(resolve(packageRoot));
    } catch (error) {
      throw new CapabilityError(
        "capability_source_untrusted",
        "capability package root is not a stable non-link directory",
        2,
        { cause: error },
      );
    }
    const root = policy.workspaceRealPath;
    const rootBefore = fileIdentity(await lstat(root));
    const firstPaths = await enumeratePaths(root);
    const packagePaths = firstPaths.filter((path) => path !== CAPABILITY_STORE_RECORD_PATH);
    if (!packagePaths.includes("bornagent.plugin.json")) {
      throw new CapabilityError(
        "capability_manifest_invalid",
        "package root has no bornagent.plugin.json",
      );
    }
    const files = new Map<string, StableReadFile>();
    for (const path of firstPaths) {
      files.set(path, await stableReadFile(root, join(root, ...path.split("/"))));
    }
    const secondPaths = await enumeratePaths(root);
    const rootAfter = fileIdentity(await lstat(root));
    if (
      firstPaths.join("\0") !== secondPaths.join("\0") ||
      !sameIdentity(rootBefore, rootAfter)
    ) {
      throw new CapabilityError(
        "capability_source_unstable",
        "package inventory changed while it was being read",
      );
    }
    for (const path of firstPaths) {
      const frozen = files.get(path)!;
      const current = fileIdentity(
        await lstat(join(root, ...path.split("/"))),
      );
      if (!sameIdentity(frozen.identity, current)) {
        throw new CapabilityError(
          "capability_source_unstable",
          "package file changed after its stable read and before freeze",
        );
      }
    }

    const manifestFile = files.get("bornagent.plugin.json")!;
    const manifest = deepFreeze(parsePluginManifestBytes(manifestFile.bytes));
    const manifestSha256 = createHash("sha256").update(manifestFile.bytes).digest("hex");
    const components: CapabilityComponentMetadata[] = [];
    const seenIds = new Set<string>();
    for (const path of componentPaths(manifest)) {
      const file = files.get(path);
      if (file === undefined) {
        throw new CapabilityError(
          "capability_component_invalid",
          `manifest references a missing component: ${path}`,
        );
      }
      const parsed = parseCapabilityComponentBytes(file.bytes);
      const kind = expectedKind(manifest, path);
      if (kind === undefined || parsed.kind !== kind) {
        throw new CapabilityError(
          "capability_component_invalid",
          `component kind does not match its manifest section: ${path}`,
        );
      }
      const collisionKey = `${parsed.kind}:${parsed.component_id.toLowerCase()}`;
      if (seenIds.has(collisionKey)) {
        throw new CapabilityError(
          "capability_component_invalid",
          "component IDs must be unique within each kind",
        );
      }
      seenIds.add(collisionKey);
      assertDeclaredFilesExist(path, parsed, files);
      components.push(componentMetadata(path, file, parsed));
    }

    const inventory: readonly PackageInventoryEntry[] = Object.freeze(
      packagePaths.map((path) => {
        const file = files.get(path)!;
        return Object.freeze({
          byteLength: file.bytes.byteLength,
          mediaType: mediaType(path),
          path,
          sha256: createHash("sha256").update(file.bytes).digest("hex"),
        });
      }),
    );
    const stableFiles: readonly StableCapabilityPackageFile[] = Object.freeze(
      packagePaths.map((path) => {
        const file = files.get(path)!;
        return Object.freeze({
          // Callers receive a private immutable-by-convention capture instead
          // of a live file handle or a path that could be rebound later.
          bytes: Uint8Array.from(file.bytes),
          path,
          sha256: createHash("sha256").update(file.bytes).digest("hex"),
        });
      }),
    );
    const inventorySha256 = sha256Canonical({ files: inventory, schemaVersion: 1 });
    const pluginSha256 = sha256Canonical({
      files: inventory,
      manifestSha256,
      schemaVersion: 1,
    });
    const storeRecordFile = files.get(CAPABILITY_STORE_RECORD_PATH);
    if (storeRecordFile !== undefined) {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(storeRecordFile.bytes);
        const record = installedPluginRecordSchema.parse(parseStrictJson(text));
        if (
          record.pluginId !== manifest.plugin_id ||
          record.pluginVersion !== manifest.plugin_version ||
          record.pluginSha256 !== pluginSha256 ||
          record.manifestSha256 !== manifestSha256 ||
          record.inventorySha256 !== inventorySha256
        ) {
          throw new Error("record identity does not match package bytes");
        }
      } catch (error) {
        throw new CapabilityError(
          "capability_state_invalid",
          "installed package record does not match its immutable package bytes",
          2,
          { cause: error },
        );
      }
    }
    // PHASE18: identity is derived only from bytes read through stable handles;
    // a later path lookup can never silently rebind this package to new bytes.
    return Object.freeze({
      components: Object.freeze(components.sort((left, right) =>
        ordinal(`${left.kind}:${left.componentId}`, `${right.kind}:${right.componentId}`),
      )),
      description: manifest.description,
      displayName: manifest.display_name,
      files: stableFiles,
      inventory,
      inventorySha256,
      manifestBytes: manifestFile.bytes,
      manifest,
      manifestSha256,
      packageRoot: root,
      pluginId: manifest.plugin_id,
      pluginSha256,
      pluginVersion: manifest.plugin_version,
    });
  }
}
