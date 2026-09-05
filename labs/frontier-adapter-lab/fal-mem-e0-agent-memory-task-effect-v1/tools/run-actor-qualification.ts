import { open, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  canonicalJson,
  sha256Canonical,
} from "../../../../src/completion/canonical-json.js";
import { parseStrictJson } from "../../../../src/system/strict-json.js";
import {
  MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_COST_USD_MICROS,
} from "../src/actor-qualification.js";
import {
  createMemE0LiveActorQualificationAuthorization,
  planMemE0LiveActorQualification,
  runMemE0LiveActorQualificationRunner,
} from "../src/live-actor-qualification-runner.js";

const MAXIMUM_AUTHORIZED_COST_USD_MICROS =
  MEM_E0_ACTOR_QUALIFICATION_MAXIMUM_COST_USD_MICROS;
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const SAFE_CACHE_FILE = /^[a-z0-9][a-z0-9._-]{0,126}\.json$/u;
const DS0_RUN_DIRECTORY = /^ds0-[a-z0-9][a-z0-9-]{0,127}$/u;
const PLAN_ENVELOPE_TYPE =
  "mem-e0-deepseek-tool-actor-qualification-plan-envelope-v1" as const;
const FAILURE_ENVELOPE_TYPE =
  "mem-e0-deepseek-tool-actor-qualification-failure-v1" as const;
const FIXED_FAILURE_MESSAGE =
  "MEM-E0 actor qualification command failed.\n" as const;

const HELP = `MEM-E0 DeepSeek production tool-actor qualification

Plan only (always zero remote calls):
  pnpm lab:mem-e0:qualify -- plan \\
    --ds0-observation .cache/frontier-adapter-lab/fal-ds0-deepseek-tool-actor-v1/runs/<run>/observation.json \\
    [--output .cache/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/qualification/plans/<name>.json]

Authorized live qualification:
  pnpm lab:mem-e0:qualify -- live \\
    --plan .cache/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/qualification/plans/<name>.json \\
    --ds0-observation .cache/frontier-adapter-lab/fal-ds0-deepseek-tool-actor-v1/runs/<run>/observation.json \\
    --output .cache/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/qualification/receipts/<name>.json \\
    --authorize-remote \\
    --confirm-plan-sha256 <sha256> \\
    --confirm-freeze-sha256 <sha256> \\
    --confirm-source-commit <commit> \\
    --confirm-protected-tree-sha256 <sha256> \\
    --confirm-ds0-reference-sha256 <sha256> \\
    --confirm-ds0-observation-sha256 <sha256> \\
    --confirm-ds0-record-sha256 <sha256> \\
    --confirm-cost-usd-micros 54814

The plan is not remote authorization. The qualification cost cap is separate
from the later eight-attempt memory-effect batch.
`;

interface CliWriter {
  write(value: string): void;
}

interface ExclusiveOutput {
  close(): Promise<void>;
  sync(): Promise<void>;
  write(value: string): Promise<void>;
}

export interface MemE0ActorQualificationCliDependencies {
  readonly createDirectory: (path: string) => Promise<void>;
  readonly openExclusive: (path: string) => Promise<ExclusiveOutput>;
  readonly plan: (input: Readonly<{
    readonly ds0ObservationPath: string;
    readonly repositoryRoot: string;
  }>) => Promise<unknown>;
  readonly readText: (path: string) => Promise<string>;
  readonly repositoryRoot: string;
  readonly run: (input: Readonly<{
    readonly authorization: unknown;
    readonly ds0ObservationPath: string;
    readonly plan: unknown;
    readonly repositoryRoot: string;
  }>) => Promise<unknown>;
  readonly stderr: CliWriter;
  readonly stdout: CliWriter;
  readonly writeExclusive: (path: string, value: string) => Promise<void>;
}

interface ParsedArguments {
  readonly flags: ReadonlyMap<string, string | true>;
  readonly mode: "live" | "plan";
}

