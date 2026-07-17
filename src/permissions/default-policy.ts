import path from "node:path";

import type {
  CommandActionIdentity,
  NormalizedAction,
  PermissionPolicy,
  PolicyDecision,
} from "./permission-types.js";

export const DEFAULT_PERMISSION_POLICY_ID =
  "bornagent.default-command-policy";
export const DEFAULT_PERMISSION_POLICY_VERSION = "1";

export const DEFAULT_PERMISSION_RULE_IDS = Object.freeze({
  allowGitDiff: "command.allow.git-diff-no-ext-diff.v1",
  allowGitStatus: "command.allow.git-status-exact.v1",
  allowRipgrepVersion: "command.allow.rg-version-exact.v1",
  askRegisteredCommand: "command.ask.registered.v1",
  denyDangerousGit: "command.deny.dangerous-git.v1",
  denyDelete: "command.deny.delete.v1",
  denyExternalExecutable: "command.deny.external-executable.v1",
  denyExternalPath: "command.deny.external-path.v1",
  denyInterpreter: "command.deny.interpreter.v1",
  denyInvalidAction: "command.deny.invalid-action.v1",
  denyNetwork: "command.deny.network.v1",
  denyNodeDynamicCode: "command.deny.node-dynamic-code.v1",
  denyPackageMutation: "command.deny.package-mutation.v1",
  denyPrivilege: "command.deny.privilege.v1",
  denyUnknownExecutable: "command.deny.unknown-executable.v1",
} as const);

const REGISTERED_EXECUTABLES = new Set([
  "corepack",
  "git",
  "node",
  "npm",
  "pnpm",
  "rg",
]);

const INTERPRETERS = new Set([
  "bash",
  "bash.exe",
  "cmd",
  "cmd.exe",
  "fish",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "sh",
  "sh.exe",
  "zsh",
]);

const DELETE_EXECUTABLES = new Set([
  "del",
  "diskpart",
  "format",
  "rd",
  "remove-item",
  "rm",
  "rmdir",
]);

const PRIVILEGE_EXECUTABLES = new Set([
  "doas",
  "net",
  "runas",
  "sc",
  "sudo",
  "systemctl",
]);

const NETWORK_EXECUTABLES = new Set([
  "curl",
  "ftp",
  "gh",
  "git-remote-http",
  "git-remote-https",
  "scp",
  "sftp",
  "ssh",
  "wget",
]);

const DANGEROUS_GIT_SUBCOMMANDS = new Set([
  "checkout",
  "clean",
  "commit",
  "merge",
  "pull",
  "push",
  "rebase",
  "reset",
  "restore",
  "stash",
  "switch",
]);

const PACKAGE_MUTATION_SUBCOMMANDS = new Set([
  "add",
  "audit",
  "create",
  "deploy",
  "dlx",
  "exec",
  "i",
  "init",
  "install",
  "link",
  "login",
  "outdated",
  "pack",
  "publish",
  "rebuild",
  "remove",
  "rm",
  "uninstall",
  "unlink",
  "update",
  "upgrade",
]);

const COREPACK_MUTATION_SUBCOMMANDS = new Set([
  "cache",
  "disable",
  "enable",
  "hydrate",
  "install",
  "pack",
  "prepare",
  "up",
  "use",
]);

export const defaultPermissionPolicy: PermissionPolicy = Object.freeze({
  id: DEFAULT_PERMISSION_POLICY_ID,
  version: DEFAULT_PERMISSION_POLICY_VERSION,
  evaluate(action: NormalizedAction): PolicyDecision {
    if (action.actionKind !== "command") {
      return {
        effect: "deny",
        reasonCode: "mcp_not_enabled_by_default_policy",
        ruleId: "default.deny.mcp.v1",
      };
    }
    return (
      evaluateHardDeny(action) ??
      evaluateExplicitAllow(action) ??
      evaluateDefaultAskOrUnknown(action)
    );
  },
});

