import { constants } from "node:fs";
import type { Stats } from "node:fs";
import {
  lstat,
  open,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve,
  win32,
} from "node:path";
import { z } from "zod";

import { parseStrictJson, StrictJsonError } from "../system/strict-json.js";
import {
  planItemAcceptanceSchema,
  planItemIdSchema,
  planTitleSchema,
} from "./plan-schema.js";

export const MAX_PLAN_FILE_BYTES = 64 * 1024;

export const userEditablePlanSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            acceptance: planItemAcceptanceSchema,
            id: planItemIdSchema,
            required: z.boolean(),
            title: planTitleSchema,
          })
          .strict(),
      )
      .min(1)
      .max(32)
      .superRefine((items, context) => {
        const ids = new Set<string>();
        for (const [index, item] of items.entries()) {
          if (ids.has(item.id)) {
            context.addIssue({
              code: "custom",
              message: "plan item ids must be unique",
              path: [index, "id"],
            });
          }
          ids.add(item.id);
        }
      }),
    schema_version: z.literal(1),
    title: planTitleSchema,
  })
  .strict();

type ParsedUserEditablePlan = z.infer<typeof userEditablePlanSchema>;

export type UserEditablePlan = Readonly<
  Omit<ParsedUserEditablePlan, "items"> & {
    readonly items: readonly Readonly<ParsedUserEditablePlan["items"][number]>[];
  }
>;

export type PlanFileLoaderErrorCode =
  | "plan_file_invalid"
  | "plan_file_invalid_utf8"
  | "plan_file_io_failed"
  | "plan_file_link_denied"
  | "plan_file_not_regular"
  | "plan_file_outside_workspace"
  | "plan_file_too_large"
  | "plan_file_unstable"
  | "workspace_invalid";

export class PlanFileLoaderError extends Error {
  override readonly name = "PlanFileLoaderError";

  constructor(
    readonly code: PlanFileLoaderErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface PlanFileSystem {
  lstat(path: string): Promise<Stats>;
  open(path: string, flags: number): Promise<FileHandle>;
  realpath(path: string): Promise<string>;
}

const nodeFileSystem: PlanFileSystem = { lstat, open, realpath };

interface FileIdentity {
  readonly ctimeMs: number;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly size: number;
}

function identity(metadata: Stats): FileIdentity {
  return {
    ctimeMs: metadata.ctimeMs,
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    mtimeMs: metadata.mtimeMs,
    size: metadata.size,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function platformPath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function isContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith("../") &&
      !difference.startsWith("..\\") &&
      !isAbsolute(difference))
  );
}

function boundedDisplayPath(path: string): string {
  const safe = Array.from(path, (character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? "?" : character;
  }).join("");
  return safe.length <= 200 ? safe : `${safe.slice(0, 197)}...`;
}

function invalidPath(path: string): never {
  throw new PlanFileLoaderError(
    "plan_file_outside_workspace",
    `plan file path must be workspace-relative: ${boundedDisplayPath(path)}`,
  );
}

function freezePlan(plan: ParsedUserEditablePlan): UserEditablePlan {
  return Object.freeze({
    items: Object.freeze(
      plan.items.map((item) => Object.freeze({ ...item })),
    ),
    schema_version: 1,
    title: plan.title,
  });
}

export class PlanFileLoader {
  constructor(private readonly fileSystem: PlanFileSystem = nodeFileSystem) {}

