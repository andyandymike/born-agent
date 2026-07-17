import type { DockerImagePolicy } from "./docker-policy.js";

export const SANDBOX_ENVIRONMENT_POLICY = Object.freeze({
  id: "bornagent.docker-cleared-env",
  version: "1",
});

export interface SandboxEnvironment {
  readonly names: readonly string[];
  readonly values: Readonly<Record<string, string>>;
}

const ORDER = [
  "PATH",
  "HOME",
  "TMPDIR",
  "CI",
  "NO_COLOR",
  "LANG",
  "BORN_SANDBOX",
] as const;

export function buildSandboxEnvironment(
  policy: DockerImagePolicy,
  untrustedInheritedEnvironment: Readonly<
    Record<string, string | undefined>
  > = {},
): SandboxEnvironment {
  // PHASE13: The wrapper calls clearenv() and rebuilds this fixed allowlist.
  // Starting empty means provider, MCP, proxy, SSH, Git, host PATH and newly
  // invented secret variables cannot cross the boundary by omission.
  void untrustedInheritedEnvironment;
  const values: Record<string, string> = {
    BORN_SANDBOX: "1",
    CI: "1",
    HOME: "/home/born",
    NO_COLOR: "1",
    PATH: policy.imagePath,
    TMPDIR: "/tmp",
  };
  if (policy.supportsCUtf8) values.LANG = "C.UTF-8";
  const names = ORDER.filter((name) => values[name] !== undefined);
  return Object.freeze({
    names: Object.freeze([...names]),
    values: Object.freeze(
      Object.fromEntries(names.map((name) => [name, values[name]!])),
    ),
  });
}

export function dockerEnvironmentArgv(
  environment: SandboxEnvironment,
): readonly string[] {
  const allowed = new Set(ORDER);
  if (
    environment.names.some((name) => !allowed.has(name as (typeof ORDER)[number])) ||
    new Set(environment.names).size !== environment.names.length ||
    Object.keys(environment.values).length !== environment.names.length
  ) {
    throw new TypeError("sandbox environment contains a non-allowlisted name");
  }
  return Object.freeze(
    environment.names.flatMap((name) => ["--env", `${name}=${environment.values[name]}`]),
  );
}