interface PlanEnvelope {
  readonly envelopeSha256: string;
  readonly envelopeType: typeof PLAN_ENVELOPE_TYPE;
  readonly plan: Readonly<Record<string, unknown>>;
  readonly receipt: Readonly<Record<string, unknown>>;
  readonly schemaVersion: 1;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  return sha256Canonical(Object.keys(value).sort()) ===
    sha256Canonical([...expected].sort());
}

function requiredString(
  flags: ReadonlyMap<string, string | true>,
  name: string,
): string {
  const value = flags.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("qualification command omitted a required value");
  }
  return value;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const mode = argv[0];
  if (mode !== "plan" && mode !== "live") {
    throw new TypeError("qualification command requires plan or live mode");
  }
  const valueFlags = new Set(mode === "plan"
    ? ["--ds0-observation", "--output"]
    : [
        "--confirm-cost-usd-micros",
        "--confirm-ds0-observation-sha256",
        "--confirm-ds0-record-sha256",
        "--confirm-ds0-reference-sha256",
        "--confirm-freeze-sha256",
        "--confirm-plan-sha256",
        "--confirm-protected-tree-sha256",
        "--confirm-source-commit",
        "--ds0-observation",
        "--output",
        "--plan",
      ]);
  const booleanFlags = new Set(mode === "live" ? ["--authorize-remote"] : []);
  const flags = new Map<string, string | true>();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (flags.has(token)) {
      throw new TypeError("qualification command repeated an option");
    }
    if (booleanFlags.has(token)) {
      flags.set(token, true);
      continue;
    }
    if (!valueFlags.has(token)) {
      throw new TypeError("qualification command received an unknown option");
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new TypeError("qualification command omitted an option value");
    }
    flags.set(token, value);
    index += 1;
  }
  requiredString(flags, "--ds0-observation");
  if (mode === "live") {
    for (const name of valueFlags) requiredString(flags, name);
    if (flags.get("--authorize-remote") !== true) {
      throw new TypeError("qualification command lacks remote authorization");
    }
  }
  return Object.freeze({ flags, mode });
}

function repositoryRelativePath(
  repositoryRoot: string,
  rawPath: string,
): Readonly<{ readonly absolute: string; readonly segments: readonly string[] }> {
  const root = resolve(repositoryRoot);
  const absolute = resolve(root, rawPath);
  const nested = relative(root, absolute);
  if (
    nested.length === 0 ||
    isAbsolute(nested) ||
    nested.startsWith("..")
  ) {
    throw new TypeError("qualification cache path is outside the repository");
  }
  const segments = Object.freeze(nested.split(sep));
  if (segments.some((segment) => segment.length === 0 || segment === "..")) {
    throw new TypeError("qualification cache path is not normalized");
  }
  return Object.freeze({ absolute, segments });
}

function ds0ObservationPath(repositoryRoot: string, rawPath: string): string {
  const path = repositoryRelativePath(repositoryRoot, rawPath);
  const expected = [
    ".cache",
    "frontier-adapter-lab",
    "fal-ds0-deepseek-tool-actor-v1",
    "runs",
  ];
  if (
    path.segments.length !== 6 ||
    !expected.every((segment, index) => path.segments[index] === segment) ||
    !DS0_RUN_DIRECTORY.test(path.segments[4]!) ||
    path.segments[5] !== "observation.json"
  ) {
    throw new TypeError("qualification DS0 observation path is out of scope");
  }
  return path.absolute;
}

function qualificationCachePath(
  repositoryRoot: string,
  rawPath: string,
  leaf: "plans" | "receipts",
): string {
  const path = repositoryRelativePath(repositoryRoot, rawPath);
  const expected = [
    ".cache",
    "frontier-adapter-lab",
    "fal-mem-e0-agent-memory-task-effect-v1",
    "qualification",
    leaf,
  ];
  if (
    path.segments.length !== 6 ||
    !expected.every((segment, index) => path.segments[index] === segment) ||
    !SAFE_CACHE_FILE.test(path.segments[5]!)
  ) {
    throw new TypeError("qualification output path is out of scope");
  }
  return path.absolute;
}