  async load(workspace: string, userPath: string): Promise<UserEditablePlan> {
    if (
      userPath.length === 0 ||
      userPath.includes("\u0000") ||
      isAbsolute(userPath) ||
      win32.isAbsolute(userPath) ||
      /^[a-zA-Z]:/u.test(userPath)
    ) {
      invalidPath(userPath);
    }

    let workspaceRealPath: string;
    try {
      workspaceRealPath = await this.fileSystem.realpath(resolve(workspace));
      const workspaceMetadata = await this.fileSystem.lstat(workspaceRealPath);
      if (
        workspaceMetadata.isSymbolicLink() ||
        !workspaceMetadata.isDirectory()
      ) {
        throw new PlanFileLoaderError(
          "workspace_invalid",
          "workspace must resolve to a regular directory",
        );
      }
    } catch (error) {
      if (error instanceof PlanFileLoaderError) throw error;
      throw new PlanFileLoaderError(
        "workspace_invalid",
        "workspace could not be resolved",
        { cause: error },
      );
    }

    const lexicalPath = resolve(workspaceRealPath, userPath);
    if (!isContained(workspaceRealPath, lexicalPath)) invalidPath(userPath);

    let namedBefore: Stats;
    try {
      namedBefore = await this.fileSystem.lstat(lexicalPath);
    } catch (error) {
      throw new PlanFileLoaderError(
        "plan_file_io_failed",
        `plan file could not be inspected: ${boundedDisplayPath(userPath)}`,
        { cause: error },
      );
    }
    if (namedBefore.isSymbolicLink()) {
      throw new PlanFileLoaderError(
        "plan_file_link_denied",
        `plan file must not use a symlink or junction: ${boundedDisplayPath(userPath)}`,
      );
    }
    if (!namedBefore.isFile()) {
      throw new PlanFileLoaderError(
        "plan_file_not_regular",
        `plan path is not a regular file: ${boundedDisplayPath(userPath)}`,
      );
    }
    if (namedBefore.size > MAX_PLAN_FILE_BYTES) {
      throw new PlanFileLoaderError(
        "plan_file_too_large",
        `plan file exceeds 64 KiB: ${boundedDisplayPath(userPath)}`,
      );
    }

    let canonicalBefore: string;
    try {
      canonicalBefore = await this.fileSystem.realpath(lexicalPath);
    } catch (error) {
      throw new PlanFileLoaderError(
        "plan_file_io_failed",
        `plan file could not be resolved: ${boundedDisplayPath(userPath)}`,
        { cause: error },
      );
    }
    if (
      !isContained(workspaceRealPath, canonicalBefore) ||
      platformPath(canonicalBefore) !== platformPath(lexicalPath)
    ) {
      throw new PlanFileLoaderError(
        "plan_file_link_denied",
        `plan file must not traverse a link: ${boundedDisplayPath(userPath)}`,
      );
    }

    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    let handle: FileHandle;
    try {
      handle = await this.fileSystem.open(
        lexicalPath,
        constants.O_RDONLY | noFollow,
      );
    } catch (error) {
      throw new PlanFileLoaderError(
        "plan_file_io_failed",
        `plan file could not be opened: ${boundedDisplayPath(userPath)}`,
        { cause: error },
      );
    }

    try {
      const handleBefore = await handle.stat();
      if (
        !handleBefore.isFile() ||
        !sameIdentity(identity(namedBefore), identity(handleBefore))
      ) {
        throw new PlanFileLoaderError(
          "plan_file_unstable",
          `plan file changed before read: ${boundedDisplayPath(userPath)}`,
        );
      }

      const capture = Buffer.allocUnsafe(MAX_PLAN_FILE_BYTES + 1);
      let offset = 0;
      while (offset < capture.byteLength) {
        const result = await handle.read(
          capture,
          offset,
          capture.byteLength - offset,
          offset,
        );
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      if (offset > MAX_PLAN_FILE_BYTES) {
        throw new PlanFileLoaderError(
          "plan_file_too_large",
          `plan file exceeds 64 KiB: ${boundedDisplayPath(userPath)}`,
        );
      }

      const handleAfter = await handle.stat();
      let namedAfter: Stats;
      let canonicalAfter: string;
      try {
        [namedAfter, canonicalAfter] = await Promise.all([
          this.fileSystem.lstat(lexicalPath),
          this.fileSystem.realpath(lexicalPath),
        ]);
      } catch (error) {
        throw new PlanFileLoaderError(
          "plan_file_unstable",
          `plan file changed while read: ${boundedDisplayPath(userPath)}`,
          { cause: error },
        );
      }
      if (
        namedAfter.isSymbolicLink() ||
        !namedAfter.isFile() ||
        !sameIdentity(identity(namedBefore), identity(handleAfter)) ||
        !sameIdentity(identity(namedAfter), identity(handleAfter)) ||
        platformPath(canonicalAfter) !== platformPath(lexicalPath)
      ) {
        throw new PlanFileLoaderError(
          "plan_file_unstable",
          `plan file changed while read: ${boundedDisplayPath(userPath)}`,
        );
      }

      let source: string;
      try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(
          capture.subarray(0, offset),
        );
      } catch (error) {
        throw new PlanFileLoaderError(
          "plan_file_invalid_utf8",
          `plan file is not valid UTF-8: ${boundedDisplayPath(userPath)}`,
          { cause: error },
        );
      }

      let parsed: unknown;
      try {
        parsed = parseStrictJson(source);
      } catch (error) {
        if (error instanceof StrictJsonError) {
          throw new PlanFileLoaderError(
            "plan_file_invalid",
            `plan file JSON is invalid: ${error.message}`,
            { cause: error },
          );
        }
        throw error;
      }
      const validated = userEditablePlanSchema.safeParse(parsed);
      if (!validated.success) {
        const issue = validated.error.issues[0];
        const path = issue?.path.join(".") || "plan";
        throw new PlanFileLoaderError(
          "plan_file_invalid",
          `plan file schema is invalid at ${path}: ${issue?.message ?? "invalid value"}`,
          { cause: validated.error },
        );
      }
      return freezePlan(validated.data);
    } finally {
      await handle.close();
    }
  }
}