export function evaluateHardDeny(
  action: CommandActionIdentity,
): PolicyDecision | null {
  if (action.actionKind !== "command") {
    return deny(
      DEFAULT_PERMISSION_RULE_IDS.denyInvalidAction,
      "invalid_action_kind",
    );
  }

  const executable = normalizeProgramName(action.logicalExecutable);
  if (hasExecutablePathSyntax(action.logicalExecutable)) {
    return deny(
      DEFAULT_PERMISSION_RULE_IDS.denyExternalExecutable,
      "executable_path_forbidden",
    );
  }
  if (INTERPRETERS.has(executable)) {
    return deny(
      DEFAULT_PERMISSION_RULE_IDS.denyInterpreter,
      "shell_interpreter_forbidden",
    );
  }
  if (DELETE_EXECUTABLES.has(executable)) {
    return deny(
      DEFAULT_PERMISSION_RULE_IDS.denyDelete,
      "delete_command_forbidden",
    );
  }
  if (PRIVILEGE_EXECUTABLES.has(executable)) {
    return deny(
      DEFAULT_PERMISSION_RULE_IDS.denyPrivilege,
      "privilege_command_forbidden",
    );
  }
  if (NETWORK_EXECUTABLES.has(executable) || action.argv.some(isNetworkValue)) {
    return deny(
      DEFAULT_PERMISSION_RULE_IDS.denyNetwork,
      "network_command_forbidden",
    );
  }
  if (action.argv.some(isExternalPathArgument)) {
    return deny(
      DEFAULT_PERMISSION_RULE_IDS.denyExternalPath,
      "external_path_forbidden",
    );
  }

  if (executable === "git") {
    const subcommand = findGitSubcommand(action.argv);
    if (subcommand !== null && DANGEROUS_GIT_SUBCOMMANDS.has(subcommand)) {
      return deny(
        DEFAULT_PERMISSION_RULE_IDS.denyDangerousGit,
        "dangerous_git_subcommand",
      );
    }
  }

  if (executable === "node" && action.argv.some(isNodeDynamicCodeArgument)) {
    return deny(
      DEFAULT_PERMISSION_RULE_IDS.denyNodeDynamicCode,
      "node_dynamic_code_forbidden",
    );
  }

  const packageSubcommand = findPackageMutationSubcommand(
    executable,
    action.argv,
  );
  if (packageSubcommand !== null) {
    return deny(
      DEFAULT_PERMISSION_RULE_IDS.denyPackageMutation,
      "package_mutation_or_publish_forbidden",
    );
  }

  if (!REGISTERED_EXECUTABLES.has(executable)) {
    return deny(
      DEFAULT_PERMISSION_RULE_IDS.denyUnknownExecutable,
      "unknown_executable",
    );
  }

  return null;
}

export function evaluateExplicitAllow(
  action: CommandActionIdentity,
): PolicyDecision | null {
  const executable = normalizeProgramName(action.logicalExecutable);

  if (executable === "git" && arraysEqual(action.argv, ["status"])) {
    return allow(DEFAULT_PERMISSION_RULE_IDS.allowGitStatus);
  }

  if (executable === "git" && isSafeGitDiffShape(action.argv)) {
    return allow(DEFAULT_PERMISSION_RULE_IDS.allowGitDiff);
  }

  if (executable === "rg" && arraysEqual(action.argv, ["--version"])) {
    return allow(DEFAULT_PERMISSION_RULE_IDS.allowRipgrepVersion);
  }

  return null;
}

export function isRegisteredExecutable(logicalExecutable: string): boolean {
  return REGISTERED_EXECUTABLES.has(normalizeProgramName(logicalExecutable));
}

