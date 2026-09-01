import { mkdir, open } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson } from "../../../../src/completion/canonical-json.js";
import {
  loadDevelopmentPilotFixture,
  loadDevelopmentPilotQualificationFromDs0Observation,
} from "../src/development-pilot-fixture.js";
import { ProductionDevelopmentPilotExecutor } from "../src/development-pilot-production-executor.js";
import {
  planDevelopmentPilot,
  runAuthorizedDevelopmentPilot,
} from "../src/development-pilot-runner.js";

const OUTPUT_ROOT =
  ".cache/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/development-pilot-v1" as const;
const DS0_OBSERVATION_ROOT =
  ".cache/frontier-adapter-lab/fal-ds0-deepseek-tool-actor-v1/runs" as const;

interface CliOptions {
  readonly acceptPricingSha256?: string;
  readonly authorizeRemote: boolean;
  readonly ds0Observation?: string;
  readonly help: boolean;
  readonly maxCostUsd?: string;
  readonly output?: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let acceptPricingSha256: string | undefined;
  let authorizeRemote = false;
  let ds0Observation: string | undefined;
  let help = false;
  let maxCostUsd: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--authorize-remote") authorizeRemote = true;
    else if (argument === "--help") help = true;
    else if (argument === "--accept-pricing-sha256") acceptPricingSha256 = argv[++index];
    else if (argument === "--ds0-observation") ds0Observation = argv[++index];
    else if (argument === "--max-cost-usd") maxCostUsd = argv[++index];
    else if (argument === "--output") output = argv[++index];
    else throw new Error(`unknown development pilot option: ${argument ?? "missing"}`);
  }
  return Object.freeze({
    ...(acceptPricingSha256 === undefined ? {} : { acceptPricingSha256 }),
    authorizeRemote,
    ...(ds0Observation === undefined ? {} : { ds0Observation }),
    help,
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
    ...(output === undefined ? {} : { output }),
  });
}

function usdMicros(value: string): number {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/u.exec(value);
  if (match === null) throw new Error("--max-cost-usd must be a nonnegative decimal with at most six places");
  const micros = Number(match[1]) * 1_000_000 + Number((match[2] ?? "").padEnd(6, "0"));
  if (!Number.isSafeInteger(micros)) throw new Error("--max-cost-usd is outside safe bounds");
  return micros;
}

function normalizedOutput(repositoryRoot: string, requested: string): Readonly<{
  readonly absolute: string;
  readonly ref: string;
}> {
  if (
    requested.includes("\\") ||
    requested.startsWith("/") ||
    /^[A-Za-z]:/u.test(requested) ||
    requested.split("/").some((part) => part === "" || part === "." || part === "..") ||
    !requested.startsWith(`${OUTPUT_ROOT}/`) ||
    !requested.endsWith(".json")
  ) {
    throw new Error(`--output must be a new JSON path below ${OUTPUT_ROOT}/`);
  }
  const absolute = resolve(repositoryRoot, ...requested.split("/"));
  const cacheRoot = resolve(repositoryRoot, ...OUTPUT_ROOT.split("/"));
  if (dirname(absolute) === resolve(repositoryRoot) || !absolute.startsWith(`${cacheRoot}${sep}`)) {
    throw new Error("--output escaped the development pilot cache root");
  }
  return Object.freeze({ absolute, ref: relative(repositoryRoot, absolute).split(sep).join("/") });
}

function normalizedDs0Observation(repositoryRoot: string, requested: string): string {
  if (
    requested.includes("\\") ||
    requested.startsWith("/") ||
    /^[A-Za-z]:/u.test(requested) ||
    requested.split("/").some((part) => part === "" || part === "." || part === "..") ||
    !requested.startsWith(`${DS0_OBSERVATION_ROOT}/`) ||
    !requested.endsWith("/observation.json")
  ) {
    throw new Error(`--ds0-observation must name a DS0 run below ${DS0_OBSERVATION_ROOT}/`);
  }
  const absolute = resolve(repositoryRoot, ...requested.split("/"));
  const root = resolve(repositoryRoot, ...DS0_OBSERVATION_ROOT.split("/"));
  if (!absolute.startsWith(`${root}${sep}`)) {
    throw new Error("--ds0-observation escaped the DS0 run cache root");
  }
  return absolute;
}

