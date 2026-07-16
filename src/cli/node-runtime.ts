import type { CliRuntime } from "./types.js";
import { isReadableDirectory } from "../system/is-readable-directory.js";
import { runExecutable } from "../system/run-executable.js";

export function createNodeRuntime(version: string): CliRuntime {
  return {
    cwd: process.cwd(),
    isReadableDirectory,
    nodeVersion: process.versions.node,
    platform: process.platform,
    runExecutable,
    version,
  };
}