export function isExternalPathArgument(argument: string): boolean {
  const candidates = argument.includes("=")
    ? [argument, argument.slice(argument.indexOf("=") + 1)]
    : [argument];

  return candidates.some((candidate) => {
    if (candidate.length === 0 || candidate.startsWith("-")) {
      return false;
    }
    const forward = candidate.replaceAll("\\", "/");
    if (
      forward.startsWith("/") ||
      /^[a-zA-Z]:/u.test(forward) ||
      path.win32.isAbsolute(candidate) ||
      path.posix.isAbsolute(candidate)
    ) {
      return true;
    }
    const normalized = path.posix.normalize(forward);
    return normalized === ".." || normalized.startsWith("../");
  });
}

function evaluateDefaultAskOrUnknown(
  action: CommandActionIdentity,
): PolicyDecision {
  if (isRegisteredExecutable(action.logicalExecutable)) {
    return {
      effect: "ask",
      reasonCode: "registered_command_requires_approval",
      ruleId: DEFAULT_PERMISSION_RULE_IDS.askRegisteredCommand,
    };
  }
  return deny(
    DEFAULT_PERMISSION_RULE_IDS.denyUnknownExecutable,
    "unknown_executable",
  );
}

function findGitSubcommand(argv: readonly string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "-C" || argument === "-c" || argument === "--git-dir") {
      index += 1;
      continue;
    }
    if (argument.startsWith("--git-dir=") || argument.startsWith("-c")) {
      continue;
    }
    if (argument.startsWith("-")) {
      continue;
    }
    return argument.toLowerCase();
  }
  return null;
}

function findPackageMutationSubcommand(
  executable: string,
  argv: readonly string[],
): string | null {
  if (executable === "npm" || executable === "pnpm") {
    const subcommand = argv[0]?.toLowerCase();
    return subcommand !== undefined && PACKAGE_MUTATION_SUBCOMMANDS.has(subcommand)
      ? subcommand
      : null;
  }

  if (executable !== "corepack") {
    return null;
  }
  const first = argv[0]?.toLowerCase();
  if (first !== undefined && COREPACK_MUTATION_SUBCOMMANDS.has(first)) {
    return first;
  }
  if (first !== "npm" && first !== "pnpm") {
    return null;
  }
  const nested = argv[1]?.toLowerCase();
  return nested !== undefined && PACKAGE_MUTATION_SUBCOMMANDS.has(nested)
    ? nested
    : null;
}

function isNodeDynamicCodeArgument(argument: string): boolean {
  return (
    argument === "-" ||
    argument === "-e" ||
    argument === "--eval" ||
    argument === "-p" ||
    argument === "--print" ||
    argument.startsWith("--eval=") ||
    argument.startsWith("--input-type") ||
    /^-[ep].+/u.test(argument)
  );
}

function isSafeGitDiffShape(argv: readonly string[]): boolean {
  if (arraysEqual(argv, ["diff", "--no-ext-diff"])) {
    return true;
  }
  if (
    argv.length < 4 ||
    argv[0] !== "diff" ||
    argv[1] !== "--no-ext-diff" ||
    argv[2] !== "--"
  ) {
    return false;
  }
  return argv.slice(3).every((pathspec) => pathspec.length > 0);
}

function isNetworkValue(argument: string): boolean {
  const candidates = argument.includes("=")
    ? [argument, argument.slice(argument.indexOf("=") + 1)]
    : [argument];
  return candidates.some((candidate) =>
    /^(?:https?|ftp|ssh):\/\//iu.test(candidate),
  );
}

function hasExecutablePathSyntax(value: string): boolean {
  return (
    value.includes("/") ||
    value.includes("\\") ||
    /^[a-zA-Z]:/u.test(value)
  );
}

function normalizeProgramName(value: string): string {
  return value.trim().toLowerCase();
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function allow(ruleId: string): PolicyDecision {
  return { effect: "allow", ruleId };
}

function deny(ruleId: string, reasonCode: string): PolicyDecision {
  return { effect: "deny", reasonCode, ruleId };
}
