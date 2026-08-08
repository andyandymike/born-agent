import { isAbsolute, resolve } from "node:path";

import { canonicalJson } from "../completion/canonical-json.js";
import type { CliIO, CliRuntime } from "../cli/types.js";
import { CapabilityError, safeCapabilityErrorMessage } from "../capabilities/capability-errors.js";
import type {
  CapabilityCatalogDiagnostic,
  CapabilityKind,
  CapabilitySourceKind,
  FrozenCapabilityRecord,
  FrozenPluginRecord,
} from "../capabilities/capability-types.js";

export interface CapabilityListOptions {
  readonly enabledOnly: boolean;
  readonly json: boolean;
  readonly kind?: string;
  readonly source?: string;
  readonly workspace?: string;
}

function parseKind(value: string | undefined): CapabilityKind | undefined {
  if (value === undefined) return undefined;
  if (value === "skill" || value === "hook" || value === "mcp_server") return value;
  throw new CapabilityError("capability_path_invalid", "capability kind is invalid");
}

function parseSource(value: string | undefined): CapabilitySourceKind | undefined {
  if (value === undefined) return undefined;
  if (value === "builtin" || value === "user_install" || value === "workspace") return value;
  throw new CapabilityError("capability_path_invalid", "capability source is invalid");
}

function selectedWorkspace(runtime: CliRuntime, value: string | undefined): string {
  if (value === undefined) return runtime.cwd;
  if (!isAbsolute(value)) {
    throw new CapabilityError(
      "capability_path_invalid",
      "--workspace must be an absolute path",
    );
  }
  return resolve(value);
}

function diagnosticApplies(
  diagnostic: CapabilityCatalogDiagnostic,
  record: FrozenCapabilityRecord,
): boolean {
  return diagnostic.identity === undefined ||
    diagnostic.identity.includes(`${record.identity.pluginId}@${record.identity.pluginVersion}`);
}

function recordStatus(
  record: FrozenCapabilityRecord,
  diagnostics: readonly CapabilityCatalogDiagnostic[],
): "ready" | "warning" {
  return diagnostics.some((diagnostic) => diagnosticApplies(diagnostic, record))
    ? "warning"
    : "ready";
}

function projectRecord(
  record: FrozenCapabilityRecord,
  diagnostics: readonly CapabilityCatalogDiagnostic[],
): unknown {
  return {
    componentId: record.identity.componentId,
    componentSha256: record.identity.componentSha256,
    description: record.description,
    displayName: record.displayName,
    enabled: record.enabled,
    kind: record.identity.kind,
    pluginId: record.identity.pluginId,
    pluginSha256: record.identity.pluginSha256,
    pluginVersion: record.identity.pluginVersion,
    qualifiedId: record.identity.qualifiedId,
    requestedEffects: record.requestedEffects,
    source: record.identity.source,
    sourceRef: record.sourceRef,
    status: recordStatus(record, diagnostics),
  };
}

function findPlugin(
  record: FrozenCapabilityRecord,
  plugins: readonly FrozenPluginRecord[],
): FrozenPluginRecord {
  const plugin = plugins.find((candidate) =>
    candidate.source === record.identity.source &&
    candidate.pluginSha256 === record.identity.pluginSha256,
  );
  if (plugin === undefined) {
    throw new CapabilityError(
      "capability_state_invalid",
      "capability component is detached from its frozen package",
    );
  }
  return plugin;
}

function failure(error: unknown, io: CliIO): number {
  const capability = error instanceof CapabilityError ? error : undefined;
  const code = capability?.code ?? "capability_internal_error";
  io.stderr.write(`${canonicalJson({ code, error: safeCapabilityErrorMessage(error) })}\n`);
  return capability?.exitCode ?? 1;
}

function requirePlatform(runtime: CliRuntime, workspace: string) {
  if (runtime.createCapabilityPlatform === undefined) {
    throw new CapabilityError(
      "capability_state_invalid",
      "runtime has no capability platform",
      3,
    );
  }
  return runtime.createCapabilityPlatform(workspace);
}

