import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { z } from "zod";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { parseStrictJson } from "../../../../src/system/strict-json.js";

export const MEM_E0_EXPERIMENT_ID =
  "fal-mem-e0-agent-memory-task-effect-v1" as const;

export const MEM_E0_CASE_IDS = Object.freeze([
  "mem-e0-output-contract",
  "mem-e0-retry-schedule",
  "mem-e0-path-convention",
  "mem-e0-harm-control",
] as const);

export type MemE0CaseId = (typeof MEM_E0_CASE_IDS)[number];

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const relativePathSchema = z.string().min(1).max(256).refine((value) =>
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !value.includes("//") &&
  !value.split("/").includes("..") &&
  !/^[A-Za-z]:/u.test(value),
"path must be normalized repository-relative POSIX text");
const caseIdSchema = z.enum(MEM_E0_CASE_IDS);

const publicFileSchema = z.object({
  byteLength: z.number().int().nonnegative(),
  path: relativePathSchema,
  rawSha256: sha256Schema,
}).strict();

const caseSchema = z.object({
  schemaVersion: z.literal(1),
  experimentId: z.literal(MEM_E0_EXPERIMENT_ID),
  fixtureRevision: z.literal(1),
  caseId: caseIdSchema,
  caseClass: z.enum(["memory_dependent", "harm_control"]),
  task: z.object({
    text: z.string().min(32).max(2_048),
    taskSha256: sha256Schema,
  }).strict(),
  memory: z.object({
    kind: z.enum(["constraint", "decision"]),
    disclosureClass: z.literal("public_synthetic"),
    recordText: z.string().min(32).max(1_024),
    recordLogicalSha256: sha256Schema,
    requiredAcceptanceValue: z.string().min(8).max(256),
    requiredAcceptanceValueSha256: sha256Schema,
    forbiddenPublicSubstrings: z.array(z.string().min(4).max(256)).min(1).max(4),
  }).strict(),
  publicWorkspace: z.object({
    relativeDirectory: relativePathSchema,
    targetRelativePath: relativePathSchema,
    publicVerifierRelativePath: relativePathSchema,
    publicVerifierArgv: z.tuple([z.literal("node"), z.literal("verify.mjs")]),
    orderedFiles: z.array(publicFileSchema).min(3).max(8),
    manifestSha256: sha256Schema,
    initialTargetRawSha256: sha256Schema,
    allowedChangedPaths: z.tuple([relativePathSchema]),
  }).strict(),
  hiddenVerifier: z.object({
    relativePath: relativePathSchema,
    implementationRawSha256: sha256Schema,
    argvIdentitySha256: sha256Schema,
    initialExpected: z.literal("nonzero_exit"),
    successExitCode: z.literal(0),
    successStdoutSha256: sha256Schema,
  }).strict(),
  caseSha256: sha256Schema,
}).strict();

const caseRefSchema = z.object({
  caseId: caseIdSchema,
  caseClass: z.enum(["memory_dependent", "harm_control"]),
  relativePath: relativePathSchema,
  caseRawSha256: sha256Schema,
  caseSha256: sha256Schema,
}).strict();

const protocolSchema = z.object({
  schemaVersion: z.literal(1),
  experimentId: z.literal(MEM_E0_EXPERIMENT_ID),
  fixtureRevision: z.literal(1),
  evidenceClass: z.literal("contract_mechanics"),
  effectClaimAllowed: z.literal(false),
  providerCallsExpected: z.literal(0),
  caseCounts: z.object({
    total: z.literal(4),
    memoryDependent: z.literal(3),
    harmControl: z.literal(1),
  }).strict(),
  caseOrder: z.tuple([
    z.literal("mem-e0-output-contract"),
    z.literal("mem-e0-retry-schedule"),
    z.literal("mem-e0-path-convention"),
    z.literal("mem-e0-harm-control"),
  ]),
  cases: z.array(caseRefSchema).length(4),
  securityBoundary: z.object({
    publicSyntheticOnly: z.literal(true),
    hiddenVerifierCopiedToWorkspace: z.literal(false),
    hiddenValueAllowedInTaskOrPublicWorkspace: z.literal(false),
    providerCallsAuthorized: z.literal(false),
  }).strict(),
  nonClaims: z.array(z.string().min(16).max(512)).min(4).max(12),
  protocolSha256: sha256Schema,
}).strict();

export type MemE0CaseDefinition = Readonly<z.infer<typeof caseSchema>>;
export type MemE0Protocol = Readonly<z.infer<typeof protocolSchema>>;

export interface MemE0PublicFile {
  readonly byteLength: number;
  readonly content: string;
  readonly path: string;
  readonly rawSha256: string;
}

export interface MemE0LoadedCase {
  readonly definition: MemE0CaseDefinition;
  readonly directory: string;
  readonly hiddenVerifierPath: string;
  readonly publicFiles: readonly MemE0PublicFile[];
  readonly publicRoot: string;
  readonly rawSha256: string;
}

