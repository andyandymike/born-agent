import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { runEmR1 } from "./run-em-r1.js";

const receipt = await runEmR1(process.cwd());
const reportPath = resolve(
  process.cwd(),
  "labs/frontier-adapter-lab/fal-em-r1/.cache/evidence/latest-receipt.json",
);
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
const calibration = receipt.calibration as Readonly<{
  readonly diagnosticOperatingPoint: Record<string, unknown>;
  readonly selectedOperatingPoint: Record<string, unknown> | null;
  readonly status: string;
  readonly thresholdBehaviorPointCount: number;
}>;
const fidelity = receipt.fidelityReplay as Readonly<{
  readonly matchedCases: number;
  readonly totalCases: number;
}>;
process.stdout.write(`${JSON.stringify({
  calibrationStatus: calibration.status,
  diagnosticOperatingPoint: calibration.diagnosticOperatingPoint,
  fidelity: `${String(fidelity.matchedCases)}/${String(fidelity.totalCases)}`,
  implementationFidelity: receipt.implementationFidelity,
  promotion: receipt.promotion,
  receiptSha256: receipt.receiptSha256,
  reportPath: "labs/frontier-adapter-lab/fal-em-r1/.cache/evidence/latest-receipt.json",
  selectedOperatingPoint: calibration.selectedOperatingPoint,
  thresholdBehaviorPointCount: calibration.thresholdBehaviorPointCount,
})}\n`);
