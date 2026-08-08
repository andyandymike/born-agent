import { canonicalJson } from "../completion/canonical-json.js";
import type { CliIO, CliRuntime } from "../cli/types.js";
import { PluginLifecycleError } from "../plugins/plugin-errors.js";
import type {
  PluginInspectionV1,
  PluginLifecycleLike,
  PluginListEntryV1,
  PluginMutationResultV1,
} from "../plugins/plugin-lifecycle.js";

function lifecycle(runtime: CliRuntime): PluginLifecycleLike {
  if (runtime.createPluginLifecycle === undefined) {
    throw new PluginLifecycleError(
      "plugin_operation_incomplete",
      "runtime has no local Plugin lifecycle authority",
      1,
    );
  }
  return runtime.createPluginLifecycle(runtime.cwd);
}

function fail(error: unknown, io: CliIO): number {
  const known = error instanceof PluginLifecycleError ? error : undefined;
  io.stderr.write(`${canonicalJson({
    code: known?.code ?? "plugin_internal_error",
    error: known?.message ?? "Plugin lifecycle operation failed",
  })}\n`);
  return known?.exitCode ?? 1;
}

function writeInspection(value: PluginInspectionV1, json: boolean, io: CliIO): void {
  if (json) {
    io.stdout.write(`${canonicalJson(value)}\n`);
    return;
  }
  io.stdout.write(
    `${value.pluginId}@${value.pluginVersion} sha256:${value.pluginSha256.slice(0, 12)} status=${value.status} components=${String(value.components.length)}\n`,
  );
  for (const warning of value.warnings) io.stderr.write(`warning: ${warning}\n`);
}

function writeMutation(value: PluginMutationResultV1, json: boolean, io: CliIO): void {
  if (json) {
    io.stdout.write(`${canonicalJson(value)}\n`);
    return;
  }
  io.stdout.write(
    `${value.operation}: ${value.exactSelector} changed=${String(value.changed)} revision=${String(value.beforeRevision)}->${String(value.afterRevision)}\n`,
  );
  for (const warning of value.warnings) io.stderr.write(`warning: ${warning}\n`);
}

function writeList(values: readonly PluginListEntryV1[], json: boolean, io: CliIO): void {
  if (json) {
    io.stdout.write(`${canonicalJson({ plugins: values, schemaVersion: 1 })}\n`);
    return;
  }
  if (values.length === 0) {
    io.stdout.write("No locally installed Plugins.\n");
    return;
  }
  for (const value of values) {
    io.stdout.write(`${value.exactSelector}\tenabled=${String(value.enabled)}\tcontent=retained\n`);
  }
}

export async function executePluginsInspect(
  source: string,
  options: { readonly json: boolean },
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    writeInspection(await lifecycle(runtime).inspect(source), options.json, io);
    return 0;
  } catch (error) {
    return fail(error, io);
  }
}

export async function executePluginsInstall(
  source: string,
  options: { readonly expectSha256?: string; readonly json: boolean },
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    if (options.expectSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(options.expectSha256)) {
      throw new PluginLifecycleError("plugin_digest_mismatch", "--expect-sha256 must be one full lowercase SHA-256 digest");
    }
    writeMutation(
      await lifecycle(runtime).install(source, options.expectSha256),
      options.json,
      io,
    );
    return 0;
  } catch (error) {
    return fail(error, io);
  }
}

export async function executePluginsList(
  options: { readonly enabled: boolean; readonly installed: boolean; readonly json: boolean },
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    if (options.enabled && options.installed) {
      throw new PluginLifecycleError("plugin_source_invalid", "--enabled and --installed are mutually exclusive");
    }
    writeList(
      await lifecycle(runtime).list(options.enabled ? "enabled" : options.installed ? "installed" : "all"),
      options.json,
      io,
    );
    return 0;
  } catch (error) {
    return fail(error, io);
  }
}

export async function executePluginsShow(
  selector: string,
  options: { readonly json: boolean },
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    writeList([await lifecycle(runtime).show(selector)], options.json, io);
    return 0;
  } catch (error) {
    return fail(error, io);
  }
}

export async function executePluginsEnable(
  selector: string,
  options: { readonly json: boolean; readonly yes: boolean },
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    if (!options.yes) {
      throw new PluginLifecycleError(
        "plugin_enable_confirmation_required",
        "enable requires --yes; this enables exact bytes for new runs but grants no effects",
      );
    }
    io.stderr.write("Enablement selects this exact Plugin for new runs and grants no effects; every MCP, Hook, process, and workspace action remains independently gated.\n");
    writeMutation(await lifecycle(runtime).enable(selector), options.json, io);
    return 0;
  } catch (error) {
    return fail(error, io);
  }
}

export async function executePluginsDisable(
  selector: string,
  options: { readonly json: boolean },
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    writeMutation(await lifecycle(runtime).disable(selector), options.json, io);
    return 0;
  } catch (error) {
    return fail(error, io);
  }
}

export async function executePluginsRemove(
  selector: string,
  options: { readonly json: boolean },
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    writeMutation(await lifecycle(runtime).remove(selector), options.json, io);
    return 0;
  } catch (error) {
    return fail(error, io);
  }
}
