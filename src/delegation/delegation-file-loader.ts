import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, win32 } from "node:path";
import { z } from "zod";

import { parseStrictJson, StrictJsonError } from "../system/strict-json.js";
import { DelegationError } from "./delegation-errors.js";
import {
  canonicalDelegationIdentity,
  type DelegationRevisionIdentityV1,
} from "./delegation-identity.js";
import {
  classifyDelegationSchemaError,
  MAX_DELEGATION_REVISION_BYTES,
} from "./delegation-schema.js";

function contained(root: string, candidate: string): boolean {
  const delta = relative(root, candidate);
  return delta === "" || (
    delta !== ".." &&
    !delta.startsWith("../") &&
    !delta.startsWith("..\\") &&
    !isAbsolute(delta)
  );
}

function same(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export class DelegationFileLoader {
  async load(workspace: string, userPath: string): Promise<DelegationRevisionIdentityV1> {
    if (
      userPath.length === 0 ||
      userPath.includes("\0") ||
      isAbsolute(userPath) ||
      win32.isAbsolute(userPath) ||
      /^[A-Za-z]:/u.test(userPath)
    ) {
      throw new DelegationError("delegation_invalid", "delegation file must be workspace-relative");
    }
    const root = await realpath(resolve(workspace));
    const lexical = resolve(root, userPath);
    if (!contained(root, lexical)) {
      throw new DelegationError("delegation_invalid", "delegation file escapes the workspace");
    }
    let before: Stats;
    try {
      before = await lstat(lexical);
    } catch (error) {
      throw new DelegationError("delegation_invalid", "delegation file could not be inspected", { cause: error });
    }
    if (before.isSymbolicLink() || !before.isFile() || before.size > MAX_DELEGATION_REVISION_BYTES) {
      throw new DelegationError("delegation_too_large", "delegation file must be a bounded regular non-link file");
    }
    const canonical = await realpath(lexical);
    if (
      !contained(root, canonical) ||
      (process.platform === "win32" ? canonical.toLowerCase() !== lexical.toLowerCase() : canonical !== lexical)
    ) {
      throw new DelegationError("delegation_invalid", "delegation file must not traverse a link or junction");
    }
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    let handle: FileHandle | undefined;
    try {
      handle = await open(lexical, constants.O_RDONLY | noFollow);
      const handleBefore = await handle.stat();
      if (!handleBefore.isFile() || !same(before, handleBefore)) {
        throw new DelegationError("delegation_invalid", "delegation file changed before read");
      }
      const bytes = Buffer.allocUnsafe(MAX_DELEGATION_REVISION_BYTES + 1);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      if (offset > MAX_DELEGATION_REVISION_BYTES) {
        throw new DelegationError("delegation_too_large", "delegation file exceeds 128 KiB");
      }
      const [handleAfter, namedAfter, canonicalAfter] = await Promise.all([
        handle.stat(),
        lstat(lexical),
        realpath(lexical),
      ]);
      if (
        namedAfter.isSymbolicLink() || !namedAfter.isFile() ||
        !same(before, handleAfter) || !same(namedAfter, handleAfter) ||
        (process.platform === "win32" ? canonicalAfter.toLowerCase() !== lexical.toLowerCase() : canonicalAfter !== lexical)
      ) {
        throw new DelegationError("delegation_invalid", "delegation file changed while read");
      }
      let source: string;
      try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
      } catch (error) {
        throw new DelegationError("delegation_invalid", "delegation file is not valid UTF-8", { cause: error });
      }
      let value: unknown;
      try {
        value = parseStrictJson(source);
      } catch (error) {
        if (error instanceof StrictJsonError) {
          throw new DelegationError("delegation_invalid", error.message, { cause: error });
        }
        throw error;
      }
      try {
        return canonicalDelegationIdentity(value);
      } catch (error) {
        if (error instanceof z.ZodError) throw classifyDelegationSchemaError(error);
        throw error;
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}
