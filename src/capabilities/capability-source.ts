import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { z } from "zod";

import { parseStrictJson } from "../system/strict-json.js";
import { SessionPathPolicy } from "../sessions/session-path-policy.js";
import { CapabilityError } from "./capability-errors.js";
import type {
  CapabilityPackageCandidate,
  CapabilitySource,
  CapabilitySourceDiscovery,
  CapabilitySourceKind,
} from "./capability-types.js";
import {
  capabilityIdentifierSchema,
  capabilityRelativePathSchema,
  capabilityVersionSchema,
} from "./plugin-manifest-schema.js";

const MAX_SOURCE_INDEX_BYTES = 256 * 1024;
const MAX_SOURCE_CANDIDATES = 32;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const sourceEntrySchema = z
  .object({
    enabled: z.boolean(),
    expected_plugin_sha256: sha256,
    path: capabilityRelativePathSchema,
    plugin_id: capabilityIdentifierSchema,
    plugin_version: capabilityVersionSchema,
  })
  .strict();
const sourceIndexSchema = z
  .object({
    schema_version: z.literal(1),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    packages: z
      .array(sourceEntrySchema)
      .max(MAX_SOURCE_CANDIDATES)
      .refine(
        (entries) => new Set(entries.map((entry) => entry.path.toLowerCase())).size === entries.length,
        "source package paths must be unique under Windows path semantics",
      ),
  })
  .strict();

interface CapabilitySourceIndex {
  readonly packages: readonly z.infer<typeof sourceEntrySchema>[];
  readonly revision: number;
  readonly schema_version: 1;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isInside(root: string, candidate: string): boolean {
  const delta = relative(resolve(root), resolve(candidate));
  return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
}

async function readIndex(
  path: string,
  options: { readonly required: boolean; readonly source: CapabilitySourceKind },
): Promise<CapabilitySourceIndex | null> {
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw new CapabilityError(
        "capability_source_untrusted",
        `${options.source} capability index must be a unique regular non-link file`,
        options.source === "builtin" ? 3 : 2,
      );
    }
    if (before.size < 1 || before.size > MAX_SOURCE_INDEX_BYTES) {
      throw new CapabilityError(
        "capability_state_invalid",
        `${options.source} capability index exceeds its byte limit`,
        options.source === "builtin" ? 3 : 2,
      );
    }
    let stablePath: string;
    try {
      const policy = await SessionPathPolicy.create(dirname(path));
      stablePath = join(policy.workspaceRealPath, basename(path));
    } catch (error) {
      throw new CapabilityError(
        "capability_source_untrusted",
        `${options.source} capability index parent is not a stable directory`,
        options.source === "builtin" ? 3 : 2,
        { cause: error },
      );
    }
    const canonical = await realpath(stablePath);
    const canonicalMetadata = await lstat(canonical);
    if (
      canonicalMetadata.dev !== before.dev ||
      canonicalMetadata.ino !== before.ino ||
      canonicalMetadata.nlink !== 1
    ) {
      throw new CapabilityError(
        "capability_source_untrusted",
        `${options.source} capability index resolves through an alias`,
        options.source === "builtin" ? 3 : 2,
      );
    }
    const handle = await open(stablePath, "r");
    let bytes: Uint8Array;
    try {
      const handleBefore = await handle.stat();
      bytes = await handle.readFile();
      const handleAfter = await handle.stat();
      const after = await lstat(stablePath);
      if (
        bytes.byteLength !== handleAfter.size ||
        handleBefore.dev !== before.dev ||
        handleBefore.ino !== before.ino ||
        handleBefore.nlink !== 1 ||
        handleBefore.size !== before.size ||
        handleBefore.ctimeMs !== before.ctimeMs ||
        handleBefore.mtimeMs !== before.mtimeMs ||
        handleAfter.dev !== handleBefore.dev ||
        handleAfter.ino !== handleBefore.ino ||
        handleAfter.nlink !== 1 ||
        handleAfter.size !== handleBefore.size ||
        handleAfter.ctimeMs !== handleBefore.ctimeMs ||
        handleAfter.mtimeMs !== handleBefore.mtimeMs ||
        after.dev !== handleAfter.dev ||
        after.ino !== handleAfter.ino ||
        after.nlink !== 1 ||
        after.size !== handleAfter.size ||
        after.ctimeMs !== handleAfter.ctimeMs ||
        after.mtimeMs !== handleAfter.mtimeMs
      ) {
        throw new CapabilityError(
          "capability_source_unstable",
          `${options.source} capability index changed while it was read`,
          options.source === "builtin" ? 3 : 2,
        );
      }
    } finally {
      await handle.close();
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new CapabilityError(
        "capability_state_invalid",
        `${options.source} capability index must be valid UTF-8`,
        options.source === "builtin" ? 3 : 2,
        { cause: error },
      );
    }
    try {
      return sourceIndexSchema.parse(parseStrictJson(text));
    } catch (error) {
      throw new CapabilityError(
        "capability_state_invalid",
        `${options.source} capability index failed strict validation`,
        options.source === "builtin" ? 3 : 2,
        { cause: error },
      );
    }
  } catch (error) {
    if (isMissing(error)) {
      if (!options.required) return null;
      throw new CapabilityError(
        "capability_state_invalid",
        `${options.source} capability index is missing`,
        options.source === "builtin" ? 3 : 2,
        { cause: error },
      );
    }
    throw error;
  }
}