function selfHashedRecord(
  value: unknown,
  hashField: string,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value) || typeof value[hashField] !== "string") {
    throw new TypeError("qualification result omitted its self hash");
  }
  const expected = value[hashField];
  if (!SHA256.test(expected)) {
    throw new TypeError("qualification result self hash is invalid");
  }
  const content = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== hashField),
  );
  if (sha256Canonical(content) !== expected) {
    throw new TypeError("qualification result self hash mismatched");
  }
  return Object.freeze({ ...value });
}

function planEnvelope(result: unknown): PlanEnvelope {
  if (
    !isRecord(result) ||
    !exactKeys(result, ["plan", "receipt"])
  ) {
    throw new TypeError("qualification planner returned an invalid envelope");
  }
  const plan = selfHashedRecord(result.plan, "planSha256");
  const receipt = selfHashedRecord(result.receipt, "receiptSha256");
  if (
    receipt.effectClaimAllowed !== false ||
    receipt.providerCalls !== 0 ||
    !isRecord(receipt.result) ||
    receipt.result.status !== "not_run" ||
    sha256Canonical(receipt.freeze) !== sha256Canonical(plan.freeze) ||
    sha256Canonical(receipt.source) !== sha256Canonical(plan.source) ||
    sha256Canonical(receipt.task) !== sha256Canonical(plan.task)
  ) {
    throw new TypeError("qualification plan did not carry an exact not-run receipt");
  }
  const content = Object.freeze({
    envelopeType: PLAN_ENVELOPE_TYPE,
    plan,
    receipt,
    schemaVersion: 1 as const,
  });
  return Object.freeze({
    ...content,
    envelopeSha256: sha256Canonical(content),
  });
}

function parsePlanEnvelope(raw: string): PlanEnvelope {
  const value = parseStrictJson(raw);
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "envelopeSha256",
      "envelopeType",
      "plan",
      "receipt",
      "schemaVersion",
    ]) ||
    value.envelopeType !== PLAN_ENVELOPE_TYPE ||
    value.schemaVersion !== 1
  ) {
    throw new TypeError("qualification plan file has an invalid envelope");
  }
  const { envelopeSha256, ...content } = value;
  if (
    typeof envelopeSha256 !== "string" ||
    !SHA256.test(envelopeSha256) ||
    envelopeSha256 !== sha256Canonical(content)
  ) {
    throw new TypeError("qualification plan envelope self hash mismatched");
  }
  const rebuilt = planEnvelope({ plan: value.plan, receipt: value.receipt });
  if (rebuilt.envelopeSha256 !== envelopeSha256) {
    throw new TypeError("qualification plan envelope content drifted");
  }
  return rebuilt;
}

function stringField(
  value: Readonly<Record<string, unknown>>,
  name: string,
  pattern: RegExp = SHA256,
): string {
  const field = value[name];
  if (typeof field !== "string" || !pattern.test(field)) {
    throw new TypeError("qualification plan omitted an authorization binding");
  }
  return field;
}

function nestedRecord(
  value: Readonly<Record<string, unknown>>,
  name: string,
): Readonly<Record<string, unknown>> {
  const field = value[name];
  if (!isRecord(field)) {
    throw new TypeError("qualification plan omitted a nested binding");
  }
  return field;
}

function exactConfirmation(
  flags: ReadonlyMap<string, string | true>,
  name: string,
  expected: string,
): string {
  const value = requiredString(flags, name);
  if (value !== expected) {
    throw new TypeError("qualification authorization confirmation mismatched");
  }
  return value;
}

