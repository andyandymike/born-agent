import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { sha256Canonical } from "../../completion/canonical-json.js";
import { sha256Bytes } from "./repository-cache-evidence.js";

export const repositoryCacheCorpusSeed = 17_021;
export const repositoryCacheCorpusGeneratorVersion = 1 as const;
export const repositoryCacheMediumModuleCount = 512;

export const repositoryCacheCorpusDefinitionV1 = Object.freeze({
  dependencyShape: "one-core-128-fanout-plus-linear-tail-v1",
  generatorVersion: repositoryCacheCorpusGeneratorVersion,
  language: "typescript",
  moduleNaming: "zero-padded-four-digits-v1",
  seed: repositoryCacheCorpusSeed,
});

export const repositoryCacheCorpusDefinitionSha256 = sha256Canonical(repositoryCacheCorpusDefinitionV1);

export const repositoryCacheQueryInputsV1 = Object.freeze({
  "Q-OUTLINE-SUBTREE": Object.freeze({ limit: 32, max_depth: 2, path: "src/fanout" }),
  "Q-REFERENCES-HOT": Object.freeze({ limit: 64, relations: Object.freeze(["call", "import", "read"]) }),
  "Q-STATUS-CURRENT": Object.freeze({ audit: "full-current-generation" }),
  "Q-SYMBOL-FUZZY": Object.freeze({ limit: 32, query: "Hot" }),
});

export const repositoryCacheQueryInputHashesV1 = Object.freeze(
  Object.fromEntries(Object.entries(repositoryCacheQueryInputsV1).map(([queryId, input]) => [
    queryId,
    sha256Canonical(input),
  ])) as Readonly<Record<keyof typeof repositoryCacheQueryInputsV1, string>>,
);

export interface RepositoryCacheGeneratedFile {
  readonly bytes: number;
  readonly content: string;
  readonly path: string;
  readonly sha256: string;
}

export function repositoryCacheModulePath(index: number): string {
  const name = `module-${String(index).padStart(4, "0")}.ts`;
  return index > 0 && index <= 128 ? `src/fanout/${name}` : `src/modules/${name}`;
}

function moduleSource(index: number): string {
  if (index === 0) {
    return [
      "export interface HotInput { readonly value: number; }",
      "export function hot(input: HotInput): number { return input.value + 1; }",
      "export const coreVersion = 1;",
      "",
    ].join("\n");
  }
  const previous = index === 1 ? "../modules/module-0000.js" : index <= 128
    ? "../modules/module-0000.js"
    : index === 129
      ? "../fanout/module-0128.js"
    : `./module-${String(index - 1).padStart(4, "0")}.js`;
  const importName = index <= 128 ? "hot" : `value${String(index - 1).padStart(4, "0")}`;
  const invocation = index <= 128 ? `hot({ value: ${String(index)} })` : `${importName} + 1`;
  return [
    `import { ${importName} } from ${JSON.stringify(previous)};`,
    `export const value${String(index).padStart(4, "0")} = ${invocation};`,
    "",
  ].join("\n");
}

export function generateRepositoryCacheCorpus(moduleCount = repositoryCacheMediumModuleCount): readonly RepositoryCacheGeneratedFile[] {
  if (!Number.isSafeInteger(moduleCount) || moduleCount < 12 || moduleCount > 4_096) {
    throw new TypeError("repository cache corpus module count must be between 12 and 4096");
  }
  const sources = [
    { content: "# Deterministic repository cache evidence corpus\n", path: "AGENTS.md" },
    { content: "# Fanout modules use the root evidence rules.\n", path: "src/fanout/AGENTS.md" },
    ...Array.from({ length: moduleCount }, (_, index) => ({ content: moduleSource(index), path: repositoryCacheModulePath(index) })),
  ];
  return Object.freeze(sources.map(({ content, path }) => Object.freeze({
    bytes: Buffer.byteLength(content, "utf8"),
    content,
    path,
    sha256: sha256Bytes(content),
  })));
}

export function repositoryCacheCorpusWorkspaceSha256(moduleCount = repositoryCacheMediumModuleCount): string {
  return sha256Canonical(generateRepositoryCacheCorpus(moduleCount).map(({ bytes, path, sha256 }) => ({ bytes, path, sha256 })));
}

export async function materializeRepositoryCacheCorpus(
  workspace: string,
  moduleCount = repositoryCacheMediumModuleCount,
): Promise<readonly RepositoryCacheGeneratedFile[]> {
  const files = generateRepositoryCacheCorpus(moduleCount);
  for (const file of files) {
    const target = join(workspace, ...file.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
  return files;
}

export const repositoryCacheMediumCorpusV1 = Object.freeze({
  corpusId: "medium-deterministic",
  definitionSha256: repositoryCacheCorpusDefinitionSha256,
  fileCount: repositoryCacheMediumModuleCount,
  generatorVersion: repositoryCacheCorpusGeneratorVersion,
  seed: repositoryCacheCorpusSeed,
  workspaceSha256: repositoryCacheCorpusWorkspaceSha256(repositoryCacheMediumModuleCount),
});
