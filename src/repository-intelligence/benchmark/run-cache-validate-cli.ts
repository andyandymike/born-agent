import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import {
  evaluateRepositoryCacheEvidence,
  parseRepositoryCacheBenchmarkReport,
  readRepositoryCacheEvidenceManifest,
  RepositoryCacheEvidenceError,
  writeRepositoryCacheEvidenceReceiptNoReplace,
} from "./repository-cache-evidence.js";
import { captureRepositoryCacheCheckoutFingerprint } from "./repository-cache-checkout-fingerprint.js";

interface Arguments {
  readonly evidenceId: string;
  readonly manifest: string;
  readonly receiptDirectory: string;
  readonly report: string;
}

function containedPath(workspaceRoot: string, supplied: string, label: string): string {
  const absolute = resolve(workspaceRoot, supplied);
  const difference = relative(workspaceRoot, absolute);
  if (difference === "" || difference === ".." || difference.startsWith(`..${sep}`)) {
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
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new TypeError("repository:cache:validate expects flag/value pairs");
    }
    if (values.has(key)) throw new TypeError(`duplicate repository cache validator option ${key}`);
    values.set(key, value);
  }
  const evidenceId = values.get("--evidence-id");
  const manifest = values.get("--manifest");
  const receiptDirectory = values.get("--receipt-dir");
  const report = values.get("--report");
  const allowed = new Set(["--evidence-id", "--manifest", "--receipt-dir", "--report"]);
  const unknown = [...values.keys()].filter((key) => !allowed.has(key));
  if (evidenceId === undefined || manifest === undefined || receiptDirectory === undefined || report === undefined || unknown.length > 0) {
    throw new TypeError("repository:cache:validate requires --evidence-id, --manifest, --report, and --receipt-dir");
  }
  return Object.freeze({ evidenceId, manifest, receiptDirectory, report });
}

async function main(): Promise<number> {
  const workspaceRoot = resolve(import.meta.dirname, "../../..");
  const args = argumentsFrom(process.argv.slice(2));
  const manifestPath = containedPath(workspaceRoot, args.manifest, "manifest");
  const reportPath = containedPath(workspaceRoot, args.report, "report");
  const receiptDirectory = containedPath(workspaceRoot, args.receiptDirectory, "receipt directory");
  const receiptRelative = relative(workspaceRoot, receiptDirectory).split(sep).join("/");
  if (!receiptRelative.startsWith(".bornagent/evals/repository-cache/receipts")) {
    throw new TypeError("repository cache receipts must be written below .bornagent/evals/repository-cache/receipts");
  }
  const [{ manifest, source: manifestSource }, reportSource, checkout] = await Promise.all([
    readRepositoryCacheEvidenceManifest(manifestPath),
    readFile(reportPath, "utf8"),
    captureRepositoryCacheCheckoutFingerprint(workspaceRoot),
  ]);
  const report = parseRepositoryCacheBenchmarkReport(reportSource);
  const receipt = evaluateRepositoryCacheEvidence({
    context: {
      checkoutFingerprintSha256: checkout.fingerprintSha256,
      nodeVersion: process.version,
      platform: process.platform as "linux" | "win32",
    },
    evidenceId: args.evidenceId,
    manifest,
    manifestSource,
    report,
  });
  const stored = await writeRepositoryCacheEvidenceReceiptNoReplace(receiptDirectory, receipt);
  process.stdout.write(`${JSON.stringify({ path: stored.path, receiptSha256: stored.receipt.receiptSha256, status: stored.receipt.status })}\n`);
  return stored.receipt.status === "pass" ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof RepositoryCacheEvidenceError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } else if (error instanceof TypeError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