function helpText(): string {
  return [
    "Offline plan (default; zero provider calls):",
    "  node --import tsx labs/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/tools/run-development-pilot.ts",
    "Paid development pilot (requires a passed DS0 observation):",
    "  ... --authorize-remote --max-cost-usd 0.18 --accept-pricing-sha256 <sha256> --ds0-observation <path> --output .cache/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/development-pilot-v1/<run>/receipt.json",
    "This is directional procedure-present vs no-memory evidence, never a VP0 gate.",
  ].join("\n");
}

export async function runDevelopmentPilotCli(
  argv: readonly string[],
  input: Readonly<{
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly repositoryRoot: string;
  }>,
): Promise<number> {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  if (!options.authorizeRemote) {
    if (
      options.acceptPricingSha256 !== undefined ||
      options.ds0Observation !== undefined ||
      options.maxCostUsd !== undefined ||
      options.output !== undefined
    ) {
      throw new Error("paid-run options require --authorize-remote in the same invocation");
    }
    process.stdout.write(`${canonicalJson(await planDevelopmentPilot(input.repositoryRoot))}\n`);
    return 0;
  }
  if (
    options.acceptPricingSha256 === undefined ||
    options.ds0Observation === undefined ||
    options.maxCostUsd === undefined ||
    options.output === undefined
  ) {
    throw new Error("authorized development pilot requires pricing, DS0 observation, max cost, and output flags");
  }
  const output = normalizedOutput(input.repositoryRoot, options.output);
  const ds0ObservationPath = normalizedDs0Observation(
    input.repositoryRoot,
    options.ds0Observation,
  );
  const maximumEstimatedCostUsdMicros = usdMicros(options.maxCostUsd);
  const fixture = await loadDevelopmentPilotFixture(input.repositoryRoot);
  if (
    options.acceptPricingSha256 !== fixture.pricing.pricingSha256 ||
    maximumEstimatedCostUsdMicros < fixture.protocol.batchCaps.conservativePeakUpperBoundUsdMicros ||
    maximumEstimatedCostUsdMicros > fixture.protocol.batchCaps.maximumEstimatedPeakCostUsdMicros ||
    (input.environment.DEEPSEEK_API_KEY ?? "").trim().length === 0
  ) {
    throw new Error("development pilot authorization, pricing, cost, or credential preflight failed");
  }
  await loadDevelopmentPilotQualificationFromDs0Observation(ds0ObservationPath, fixture);
  await mkdir(dirname(output.absolute), { recursive: true });
  const outputHandle = await open(output.absolute, "wx", 0o600);
  let receipt: Awaited<ReturnType<typeof runAuthorizedDevelopmentPilot>>;
  try {
    receipt = await runAuthorizedDevelopmentPilot({
      authorization: {
        acceptedPricingSha256: options.acceptPricingSha256,
        authorizeRemote: true,
        maximumEstimatedCostUsdMicros,
      },
      environment: input.environment,
      executor: new ProductionDevelopmentPilotExecutor(),
      ds0ObservationPath,
      repositoryRoot: input.repositoryRoot,
    });
    await outputHandle.writeFile(`${canonicalJson(receipt)}\n`, "utf8");
    await outputHandle.sync();
  } catch (error) {
    await outputHandle.writeFile(`${canonicalJson({
      schemaVersion: 1,
      pilotId: "fal-vp0-deepseek-development-pilot-v1",
      status: "orchestration_failed_without_receipt",
      errorMessagePersisted: false,
      absolutePathsPersisted: false,
      apiKeyPersisted: false,
      rawProviderReasoningPersisted: false,
      rawProviderResponsePersisted: false,
    })}\n`, "utf8").catch(() => undefined);
    await outputHandle.sync().catch(() => undefined);
    throw error;
  } finally {
    await outputHandle.close();
  }
  process.stdout.write(`${canonicalJson({
    event: "vp0_development_pilot_receipt_written",
    outputRef: output.ref,
    receiptSha256: receipt.receiptSha256,
    status: receipt.status,
  })}\n`);
  return receipt.status === "completed" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runDevelopmentPilotCli(process.argv.slice(2), {
    environment: process.env,
    repositoryRoot: process.cwd(),
  }).then(
    (exitCode) => { process.exitCode = exitCode; },
    () => {
      process.stderr.write("development pilot refused or failed; no raw provider output was persisted\n");
      process.exitCode = 1;
    },
  );
}