function authorizationFrom(
  plan: Readonly<Record<string, unknown>>,
  flags: ReadonlyMap<string, string | true>,
): unknown {
  const freeze = nestedRecord(plan, "freeze");
  const source = nestedRecord(plan, "source");
  const ds0 = nestedRecord(plan, "ds0");
  const cost = nestedRecord(plan, "cost");
  const maximumCost = cost.maximumAuthorizedCostUsdMicros;
  if (maximumCost !== MAXIMUM_AUTHORIZED_COST_USD_MICROS) {
    throw new TypeError("qualification plan cost cap drifted");
  }
  const confirmedCost = requiredString(flags, "--confirm-cost-usd-micros");
  if (confirmedCost !== String(MAXIMUM_AUTHORIZED_COST_USD_MICROS)) {
    throw new TypeError("qualification cost confirmation mismatched");
  }
  return createMemE0LiveActorQualificationAuthorization({
    actorFreezeSha256Confirmation: exactConfirmation(
      flags,
      "--confirm-freeze-sha256",
      stringField(freeze, "actorFreezeSha256"),
    ),
    authorizeRemote: true,
    ds0ObservationReferenceSha256Confirmation: exactConfirmation(
      flags,
      "--confirm-ds0-reference-sha256",
      stringField(ds0, "observationReferenceSha256"),
    ),
    ds0ObservationSha256Confirmation: exactConfirmation(
      flags,
      "--confirm-ds0-observation-sha256",
      stringField(ds0, "observationSha256"),
    ),
    maximumAuthorizedCostUsdMicros: MAXIMUM_AUTHORIZED_COST_USD_MICROS,
    modelQualificationRecordSha256Confirmation: exactConfirmation(
      flags,
      "--confirm-ds0-record-sha256",
      stringField(ds0, "recordSha256"),
    ),
    planSha256Confirmation: exactConfirmation(
      flags,
      "--confirm-plan-sha256",
      stringField(plan, "planSha256"),
    ),
    protectedTreeSha256Confirmation: exactConfirmation(
      flags,
      "--confirm-protected-tree-sha256",
      stringField(source, "protectedTreeSha256"),
    ),
    schemaVersion: 1,
    sourceCommitConfirmation: exactConfirmation(
      flags,
      "--confirm-source-commit",
      stringField(source, "commit", COMMIT),
    ),
  });
}

function failureEnvelope(
  plan: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const content = Object.freeze({
    accountedMaximumCostUsdMicros:
      MAXIMUM_AUTHORIZED_COST_USD_MICROS,
    envelopeType: FAILURE_ENVELOPE_TYPE,
    hygiene: Object.freeze({
      absolutePathsPersisted: false,
      rawErrorsPersisted: false,
      rawProviderDataPersisted: false,
      rawToolOutputPersisted: false,
      secretsPersisted: false,
    }),
    planSha256: stringField(plan, "planSha256"),
    providerCalls: "unknown_after_authorized_attempt" as const,
    schemaVersion: 1 as const,
    status: "qualification_failed_without_receipt" as const,
  });
  return Object.freeze({
    ...content,
    failureEnvelopeSha256: sha256Canonical(content),
  });
}

function completedReceipt(value: unknown): Readonly<Record<string, unknown>> {
  const receipt = selfHashedRecord(value, "receiptSha256");
  if (
    receipt.effectClaimAllowed !== false ||
    !isRecord(receipt.result) ||
    receipt.result.status === "not_run"
  ) {
    throw new TypeError("authorized qualification returned a non-live receipt");
  }
  return receipt;
}

