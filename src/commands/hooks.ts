import { canonicalJson } from "../completion/canonical-json.js";
import { CapabilityError } from "../capabilities/capability-errors.js";
import type { FrozenCapabilityRecord } from "../capabilities/capability-types.js";
import type { CliIO, CliRuntime } from "../cli/types.js";

function hooks(runtime: CliRuntime): Promise<readonly FrozenCapabilityRecord[]> {
  if (runtime.createCapabilityPlatform === undefined) {
    throw new CapabilityError("capability_state_invalid", "runtime has no capability platform", 3);
  }
  return runtime.createCapabilityPlatform(runtime.cwd).buildRegistry().then((registry) =>
    registry.list("hook", true)
  );
}

function fail(error: unknown, io: CliIO): number {
  const known = error instanceof CapabilityError ? error : undefined;
  io.stderr.write(`${canonicalJson({
    code: known?.code ?? "hook_internal_error",
    error: known?.message ?? "Hook inspection failed",
  })}\n`);
  return known?.exitCode ?? 1;
}

function project(record: FrozenCapabilityRecord): Readonly<Record<string, unknown>> {
  if (record.metadata.kind !== "hook") throw new TypeError("Hook metadata kind is inconsistent");
  return Object.freeze({
    event: record.metadata.event,
    failurePolicy: record.metadata.failure_policy,
    handler: record.metadata.handler.type,
    hookId: record.identity.qualifiedId,
    matcher: record.metadata.matcher ?? null,
    mode: record.metadata.mode,
    requestedEffects: record.requestedEffects,
    timeoutMs: record.metadata.timeout_ms ?? 10_000,
  });
}

export async function executeHooksList(
  options: { readonly event?: string; readonly json: boolean },
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    const values = (await hooks(runtime))
      .filter((record) =>
        options.event === undefined ||
        (record.metadata.kind === "hook" && record.metadata.event === options.event)
      )
      .map(project);
    if (options.json) io.stdout.write(`${canonicalJson({ hooks: values, schemaVersion: 1 })}\n`);
    else if (values.length === 0) io.stdout.write("No enabled Hooks.\n");
    else for (const value of values) {
      io.stdout.write(`${String(value.hookId)}\t${String(value.event)}\t${String(value.mode)}\t${String(value.handler)}\n`);
    }
    return 0;
  } catch (error) {
    return fail(error, io);
  }
}

function pathMatches(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export async function executeHooksExplain(
  actionKind: string,
  options: { readonly json: boolean; readonly path?: string },
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    if (![
      "apply_patch",
      "finish_task",
      "mcp.prompt.get",
      "mcp.resource.read",
      "mcp.tool.call",
      "run_command",
    ].includes(actionKind)) {
      throw new CapabilityError("capability_path_invalid", "unknown Hook action kind");
    }
    if (
      options.path !== undefined &&
      (options.path.startsWith("/") || options.path.includes("\\") || options.path.split("/").some((part) => part === "" || part === "." || part === ".."))
    ) {
      throw new CapabilityError("capability_path_invalid", "--path must be normalized and workspace-relative");
    }
    const matched = (await hooks(runtime)).filter((record) => {
      if (record.metadata.kind !== "hook") return false;
      const matcher = record.metadata.matcher;
      if (matcher?.action_kinds !== undefined && !matcher.action_kinds.includes(actionKind)) return false;
      if (
        matcher?.path_prefixes !== undefined &&
        (options.path === undefined || !matcher.path_prefixes.some((prefix) => pathMatches(prefix, options.path!)))
      ) return false;
      return true;
    }).map(project);
    const value = {
      actionKind,
      matched,
      path: options.path ?? null,
      pureSimulation: true,
      schemaVersion: 1,
      warning: "matcher simulation does not execute Hooks or claim that Host policy allows the action",
    };
    io.stdout.write(options.json
      ? `${canonicalJson(value)}\n`
      : `Matched Hooks: ${String(matched.length)} (pure matcher simulation; no policy allowance)\n${matched.map((hook) => `  ${String(hook.hookId)}`).join("\n")}${matched.length === 0 ? "" : "\n"}`);
    return 0;
  } catch (error) {
    return fail(error, io);
  }
}
