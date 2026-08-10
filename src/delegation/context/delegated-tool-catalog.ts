import { applyPatchInputSchema } from "../../tools/apply-patch-tool.js";
import { findReferencesToolInputSchema, findSymbolToolInputSchema, repositoryOutlineToolInputSchema } from "../../tools/repository-navigation-tool-contract.js";
import { finishTaskInputSchema } from "../../completion/finish-task-tool.js";
import { listFilesInputSchema } from "../../tools/list-files-tool.js";
import { readArtifactInputSchema } from "../../tools/read-artifact-tool.js";
import { readFileInputSchema } from "../../tools/read-file-tool.js";
import { runCommandInputSchema } from "../../tools/run-command-tool.js";
import { searchInputSchema } from "../../tools/search-tool.js";
import { sha256Canonical } from "../../completion/canonical-json.js";
import { ZodToolValidator } from "../../tools/validators/zod-tool-validator.js";
import type { ModelToolDefinition } from "../../model/model-backend.js";
import type { z } from "zod";
import type { DelegatedToolCatalogEntryV1, DelegatedToolEffectClassV1 } from "./child-tool-profile.js";

const schemas = Object.freeze({
  apply_patch: applyPatchInputSchema,
  find_references: findReferencesToolInputSchema,
  find_symbol: findSymbolToolInputSchema,
  finish_task: finishTaskInputSchema,
  list_files: listFilesInputSchema,
  read_artifact: readArtifactInputSchema,
  read_file: readFileInputSchema,
  repository_outline: repositoryOutlineToolInputSchema,
  run_command: runCommandInputSchema,
  search: searchInputSchema,
});

export type DelegatedBuiltinToolId = keyof typeof schemas;

export const DELEGATED_BUILTIN_TOOL_IDS = Object.freeze(
  Object.keys(schemas).sort() as DelegatedBuiltinToolId[],
);

export function delegatedBuiltinEffectClass(id: string): DelegatedToolEffectClassV1 | null {
  if (!(id in schemas)) return null;
  if (id === "apply_patch") return "patch";
  if (id === "run_command") return "approved_command";
  if (id === "finish_task") return "completion";
  return "read";
}

export function delegatedBuiltinToolCatalog(): readonly DelegatedToolCatalogEntryV1[] {
  return Object.freeze(DELEGATED_BUILTIN_TOOL_IDS.map((id) => Object.freeze({
    id,
    effectClass: delegatedBuiltinEffectClass(id)!,
    schemaSha256: sha256Canonical(
      new ZodToolValidator<unknown>(schemas[id] as z.ZodType<unknown>).modelSchema,
    ),
  })));
}

export function delegatedRuntimeToolCatalog(
  definitions: readonly ModelToolDefinition[],
): readonly DelegatedToolCatalogEntryV1[] {
  return Object.freeze(definitions.flatMap((definition) => {
    const effectClass = delegatedBuiltinEffectClass(definition.name);
    return effectClass === null ? [] : [Object.freeze({
      id: definition.name,
      effectClass,
      schemaSha256: sha256Canonical(definition.parameters),
    })];
  }));
}
