import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { RuntimePolicyError } from "./policy-errors.js";

export const MAX_BUILT_IN_POLICY_BYTES = 256 * 1024;
export const MAX_USER_POLICY_BYTES = 1024 * 1024;

export function defaultUserPolicyPath(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
}): string | undefined {
  if (input.platform === "win32") {
    return input.env.APPDATA === undefined
      ? undefined
      : resolve(input.env.APPDATA, "BornAgent", "policy.json");
  }
  if (input.platform === "darwin") {
    return input.env.HOME === undefined
      ? undefined
      : resolve(input.env.HOME, "Library", "Application Support", "BornAgent", "policy.json");
  }
  const root = input.env.XDG_CONFIG_HOME ??
    (input.env.HOME === undefined ? undefined : resolve(input.env.HOME, ".config"));
  return root === undefined ? undefined : resolve(root, "bornagent", "policy.json");
}

export function pathIsInside(parent: string, candidate: string): boolean {
  const delta = relative(resolve(parent), resolve(candidate));
  return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
}

async function trustworthyRegularFile(path: string): Promise<{
  readonly bytes: number;
  readonly canonicalPath: string;
}> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new RuntimePolicyError(
      "policy_config_untrusted_path",
      "policy config must be a regular non-link file",
    );
  }
  const canonicalPath = await realpath(path);
  return { bytes: before.size, canonicalPath };
}

export async function readTrustedPolicyText(input: {
  readonly path: string;
  readonly maximumBytes: number;
  readonly builtIn: boolean;
}): Promise<{ readonly canonicalPath: string; readonly text: string }> {
  try {
    const trusted = await trustworthyRegularFile(input.path);
    if (trusted.bytes <= 0 || trusted.bytes > input.maximumBytes) {
      throw new RuntimePolicyError(
        input.builtIn ? "policy_builtin_invariant" : "policy_config_invalid",
        `policy config size must be 1..${String(input.maximumBytes)} bytes`,
        input.builtIn ? 1 : 2,
      );
    }
    const bytes = await readFile(trusted.canonicalPath);
    if (bytes.byteLength !== trusted.bytes || bytes.byteLength > input.maximumBytes) {
      throw new RuntimePolicyError(
        input.builtIn ? "policy_builtin_invariant" : "policy_config_invalid",
        "policy config changed while it was being read",
        input.builtIn ? 1 : 2,
      );
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new RuntimePolicyError(
        input.builtIn ? "policy_builtin_invariant" : "policy_config_invalid",
        "policy config must be valid UTF-8",
        input.builtIn ? 1 : 2,
      );
    }
    return { canonicalPath: trusted.canonicalPath, text };
  } catch (error) {
    if (error instanceof RuntimePolicyError) throw error;
    throw new RuntimePolicyError(
      input.builtIn ? "policy_builtin_invariant" : "policy_config_invalid",
      input.builtIn ? "built-in runtime policy asset is unavailable" : "user policy config could not be read",
      input.builtIn ? 1 : 2,
      { cause: error },
    );
  }
}
