import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";

import { sha256Canonical } from "../completion/canonical-json.js";
import {
  defaultUserPolicyPath,
  MAX_BUILT_IN_POLICY_BYTES,
  MAX_USER_POLICY_BYTES,
  pathIsInside,
  readTrustedPolicyText,
} from "./policy-authority.js";
import { RuntimePolicyError } from "./policy-errors.js";
import {
  RuntimePolicyProfileRegistry,
  type RuntimePolicyProfileSource,
} from "./policy-profile-registry.js";
import {
  BUILT_IN_LOCAL_FREE_PROFILE_ID,
  canonicalPolicyProfileData,
  parseRuntimePolicyProfile,
  parseUserPolicyConfig,
  type RuntimePolicyProfileV1,
} from "./runtime-policy-schema.js";
import { parseStrictJson } from "./strict-json.js";

export const BUILT_IN_POLICY_ASSET_PATH = fileURLToPath(
  new URL("../../policies/local-free-v1.json", import.meta.url),
);

export interface LoadRuntimePolicyRegistryOptions {
  readonly workspace: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly configPath?: string | undefined;
  readonly builtInPath?: string | undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function entry(profile: RuntimePolicyProfileV1, source: RuntimePolicyProfileSource) {
  return Object.freeze({
    profile,
    profileSha256: sha256Canonical(canonicalPolicyProfileData(profile)),
    source,
  });
}

function assertBuiltIn(profile: RuntimePolicyProfileV1): void {
  // PHASE15: The package asset is the only implicit default. Reconstructing a
  // second default in code would let a missing/corrupt asset silently drift.
  if (
    profile.id !== BUILT_IN_LOCAL_FREE_PROFILE_ID ||
    profile.mode !== "local_free" ||
    profile.modelAccess.kind !== "local_free" ||
    profile.modelAccess.ollama.defaultModel !== "qwen3:1.7b" ||
    profile.modelAccess.ollama.endpoint !== "http://127.0.0.1:11434" ||
    profile.evalAccess.allowedSuites.includes("full")
  ) {
    throw new RuntimePolicyError(
      "policy_builtin_invariant",
      "built-in local-free policy does not satisfy the package invariant",
      1,
    );
  }
}

export async function loadRuntimePolicyRegistry(
  options: LoadRuntimePolicyRegistryOptions,
): Promise<RuntimePolicyProfileRegistry> {
  const builtInText = await readTrustedPolicyText({
    builtIn: true,
    maximumBytes: MAX_BUILT_IN_POLICY_BYTES,
    path: options.builtInPath ?? BUILT_IN_POLICY_ASSET_PATH,
  });
  let builtIn: RuntimePolicyProfileV1;
  try {
    builtIn = parseRuntimePolicyProfile(parseStrictJson(builtInText.text));
  } catch (error) {
    throw new RuntimePolicyError(
      "policy_builtin_invariant",
      "built-in runtime policy asset failed validation",
      1,
      { cause: error },
    );
  }
  assertBuiltIn(builtIn);
  const entries = [entry(builtIn, "built_in")];

  let source: RuntimePolicyProfileSource;
  let userPath: string | undefined;
  if (options.configPath !== undefined) {
    if (!isAbsolute(options.configPath)) {
      throw new RuntimePolicyError(
        "policy_config_untrusted_path",
        "--policy-config must be an absolute path",
      );
    }
    userPath = resolve(options.configPath);
    source = "explicit_user_path";
  } else {
    userPath = defaultUserPolicyPath(options);
    source = "user_default_path";
    if (userPath === undefined || !(await exists(userPath))) {
      return new RuntimePolicyProfileRegistry(entries);
    }
  }

  const userText = await readTrustedPolicyText({
    builtIn: false,
    maximumBytes: MAX_USER_POLICY_BYTES,
    path: userPath,
  });
  const profiles = parseUserPolicyConfig(parseStrictJson(userText.text));
  if (profiles.some((profile) => profile.id === BUILT_IN_LOCAL_FREE_PROFILE_ID)) {
    throw new RuntimePolicyError(
      "policy_profile_duplicate",
      "user config cannot replace the built-in local-free profile",
    );
  }
  // PHASE15: user config can define paid-capable profiles, but a repository
  // checkout is untrusted and may never carry that authority.
  if (
    profiles.some((profile) => profile.mode === "remote_explicit") &&
    pathIsInside(await realpath(options.workspace), userText.canonicalPath)
  ) {
    throw new RuntimePolicyError(
      "policy_config_untrusted_path",
      "remote policy config must be outside the workspace",
    );
  }
  entries.push(...profiles.map((profile) => entry(profile, source)));
  return new RuntimePolicyProfileRegistry(entries);
}
