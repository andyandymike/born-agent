import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { McpExecutableIdentity } from "./mcp-action-identity.js";
import { McpCoreError } from "./mcp-errors.js";

export interface ResolvedMcpExecutable {
  readonly canonicalPath: string;
  readonly identity: McpExecutableIdentity;
}

async function sha256File(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const source = createReadStream(filePath);
    source.on("data", (chunk: string | Buffer) => {
      digest.update(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    });
    source.once("error", reject);
    source.once("end", resolve);
  });
  return digest.digest("hex");
}

function pathCandidates(
  executable: string,
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): readonly string[] {
  if (path.isAbsolute(executable) || /[\\/]/u.test(executable)) {
    return [path.resolve(executable)];
  }
  const pathValue = environment.PATH ?? environment.Path ?? environment.path ?? "";
  const extensions =
    platform === "win32"
      ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
      : [""];
  const hasKnownExtension =
    platform === "win32" && extensions.some((extension) => executable.toLowerCase().endsWith(extension.toLowerCase()));
  return pathValue
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((directory) =>
      hasKnownExtension
        ? [path.resolve(directory, executable)]
        : extensions.map((extension) => path.resolve(directory, `${executable}${extension}`)),
    );
}

export async function resolveMcpExecutable(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly executable: string;
  readonly platform?: NodeJS.Platform;
}): Promise<ResolvedMcpExecutable> {
  if (
    input.executable.length === 0 ||
    input.executable.includes("\0") ||
    ["npx", "npx.cmd", "uvx"].includes(input.executable.toLowerCase())
  ) {
    throw new McpCoreError(
      "mcp_executable_unsafe",
      "download-capable MCP launchers are not supported",
    );
  }
  const platform = input.platform ?? process.platform;
  let selected: string | undefined;
  for (const candidate of pathCandidates(input.executable, input.environment, platform)) {
    try {
      await access(candidate);
      const metadata = await stat(candidate);
      if (metadata.isFile()) {
        selected = await realpath(candidate);
        break;
      }
    } catch {
      // Try the next PATH candidate without exposing host paths in the error.
    }
  }
  if (selected === undefined) {
    throw new McpCoreError("mcp_executable_missing", "MCP executable could not be resolved");
  }
  const metadata = await stat(selected);
  const bytesSha256 = await sha256File(selected);
  const canonicalIdentity =
    platform === "win32" ? selected.normalize("NFC").toLowerCase() : selected.normalize("NFC");
  return Object.freeze({
    canonicalPath: selected,
    identity: Object.freeze({
      bytesSha256,
      canonicalIdentitySha256: createHash("sha256")
        .update(canonicalIdentity, "utf8")
        .digest("hex"),
      logicalName: path.basename(input.executable).replace(/\.(?:cmd|exe)$/iu, "").toLowerCase(),
      versionIdentity: createHash("sha256")
        .update(`${metadata.size}\0${Math.trunc(metadata.mtimeMs)}\0${bytesSha256}`, "utf8")
        .digest("hex"),
    }),
  });
}

export async function recheckMcpExecutable(
  expected: ResolvedMcpExecutable,
  input: Parameters<typeof resolveMcpExecutable>[0],
): Promise<void> {
  const current = await resolveMcpExecutable(input);
  if (
    current.canonicalPath !== expected.canonicalPath ||
    current.identity.bytesSha256 !== expected.identity.bytesSha256 ||
    current.identity.canonicalIdentitySha256 !== expected.identity.canonicalIdentitySha256 ||
    current.identity.versionIdentity !== expected.identity.versionIdentity
  ) {
    throw new McpCoreError(
      "mcp_executable_changed",
      "MCP executable identity changed after approval",
    );
  }
}