function defaultDependencies(): MemE0ActorQualificationCliDependencies {
  return Object.freeze({
    createDirectory: async (path: string) => {
      await mkdir(path, { recursive: true });
    },
    openExclusive: async (path: string): Promise<ExclusiveOutput> => {
      const handle = await open(path, "wx", 0o600);
      return Object.freeze({
        close: async () => await handle.close(),
        sync: async () => await handle.sync(),
        write: async (value: string) => {
          await handle.writeFile(value, "utf8");
        },
      });
    },
    plan: async (
      input: Parameters<typeof planMemE0LiveActorQualification>[0],
    ) => await planMemE0LiveActorQualification(input),
    readText: async (path: string) => {
      const raw = await readFile(path);
      if (raw.byteLength > 2 * 1_024 * 1_024) {
        throw new TypeError("qualification plan file exceeds its byte limit");
      }
      return raw.toString("utf8");
    },
    repositoryRoot: resolve("."),
    run: async (
      input: Parameters<typeof runMemE0LiveActorQualificationRunner>[0],
    ) => await runMemE0LiveActorQualificationRunner(input),
    stderr: process.stderr,
    stdout: process.stdout,
    writeExclusive: async (path: string, value: string) => {
      await writeFile(path, value, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    },
  });
}

async function runPlan(
  parsed: ParsedArguments,
  dependencies: MemE0ActorQualificationCliDependencies,
): Promise<void> {
  const ds0Path = ds0ObservationPath(
    dependencies.repositoryRoot,
    requiredString(parsed.flags, "--ds0-observation"),
  );
  const rawOutput = parsed.flags.get("--output");
  const outputPath = typeof rawOutput === "string"
    ? qualificationCachePath(
        dependencies.repositoryRoot,
        rawOutput,
        "plans",
      )
    : null;
  const result = await dependencies.plan({
    ds0ObservationPath: ds0Path,
    repositoryRoot: resolve(dependencies.repositoryRoot),
  });
  const envelope = planEnvelope(result);
  const serialized = `${canonicalJson(envelope)}\n`;
  if (outputPath !== null) {
    await dependencies.createDirectory(dirname(outputPath));
    await dependencies.writeExclusive(outputPath, serialized);
  }
  dependencies.stdout.write(serialized);
}

async function writeLiveReceipt(
  parsed: ParsedArguments,
  dependencies: MemE0ActorQualificationCliDependencies,
): Promise<void> {
  const ds0Path = ds0ObservationPath(
    dependencies.repositoryRoot,
    requiredString(parsed.flags, "--ds0-observation"),
  );
  const planPath = qualificationCachePath(
    dependencies.repositoryRoot,
    requiredString(parsed.flags, "--plan"),
    "plans",
  );
  const outputPath = qualificationCachePath(
    dependencies.repositoryRoot,
    requiredString(parsed.flags, "--output"),
    "receipts",
  );
  const envelope = parsePlanEnvelope(await dependencies.readText(planPath));
  const authorization = authorizationFrom(envelope.plan, parsed.flags);

  await dependencies.createDirectory(dirname(outputPath));
  const output = await dependencies.openExclusive(outputPath);
  const receipt = await (async (): Promise<Readonly<Record<string, unknown>>> => {
    try {
      try {
        const completed = completedReceipt(await dependencies.run({
          authorization,
          ds0ObservationPath: ds0Path,
          plan: envelope.plan,
          repositoryRoot: resolve(dependencies.repositoryRoot),
        }));
        await output.write(`${canonicalJson(completed)}\n`);
        await output.sync();
        return completed;
      } catch {
        await output.write(`${canonicalJson(failureEnvelope(envelope.plan))}\n`);
        await output.sync();
        throw new Error("qualification failed without a completed receipt");
      }
    } finally {
      await output.close();
    }
  })();
  dependencies.stdout.write(`${canonicalJson({
    receiptSha256: stringField(receipt, "receiptSha256"),
    status: "qualification_receipt_written",
  })}\n`);
}

export async function runMemE0ActorQualificationCli(
  argv: readonly string[],
  overrides: Partial<MemE0ActorQualificationCliDependencies> = {},
): Promise<number> {
  const dependencies = Object.freeze({
    ...defaultDependencies(),
    ...overrides,
  });
  if (argv.includes("--help") || argv.includes("-h")) {
    dependencies.stdout.write(HELP);
    return 0;
  }
  try {
    const parsed = parseArguments(argv);
    if (parsed.mode === "plan") await runPlan(parsed, dependencies);
    else await writeLiveReceipt(parsed, dependencies);
    return 0;
  } catch {
    dependencies.stderr.write(FIXED_FAILURE_MESSAGE);
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runMemE0ActorQualificationCli(process.argv.slice(2));
}

const entry = process.argv[1];
if (
  entry !== undefined &&
  import.meta.url === pathToFileURL(resolve(entry)).href
) {
  await main();
}