export async function executeCapabilitiesList(
  options: CapabilityListOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    const workspace = selectedWorkspace(runtime, options.workspace);
    const registry = await requirePlatform(runtime, workspace).buildRegistry();
    const kind = parseKind(options.kind);
    const source = parseSource(options.source);
    const records = registry.list(kind, options.enabledOnly).filter((record) =>
      source === undefined || record.identity.source === source,
    );
    if (options.json) {
      io.stdout.write(`${canonicalJson({
        capabilities: records.map((record) =>
          projectRecord(record, registry.catalog.diagnostics),
        ),
        diagnostics: registry.catalog.diagnostics,
        enablementRevision: registry.catalog.enablementRevision,
        schemaVersion: 1,
        sourceRevisions: registry.catalog.sourceRevisions,
      })}\n`);
    } else if (records.length === 0) {
      io.stdout.write("No capabilities discovered.\n");
    } else {
      for (const record of records) {
        io.stdout.write(
          `${record.identity.qualifiedId}\t${record.identity.kind}\t${record.identity.source}\tversion=${record.identity.pluginVersion}\tpackage=${record.identity.pluginSha256.slice(0, 12)}\tenabled=${String(record.enabled)}\tstatus=${recordStatus(record, registry.catalog.diagnostics)}\n`,
        );
      }
    }
    return 0;
  } catch (error) {
    return failure(error, io);
  }
}

export async function executeCapabilitiesShow(
  selector: string,
  options: { readonly json: boolean; readonly workspace?: string },
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    const workspace = selectedWorkspace(runtime, options.workspace);
    const registry = await requirePlatform(runtime, workspace).buildRegistry();
    const record = registry.resolveUniqueReadOnly(selector);
    const plugin = findPlugin(record, registry.catalog.plugins);
    const diagnostics = registry.catalog.diagnostics.filter((diagnostic) =>
      diagnosticApplies(diagnostic, record),
    );
    const projected = {
      ...projectRecord(record, registry.catalog.diagnostics) as object,
      componentMetadata: record.metadata,
      componentPath: record.componentPath,
      diagnostics,
      inventory: plugin.inventory,
      inventorySha256: plugin.inventorySha256,
      manifest: plugin.manifest,
      manifestSha256: plugin.manifestSha256,
    };
    if (options.json) {
      io.stdout.write(`${canonicalJson({ capability: projected, schemaVersion: 1 })}\n`);
    } else {
      io.stdout.write(`${record.identity.qualifiedId}\n`);
      io.stdout.write(`  name: ${record.displayName}\n`);
      io.stdout.write(`  source: ${record.identity.source} (${record.sourceRef})\n`);
      io.stdout.write(`  plugin: ${record.identity.pluginId}@${record.identity.pluginVersion} sha256:${record.identity.pluginSha256}\n`);
      io.stdout.write(`  component: sha256:${record.identity.componentSha256}\n`);
      io.stdout.write(`  component path: ${record.componentPath}\n`);
      io.stdout.write(`  manifest: sha256:${plugin.manifestSha256}\n`);
      io.stdout.write(`  inventory: sha256:${plugin.inventorySha256}\n`);
      io.stdout.write(`  enabled: ${String(record.enabled)}\n`);
      io.stdout.write(`  status: ${recordStatus(record, registry.catalog.diagnostics)}\n`);
      io.stdout.write(`  requested effects: ${record.requestedEffects.join(", ") || "none"}\n`);
      io.stdout.write(`  description: ${record.description}\n`);
      io.stdout.write(`  manifest metadata: ${canonicalJson(plugin.manifest)}\n`);
      io.stdout.write(`  component metadata: ${canonicalJson(record.metadata)}\n`);
      if (diagnostics.length > 0) {
        io.stdout.write(`  diagnostics: ${diagnostics.map((diagnostic) => diagnostic.code).join(", ")}\n`);
      }
    }
    return 0;
  } catch (error) {
    return failure(error, io);
  }
}

export async function executeCapabilitiesDoctor(
  options: { readonly json: boolean; readonly workspace?: string },
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    const workspace = selectedWorkspace(runtime, options.workspace);
    const registry = await requirePlatform(runtime, workspace).buildRegistry();
    const pluginLifecycle = runtime.createPluginLifecycle === undefined
      ? null
      : await runtime.createPluginLifecycle(workspace).doctor();
    const value = {
      componentCount: registry.list(undefined, true).length,
      diagnostics: registry.catalog.diagnostics,
      eligiblePluginCount: registry.catalog.plugins.filter((plugin) => plugin.enabled).length,
      enablementRevision: registry.catalog.enablementRevision,
      pluginLifecycle,
      schemaVersion: 1,
      sourceRevisions: registry.catalog.sourceRevisions,
      status: "valid",
    } as const;
    io.stdout.write(
      options.json
        ? `${canonicalJson(value)}\n`
        : `Capabilities valid: plugins=${String(value.eligiblePluginCount)} components=${String(value.componentCount)} warnings=${String(value.diagnostics.length)}\n`,
    );
    return 0;
  } catch (error) {
    return failure(error, io);
  }
}
