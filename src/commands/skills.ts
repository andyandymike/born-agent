import { canonicalJson } from "../completion/canonical-json.js";
import type { CliIO, CliRuntime } from "../cli/types.js";
import { CapabilityError, safeCapabilityErrorMessage } from "../capabilities/capability-errors.js";

function requirePlatform(runtime: CliRuntime) {
  if (runtime.createCapabilityPlatform === undefined) {
    throw new CapabilityError("capability_state_invalid", "runtime has no capability platform", 3);
  }
  return runtime.createCapabilityPlatform(runtime.cwd);
}

function failure(error: unknown, io: CliIO): number {
  const capability = error instanceof CapabilityError ? error : undefined;
  io.stderr.write(`${canonicalJson({
    code: capability?.code ?? "skill_internal_error",
    error: safeCapabilityErrorMessage(error),
  })}\n`);
  return capability?.exitCode ?? 1;
}

export async function executeSkillsList(
  options: { readonly json: boolean; readonly modelAllowed: boolean },
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    const registry = await requirePlatform(runtime).buildRegistry();
    const skills = registry.list("skill", true).filter((record) =>
      record.metadata.kind === "skill" &&
      (!options.modelAllowed || record.metadata.invocation === "model_allowed"),
    );
    const values = skills.map((record) => {
      if (record.metadata.kind !== "skill") throw new Error("Skill metadata kind mismatch");
      return {
        description: record.description,
        displayName: record.displayName,
        invocation: record.metadata.invocation,
        qualifiedId: record.identity.qualifiedId,
        resourceCount: record.metadata.resources?.length ?? 0,
        source: record.identity.source,
        version: record.identity.pluginVersion,
      };
    });
    if (options.json) {
      io.stdout.write(`${canonicalJson({ schemaVersion: 1, skills: values })}\n`);
    } else if (values.length === 0) {
      io.stdout.write("No enabled Skills discovered.\n");
    } else {
      for (const skill of values) {
        io.stdout.write(
          `${skill.qualifiedId}\t${skill.invocation}\tresources=${String(skill.resourceCount)}\t${skill.description}\n`,
        );
      }
    }
    return 0;
  } catch (error) {
    return failure(error, io);
  }
}

export async function executeSkillsShow(
  selector: string,
  options: { readonly json: boolean; readonly resources: boolean },
  runtime: CliRuntime,
  io: CliIO,
): Promise<number> {
  try {
    const registry = await requirePlatform(runtime).buildRegistry();
    const record = registry.resolveUniqueReadOnly(selector);
    if (record.identity.kind !== "skill" || record.metadata.kind !== "skill") {
      throw new CapabilityError("capability_not_found", "selector does not identify a Skill");
    }
    const value = {
      description: record.description,
      displayName: record.displayName,
      entry: record.metadata.entry,
      invocation: record.metadata.invocation,
      qualifiedId: record.identity.qualifiedId,
      resources: options.resources
        ? (record.metadata.resources ?? []).map((resource) => ({
            description: resource.description,
            mediaType: resource.media_type,
            resourceId: resource.resource_id,
          }))
        : [],
      source: record.identity.source,
      version: record.identity.pluginVersion,
    };
    if (options.json) {
      io.stdout.write(`${canonicalJson({ schemaVersion: 1, skill: value })}\n`);
    } else {
      io.stdout.write(`${value.qualifiedId}\n`);
      io.stdout.write(`  invocation: ${value.invocation}\n`);
      io.stdout.write(`  source: ${value.source}\n`);
      io.stdout.write(`  entry: ${value.entry} (untrusted content not loaded)\n`);
      io.stdout.write(`  description: ${value.description}\n`);
      if (options.resources) {
        for (const resource of value.resources) {
          io.stdout.write(`  resource ${resource.resourceId}: ${resource.mediaType} ${resource.description}\n`);
        }
      }
    }
    return 0;
  } catch (error) {
    return failure(error, io);
  }
}