export interface MemE0Fixture {
  readonly cases: readonly MemE0LoadedCase[];
  readonly directory: string;
  readonly protocol: MemE0Protocol;
  readonly protocolRawSha256: string;
}

export function memE0RawSha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function withoutField<T extends Readonly<Record<string, unknown>>>(
  value: T,
  field: keyof T,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== field),
  );
}

export function parseMemE0Case(value: unknown): MemE0CaseDefinition {
  const parsed = caseSchema.parse(value);
  if (sha256Canonical(withoutField(parsed, "caseSha256")) !== parsed.caseSha256) {
    throw new Error("MEM-E0 case canonical self-hash mismatch");
  }
  if (memE0RawSha256(parsed.task.text) !== parsed.task.taskSha256) {
    throw new Error("MEM-E0 task hash mismatch");
  }
  if (
    sha256Canonical({
      disclosureClass: parsed.memory.disclosureClass,
      kind: parsed.memory.kind,
      text: parsed.memory.recordText,
    }) !== parsed.memory.recordLogicalSha256
  ) {
    throw new Error("MEM-E0 memory logical hash mismatch");
  }
  if (
    memE0RawSha256(parsed.memory.requiredAcceptanceValue) !==
      parsed.memory.requiredAcceptanceValueSha256
  ) {
    throw new Error("MEM-E0 acceptance value hash mismatch");
  }
  return Object.freeze(parsed);
}

export function parseMemE0Protocol(value: unknown): MemE0Protocol {
  const parsed = protocolSchema.parse(value);
  if (
    sha256Canonical(withoutField(parsed, "protocolSha256")) !==
      parsed.protocolSha256
  ) {
    throw new Error("MEM-E0 protocol canonical self-hash mismatch");
  }
  return Object.freeze(parsed);
}

async function listFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
      else throw new Error("MEM-E0 fixture contains a non-file public entry");
    }
  };
  await visit(root);
  return Object.freeze(files.sort());
}

