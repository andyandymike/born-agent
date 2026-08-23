import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { captureAgentMemoryCheckoutFingerprint } from "./agent-memory-checkout-fingerprint.js";
import {
  captureAgentMemoryInputFingerprint,
  parseAgentMemoryEvidenceManifest,
} from "./agent-memory-evidence.js";
import {
  AgentMemoryWorkingStateEvidenceError,
  evaluateAgentMemoryWorkingStateEvidence,
  parseAgentMemoryWorkingStateReport,
  readAgentMemoryWorkingStateManifest,
  writeAgentMemoryWorkingStateReceipt,
} from "./agent-memory-working-state-evidence.js";

interface Arguments {
  readonly manifest: string;
  readonly receiptDirectory: string;
  readonly report: string;
}

function containedPath(
  workspaceRoot: string,
  supplied: string,
  label: string,
): string {
  const absolute = resolve(workspaceRoot, supplied);
  const difference = relative(workspaceRoot, absolute);
  if (
    difference === "" ||
    difference === ".." ||
    difference.startsWith(`..${sep}`)
  ) {
    throw new TypeError(`${label} must remain inside the repository`);
  }
  return absolute;
}

function argumentsFrom(argv: readonly string[]): Arguments {
  if (argv[0] === "--") return argumentsFrom(argv.slice(1));
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      !key.startsWith("--") ||
      values.has(key)
    ) {
      throw new TypeError(
        "memory:working:validate expects unique flag/value pairs",
      );
    }
    values.set(key, value);
  }
  if ([...values.keys()].some(
    (key) => !["--manifest", "--receipt-dir", "--report"].includes(key),
  )) {
    throw new TypeError(
      "memory:working:validate accepts only --manifest, --receipt-dir, and --report",
    );
  }
  const report = values.get("--report");
  if (report === undefined) {
    throw new TypeError("memory:working:validate requires --report");
  }
  return Object.freeze({
    manifest: values.get("--manifest") ??
      "tests/evidence/agent-memory-working-state-v1.json",
    receiptDirectory: values.get("--receipt-dir") ??
      ".bornagent/evals/agent-memory/working/receipts",
    report,
  });
}

async function main(): Promise<number> {
  const workspaceRoot = resolve(import.meta.dirname, "../../..");
  const args = argumentsFrom(process.argv.slice(2));
  const manifestPath = containedPath(workspaceRoot, args.manifest, "manifest");
  const reportPath = containedPath(workspaceRoot, args.report, "report");
  const receiptDirectory = containedPath(
    workspaceRoot,
    args.receiptDirectory,
    "receipt directory",
  );
  const receiptRelative = relative(workspaceRoot, receiptDirectory)
    .split(sep)
    .join("/");
  if (
    receiptRelative !== ".bornagent/evals/agent-memory/working/receipts" &&
    !receiptRelative.startsWith(
      ".bornagent/evals/agent-memory/working/receipts/",
    )
  ) {
    throw new TypeError(
      "working-state receipts must stay below the AM1 evidence root",
    );
  }
  const [working, reportSource] = await Promise.all([
    readAgentMemoryWorkingStateManifest(manifestPath),
    readFile(reportPath, "utf8"),
  ]);
  const baselinePath = containedPath(
    workspaceRoot,
    working.manifest.baselineManifest,
    "baseline manifest",
  );
  const baselineSource = await readFile(baselinePath, "utf8");
  const baselineManifest = parseAgentMemoryEvidenceManifest(baselineSource);
  const [inputs, checkout] = await Promise.all([
    captureAgentMemoryInputFingerprint(workspaceRoot, working.manifest),
    captureAgentMemoryCheckoutFingerprint(workspaceRoot),
  ]);
  const receipt = evaluateAgentMemoryWorkingStateEvidence({
    baselineManifest,
    baselineManifestSource: baselineSource,
    currentCheckoutFingerprintSha256: checkout.fingerprintSha256,
    currentInputFingerprintSha256: inputs.fingerprintSha256,
    manifest: working.manifest,
    manifestSource: working.source,
    report: parseAgentMemoryWorkingStateReport(reportSource),
  });
  const path = await writeAgentMemoryWorkingStateReceipt(
    receiptDirectory,
    receipt,
  );
  process.stdout.write(`${JSON.stringify({
    path,
    receiptSha256: receipt.receiptSha256,
    status: receipt.status,
  })}\n`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof AgentMemoryWorkingStateEvidenceError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } else if (error instanceof TypeError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
