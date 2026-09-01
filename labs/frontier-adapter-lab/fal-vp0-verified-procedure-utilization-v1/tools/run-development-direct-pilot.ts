import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson, sha256Canonical } from "../../../../src/completion/canonical-json.js";
import { loadDevelopmentPilotQualificationFromDs0Observation } from "../src/development-pilot-fixture.js";
import { ProductionDevelopmentDirectExecutor } from "../src/development-direct-executor.js";
import { loadDevelopmentDirectFixture } from "../src/development-direct-fixture.js";
import {
  planDevelopmentDirectPilot,
  runAuthorizedDevelopmentDirectPilot,
} from "../src/development-direct-runner.js";

const OUTPUT_ROOT =
  ".cache/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/development-direct-pilot-v1" as const;
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

async function replaceAndSync(handle: FileHandle, value: unknown): Promise<void> {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  await handle.truncate(0);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      offset,
    );
    if (result.bytesWritten < 1) {
      throw new Error("development direct durable receipt write made no progress");
    }
    offset += result.bytesWritten;
  }
  await handle.sync();
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
    else throw new Error(`unknown development direct option: ${argument ?? "missing"}`);
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
  if (match === null) throw new Error("--max-cost-usd must have at most six decimal places");
  const micros = Number(match[1]) * 1_000_000 + Number((match[2] ?? "").padEnd(6, "0"));
  if (!Number.isSafeInteger(micros)) throw new Error("--max-cost-usd is outside safe bounds");
  return micros;
}

function normalizedChild(input: Readonly<{
  readonly repositoryRoot: string;
  readonly requested: string;
  readonly requiredRoot: string;
  readonly requiredSuffix: string;
}>): Readonly<{ readonly absolute: string; readonly ref: string }> {
  if (
    input.requested.includes("\\") ||
    input.requested.startsWith("/") ||
    /^[A-Za-z]:/u.test(input.requested) ||
    input.requested.split("/").some((part) => part === "" || part === "." || part === "..") ||
    !input.requested.startsWith(`${input.requiredRoot}/`) ||
    !input.requested.endsWith(input.requiredSuffix)
  ) {
    throw new Error(`path must be normalized below ${input.requiredRoot}/`);
  }
  const absolute = resolve(input.repositoryRoot, ...input.requested.split("/"));
  const root = resolve(input.repositoryRoot, ...input.requiredRoot.split("/"));
  if (!absolute.startsWith(`${root}${sep}`)) throw new Error("path escaped its required cache root");
  return Object.freeze({
    absolute,
    ref: relative(input.repositoryRoot, absolute).split(sep).join("/"),
  });
}

function helpText(): string {
  return [
    "Offline plan (default; zero provider calls):",
    "  node --import tsx labs/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/tools/run-development-direct-pilot.ts",
    "Paid direct-generation pilot (six single-turn requests, no tools):",
    "  ... --authorize-remote --max-cost-usd 0.06 --accept-pricing-sha256 <sha256> --ds0-observation <path> --output .cache/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/development-direct-pilot-v1/<run>/receipt.json",
    "This is directional direct-generation evidence, never BornAgent tool-loop qualification.",
  ].join("\n");
}

export async function runDevelopmentDirectPilotCli(
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
    ) throw new Error("paid-run options require --authorize-remote in the same invocation");
    process.stdout.write(`${canonicalJson(await planDevelopmentDirectPilot(input.repositoryRoot))}\n`);
    return 0;
  }
  if (
    options.acceptPricingSha256 === undefined ||
    options.ds0Observation === undefined ||
    options.maxCostUsd === undefined ||
    options.output === undefined
  ) throw new Error("authorized direct pilot requires pricing, DS0, max cost, and output flags");
  const fixture = await loadDevelopmentDirectFixture(input.repositoryRoot);
  const maximumEstimatedCostUsdMicros = usdMicros(options.maxCostUsd);
  if (
    options.acceptPricingSha256 !== fixture.base.pricing.pricingSha256 ||
    maximumEstimatedCostUsdMicros < fixture.directProtocol.batchCaps.conservativePeakUpperBoundUsdMicros ||
    maximumEstimatedCostUsdMicros > fixture.directProtocol.batchCaps.maximumAuthorizedCostUsdMicros ||
    (input.environment.DEEPSEEK_API_KEY ?? "").trim().length === 0
  ) throw new Error("development direct authorization, pricing, cost, or credential preflight failed");
  const ds0 = normalizedChild({
    repositoryRoot: input.repositoryRoot,
    requested: options.ds0Observation,
    requiredRoot: DS0_OBSERVATION_ROOT,
    requiredSuffix: "/observation.json",
  });
  await loadDevelopmentPilotQualificationFromDs0Observation(ds0.absolute, fixture.base);
  const output = normalizedChild({
    repositoryRoot: input.repositoryRoot,
    requested: options.output,
    requiredRoot: OUTPUT_ROOT,
    requiredSuffix: ".json",
  });
  await mkdir(dirname(output.absolute), { recursive: true });
  const outputHandle = await open(output.absolute, "wx", 0o600);
  let receipt: Awaited<ReturnType<typeof runAuthorizedDevelopmentDirectPilot>>;
  let durableCheckpointWritten = false;
  try {
    receipt = await runAuthorizedDevelopmentDirectPilot({
      authorization: {
        acceptedPricingSha256: options.acceptPricingSha256,
        authorizeRemote: true,
        maximumEstimatedCostUsdMicros,
      },
      ds0ObservationPath: ds0.absolute,
      environment: input.environment,
      executor: new ProductionDevelopmentDirectExecutor(),
      checkpointSink: async (checkpoint) => {
        const checkpointArtifact = Object.freeze({
          ...checkpoint,
          checkpointSha256: sha256Canonical(checkpoint),
        });
        await replaceAndSync(outputHandle, checkpointArtifact);
        durableCheckpointWritten = true;
      },
      repositoryRoot: input.repositoryRoot,
    });
    await replaceAndSync(outputHandle, receipt);
  } catch (error) {
    const failure = {
      schemaVersion: 1,
      pilotId: "fal-vp0-deepseek-direct-generation-pilot-v1",
      status: "orchestration_failed_without_attempt_receipt",
      errorMessagePersisted: false,
      absolutePathsPersisted: false,
      apiKeyPersisted: false,
      rawProviderReasoningPersisted: false,
      rawProviderResponsePersisted: false,
    } as const;
    if (!durableCheckpointWritten) {
      await replaceAndSync(outputHandle, Object.freeze({
        ...failure,
        receiptSha256: sha256Canonical(failure),
      })).catch(() => undefined);
    }
    throw error;
  } finally {
    await outputHandle.close();
  }
  process.stdout.write(`${canonicalJson({
    event: "vp0_development_direct_receipt_written",
    outputRef: output.ref,
    receiptSha256: receipt.receiptSha256,
    status: receipt.status,
  })}\n`);
  return receipt.status === "completed" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runDevelopmentDirectPilotCli(process.argv.slice(2), {
    environment: process.env,
    repositoryRoot: process.cwd(),
  }).then(
    (exitCode) => { process.exitCode = exitCode; },
    () => {
      process.stderr.write("development direct pilot refused or failed; no raw provider output was persisted\n");
      process.exitCode = 1;
    },
  );
}
