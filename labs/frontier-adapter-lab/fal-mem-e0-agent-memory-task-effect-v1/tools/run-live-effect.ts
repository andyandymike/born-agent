import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { memE0RawSha256 } from "../src/fixture.js";
import { memE0EffectPreparedEnvelopeSchema, prepareMemE0LiveEffect, runMemE0LiveEffect } from "../src/live-effect-runner.js";
import { MEM_E0_LIVE_UPPER_BOUND_USD_MICROS } from "../src/live-preflight.js";
import { parseStrictJson } from "../../../../src/system/strict-json.js";

const CACHE = ".cache/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1";
const HELP = `MEM-E0 live paired effect test\n
Plan and prepare eight isolated Session A records (zero provider calls):
  pnpm lab:mem-e0:effect -- plan --qualification <qualification receipt or plan> --ds0-observation <retained observation> --output ${CACHE}/effect/plans/<name>.json

Separately authorized eight-attempt run (qualification must pass on the same commit):
  pnpm lab:mem-e0:effect -- live --plan ${CACHE}/effect/plans/<name>.json --output ${CACHE}/effect/receipts/<name>.json --authorize-remote --confirm-plan-sha256 <sha256> --confirm-cost-usd-micros ${MEM_E0_LIVE_UPPER_BOUND_USD_MICROS}
No automatic retry. Planning never reads an API key.\n`;

function parseArgs(argv: readonly string[]) {
  const mode = argv[0];
  if (mode !== "plan" && mode !== "live") throw new Error("effect command requires plan or live");
  const names = mode === "plan" ? ["--qualification", "--ds0-observation", "--output"] :
    ["--plan", "--output", "--confirm-plan-sha256", "--confirm-cost-usd-micros"];
  const flags = new Map<string, string>();
  for (let i = 1; i < argv.length; i += 1) {
    const name = argv[i]!;
    if (flags.has(name)) throw new Error("effect command repeated a flag");
    if (mode === "live" && name === "--authorize-remote") { flags.set(name, "true"); continue; }
    const value = argv[++i];
    if (!names.includes(name) || value === undefined || value.startsWith("--")) throw new Error("effect command has an unknown or incomplete flag");
    flags.set(name, value);
  }
  if (names.some((name) => !flags.has(name))) throw new Error("effect command omitted a required flag");
  if (mode === "live" && (flags.get("--authorize-remote") !== "true" ||
    flags.get("--confirm-cost-usd-micros") !== String(MEM_E0_LIVE_UPPER_BOUND_USD_MICROS) || !/^[a-f0-9]{64}$/u.test(flags.get("--confirm-plan-sha256")!))) {
    throw new Error("effect command requires explicit exact batch authorization");
  }
  return { mode, flags };
}
function cachePath(root: string, value: string, kind: "plans" | "receipts" | "qualification" | "ds0") {
  const path = resolve(root, value);
  const nested = relative(root, path).split(sep).join("/");
  const filename = "[a-z0-9][a-z0-9._-]{0,126}\\.json";
  const expected = kind === "ds0" ? /^\.cache\/frontier-adapter-lab\/fal-ds0-deepseek-tool-actor-v1\/runs\/ds0-[a-z0-9-]+\/observation\.json$/u :
    new RegExp(`^${CACHE.replaceAll(".", "\\.")}/${kind === "qualification" ? "qualification/(plans|receipts)" : `effect/${kind}`}/${filename}$`, "u");
  if (isAbsolute(nested) || nested.startsWith("..") || !expected.test(nested)) throw new Error("effect artifact path is outside its exact cache boundary");
  return path;
}
async function readJson(root: string, path: string) {
  const stat = await lstat(path);
  const canonical = await realpath(path);
  const nested = relative(await realpath(root), canonical);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576 || nested.startsWith("..") || isAbsolute(nested)) throw new Error("effect artifact is not a bounded repository file");
  return parseStrictJson(await readFile(path, "utf8"));
}

export async function runMemE0LiveEffectCli(argv: readonly string[], repositoryRoot = resolve(".")): Promise<void> {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0]!)) { process.stdout.write(HELP); return; }
  const { mode, flags } = parseArgs(argv);
  const outputPath = cachePath(repositoryRoot, flags.get("--output")!, mode === "plan" ? "plans" : "receipts");
  await mkdir(dirname(outputPath), { recursive: true });
  const output = await open(outputPath, "wx");
  try {
    if (mode === "plan") {
      const value = await readJson(repositoryRoot, cachePath(repositoryRoot, flags.get("--qualification")!, "qualification"));
      const qualification = value !== null && typeof value === "object" && "receipt" in value ? value.receipt : value;
      const envelope = await prepareMemE0LiveEffect({ repositoryRoot,
        ds0ObservationPath: cachePath(repositoryRoot, flags.get("--ds0-observation")!, "ds0"), qualificationReceipt: qualification });
      await output.writeFile(`${JSON.stringify(envelope)}\n`);
      await output.sync();
      process.stdout.write(`${JSON.stringify({ planSha256: envelope.plan.planSha256, sourceCommit: envelope.plan.qualification.source.commit,
        qualificationStatus: envelope.plan.qualification.result.status, pairs: 4, attempts: 8, providerCalls: 0,
        maximumEstimatedCostUsdMicros: MEM_E0_LIVE_UPPER_BOUND_USD_MICROS, effectClaimAllowed: false })}\n`);
    } else {
      const envelope = memE0EffectPreparedEnvelopeSchema.parse(await readJson(repositoryRoot, cachePath(repositoryRoot, flags.get("--plan")!, "plans")));
      const receipt = await runMemE0LiveEffect({ repositoryRoot, envelope, authorization: {
        authorizeRemote: true, maximumEstimatedCostUsdMicros: MEM_E0_LIVE_UPPER_BOUND_USD_MICROS,
        planSha256Confirmation: flags.get("--confirm-plan-sha256"), scope: "eight_attempt_effect_batch_only",
      } });
      await output.writeFile(`${JSON.stringify(receipt)}\n`);
      await output.sync();
      process.stdout.write(`${JSON.stringify({ receiptSha256: receipt.receiptSha256, decision: receipt.decision,
        effectClaimAllowed: receipt.effectClaimAllowed, providerCalls: receipt.providerCalls,
        accountedPeakCostUsdMicros: receipt.accountedPeakCostUsdMicros, pairs: receipt.pairs })}\n`);
    }
  } catch (error) {
    const failure = { code: "mem_e0_effect_command_failed", effectClaimAllowed: false,
      failureSha256: memE0RawSha256(error instanceof Error ? `${error.name}:${error.message}` : "non_error_throw") };
    await output.writeFile(`${JSON.stringify(failure)}\n`);
    await output.sync();
    throw new Error(failure.failureSha256, { cause: error });
  } finally { await output.close(); }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await runMemE0LiveEffectCli(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ code: "mem_e0_effect_command_failed",
      failureSha256: memE0RawSha256(error instanceof Error ? `${error.name}:${error.message}` : "non_error_throw") })}\n`);
    process.exitCode = 1;
  }
}
