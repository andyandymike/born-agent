import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import {
  AgentMemoryEvidenceError,
  captureAgentMemoryInputFingerprint,
  evaluateAgentMemoryEvidence,
  parseAgentMemoryBaselineReport,
  readAgentMemoryEvidenceManifest,
  writeAgentMemoryEvidenceReceipt,
} from "./agent-memory-evidence.js";
import { captureAgentMemoryCheckoutFingerprint } from "./agent-memory-checkout-fingerprint.js";

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
      throw new TypeError("memory:validate expects unique flag/value pairs");
    }
    values.set(key, value);
  }
  if (
    [...values.keys()].some(
      (key) => !["--manifest", "--receipt-dir", "--report"].includes(key),
    )
  ) {
    throw new TypeError(
      "memory:validate accepts only --manifest, --report, and --receipt-dir",
    );
  }
  const manifest =
    values.get("--manifest") ?? "tests/evidence/agent-memory-v1.json";
  const receiptDirectory =
    values.get("--receipt-dir") ??
    ".bornagent/evals/agent-memory/receipts";
  const report = values.get("--report");
  if (report === undefined) {
    throw new TypeError(
      "memory:validate requires --report",
    );
  }
  return Object.freeze({ manifest, receiptDirectory, report });
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
    receiptRelative !== ".bornagent/evals/agent-memory/receipts" &&
    !receiptRelative.startsWith(
      ".bornagent/evals/agent-memory/receipts/",
    )
  ) {
    throw new TypeError(
      "agent memory receipts must be written below .bornagent/evals/agent-memory/receipts",
    );
  }
  const [{ manifest, source }, reportSource] = await Promise.all([
    readAgentMemoryEvidenceManifest(manifestPath),
    readFile(reportPath, "utf8"),
  ]);
  const [fingerprint, checkout] = await Promise.all([
    captureAgentMemoryInputFingerprint(workspaceRoot, manifest),
    captureAgentMemoryCheckoutFingerprint(workspaceRoot),
  ]);
  const receipt = evaluateAgentMemoryEvidence({
    currentCheckoutFingerprintSha256: checkout.fingerprintSha256,
    currentInputFingerprintSha256: fingerprint.fingerprintSha256,
    manifest,
    manifestSource: source,
    report: parseAgentMemoryBaselineReport(reportSource),
  });
  const path = await writeAgentMemoryEvidenceReceipt(
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
  if (error instanceof AgentMemoryEvidenceError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } else if (error instanceof TypeError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