function candidate(
  root: string,
  source: CapabilitySourceKind,
  revision: number,
  entry: z.infer<typeof sourceEntrySchema>,
): CapabilityPackageCandidate {
  const packageRoot = resolve(root, ...entry.path.split("/"));
  if (!isInside(root, packageRoot)) {
    throw new CapabilityError(
      "capability_source_untrusted",
      `${source} package path escapes its source root`,
    );
  }
  return Object.freeze({
    enabled: entry.enabled,
    enablementRevision: revision,
    expectedPluginId: entry.plugin_id,
    expectedPluginSha256: entry.expected_plugin_sha256,
    expectedPluginVersion: entry.plugin_version,
    packageRoot,
    source,
    sourceRef: `${source}:${entry.path}`,
  });
}

abstract class IndexedCapabilitySource implements CapabilitySource {
  protected abstract readonly indexPath: string;
  protected abstract readonly required: boolean;
  protected abstract readonly root: string;
  abstract readonly source: CapabilitySourceKind;

  async discover(): Promise<CapabilitySourceDiscovery> {
    // PHASE18: enablement selects an exact candidate for validation; it never
    // grants any requested filesystem, process, or network effect.
    const index = await readIndex(this.indexPath, {
      required: this.required,
      source: this.source,
    });
    const revision = index?.revision ?? 0;
    return Object.freeze({
      candidates: Object.freeze(
        (index?.packages ?? []).map((entry) =>
          candidate(this.root, this.source, revision, entry),
        ),
      ),
      revision,
      source: this.source,
    });
  }
}

export class BuiltinCapabilitySource extends IndexedCapabilitySource {
  readonly source = "builtin" as const;
  protected readonly indexPath: string;
  protected readonly required = true;
  protected readonly root: string;

  constructor(root: string) {
    super();
    this.root = resolve(root);
    this.indexPath = join(this.root, "index.json");
  }
}

export function resolveCapabilityUserStateRoot(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
}): string {
  if (input.platform === "win32") {
    return join(
      input.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "BornAgent",
      "capabilities",
      "v1",
    );
  }
  return join(
    input.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "bornagent",
    "capabilities",
    "v1",
  );
}

export class UserInstallCapabilitySource extends IndexedCapabilitySource {
  readonly source = "user_install" as const;
  protected readonly indexPath: string;
  protected readonly required = false;
  protected readonly root: string;

  constructor(root: string) {
    super();
    this.root = resolve(root);
    this.indexPath = join(this.root, "enablement.json");
  }
}

export class WorkspaceCapabilitySource extends IndexedCapabilitySource {
  readonly source = "workspace" as const;
  protected readonly indexPath: string;
  protected readonly required = false;
  protected readonly root: string;

  constructor(workspace: string) {
    super();
    this.root = resolve(workspace);
    this.indexPath = join(this.root, ".bornagent", "capabilities.json");
  }
}