const genericForbiddenPatterns = Object.freeze([
  /(?:api[_-]?key|authorization|bearer)\s*[:=]/iu,
  /\bsk-[A-Za-z0-9_-]{12,}\b/u,
  /\b[A-Za-z]:[\\/][^\s'"]+/u,
  /(?:\/Users\/|\/home\/)[^\s'"]+/u,
]);

export function scanMemE0AgentVisibleLeaks(input: Readonly<{
  readonly definition: MemE0CaseDefinition;
  readonly surfaces: readonly Readonly<{ readonly label: string; readonly text: string }>[];
}>): readonly string[] {
  const leaks = new Set<string>();
  for (const surface of input.surfaces) {
    const normalized = surface.text.normalize("NFC");
    for (const forbidden of input.definition.memory.forbiddenPublicSubstrings) {
      if (normalized.includes(forbidden.normalize("NFC"))) {
        leaks.add(`${surface.label}:exact_forbidden_value`);
      }
    }
    for (const pattern of genericForbiddenPatterns) {
      if (pattern.test(normalized)) leaks.add(`${surface.label}:forbidden_category`);
    }
  }
  return Object.freeze([...leaks].sort());
}

function assertCaseSemanticContract(loaded: MemE0LoadedCase): void {
  const { definition } = loaded;
  const positive = definition.caseId !== "mem-e0-harm-control";
  if ((definition.caseClass === "memory_dependent") !== positive) {
    throw new Error("MEM-E0 case class does not match the frozen case ID");
  }
  if (definition.publicWorkspace.targetRelativePath !== definition.publicWorkspace.allowedChangedPaths[0]) {
    throw new Error("MEM-E0 allowed path is not the exact target");
  }
  if (definition.publicWorkspace.publicVerifierRelativePath !== "verify.mjs") {
    throw new Error("MEM-E0 public verifier path drifted");
  }
  if (positive && !definition.memory.recordText.includes(definition.memory.requiredAcceptanceValue)) {
    throw new Error("MEM-E0 dependent memory omits its required acceptance value");
  }
  if (!positive && definition.memory.recordText.includes(definition.memory.requiredAcceptanceValue)) {
    throw new Error("MEM-E0 harm-control memory contains the task acceptance value");
  }
  const leaks = scanMemE0AgentVisibleLeaks({
    definition,
    surfaces: [
      { label: "task", text: definition.task.text },
      ...loaded.publicFiles.map((file) => ({ label: file.path, text: file.content })),
    ],
  });
  if (leaks.length > 0) {
    throw new Error(`MEM-E0 hidden-value leak detected: ${leaks.join(",")}`);
  }
  if (
    !definition.hiddenVerifier.relativePath.endsWith("/hidden/verifier.mjs") ||
    definition.hiddenVerifier.relativePath.startsWith(
      `${definition.publicWorkspace.relativeDirectory}/`,
    )
  ) {
    throw new Error("MEM-E0 hidden verifier is inside the public workspace");
  }
  const argvIdentitySha256 = sha256Canonical({
    args: [definition.hiddenVerifier.relativePath, "<workspace-root>"],
    cwd: "<fixture-root>",
    executable: "node",
  });
  if (argvIdentitySha256 !== definition.hiddenVerifier.argvIdentitySha256) {
    throw new Error("MEM-E0 hidden verifier argv identity mismatch");
  }
  if (
    memE0RawSha256(`MEM-E0 hidden pass: ${definition.caseId}\n`) !==
      definition.hiddenVerifier.successStdoutSha256
  ) {
    throw new Error("MEM-E0 hidden verifier success stdout identity mismatch");
  }
}

async function loadCase(
  fixtureDirectory: string,
  reference: MemE0Protocol["cases"][number],
): Promise<MemE0LoadedCase> {
  const casePath = join(fixtureDirectory, ...reference.relativePath.split("/"));
  const raw = await readFile(casePath, "utf8");
  if (memE0RawSha256(raw) !== reference.caseRawSha256) {
    throw new Error(`MEM-E0 raw case hash mismatch for ${reference.caseId}`);
  }
  const definition = parseMemE0Case(parseStrictJson(raw));
  if (
    definition.caseId !== reference.caseId ||
    definition.caseClass !== reference.caseClass ||
    definition.caseSha256 !== reference.caseSha256
  ) {
    throw new Error(`MEM-E0 protocol reference mismatch for ${reference.caseId}`);
  }
  const directory = join(fixtureDirectory, "cases", definition.caseId);
  const publicRoot = join(
    fixtureDirectory,
    ...definition.publicWorkspace.relativeDirectory.split("/"),
  );
  const actualPaths = await listFiles(publicRoot);
  const expectedPaths = definition.publicWorkspace.orderedFiles.map((file) => file.path);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(`MEM-E0 public file set mismatch for ${definition.caseId}`);
  }
  const publicFiles = await Promise.all(
    definition.publicWorkspace.orderedFiles.map(async (expected) => {
      const content = await readFile(join(publicRoot, ...expected.path.split("/")), "utf8");
      const actual = Object.freeze({
        byteLength: Buffer.byteLength(content, "utf8"),
        content,
        path: expected.path,
        rawSha256: memE0RawSha256(content),
      });
      if (
        actual.byteLength !== expected.byteLength ||
        actual.rawSha256 !== expected.rawSha256
      ) {
        throw new Error(`MEM-E0 public file hash mismatch for ${definition.caseId}/${expected.path}`);
      }
      return actual;
    }),
  );
  if (
    sha256Canonical(definition.publicWorkspace.orderedFiles) !==
      definition.publicWorkspace.manifestSha256
  ) {
    throw new Error(`MEM-E0 public manifest self-hash mismatch for ${definition.caseId}`);
  }
  const target = publicFiles.find(
    (file) => file.path === definition.publicWorkspace.targetRelativePath,
  );
  if (target?.rawSha256 !== definition.publicWorkspace.initialTargetRawSha256) {
    throw new Error(`MEM-E0 initial target hash mismatch for ${definition.caseId}`);
  }
  const hiddenVerifierPath = join(
    fixtureDirectory,
    ...definition.hiddenVerifier.relativePath.split("/"),
  );
  const hiddenBytes = await readFile(hiddenVerifierPath);
  if (memE0RawSha256(hiddenBytes) !== definition.hiddenVerifier.implementationRawSha256) {
    throw new Error(`MEM-E0 hidden verifier hash mismatch for ${definition.caseId}`);
  }
  const loaded = Object.freeze({
    definition,
    directory,
    hiddenVerifierPath,
    publicFiles: Object.freeze(publicFiles),
    publicRoot,
    rawSha256: reference.caseRawSha256,
  });
  assertCaseSemanticContract(loaded);
  return loaded;
}

export async function loadMemE0Fixture(repositoryRoot: string): Promise<MemE0Fixture> {
  const directory = join(
    repositoryRoot,
    "fixtures",
    "frontier-adapter-lab",
    MEM_E0_EXPERIMENT_ID,
  );
  const protocolRaw = await readFile(join(directory, "protocol.json"), "utf8");
  const protocol = parseMemE0Protocol(parseStrictJson(protocolRaw));
  if (
    protocol.cases.some((reference, index) =>
      reference.caseId !== protocol.caseOrder[index] ||
      reference.relativePath !== `cases/${reference.caseId}/case.json`
    )
  ) {
    throw new Error("MEM-E0 protocol case order or path drifted");
  }
  const cases = await Promise.all(
    protocol.cases.map((reference) => loadCase(directory, reference)),
  );
  return Object.freeze({
    cases: Object.freeze(cases),
    directory,
    protocol,
    protocolRawSha256: memE0RawSha256(protocolRaw),
  });
}
