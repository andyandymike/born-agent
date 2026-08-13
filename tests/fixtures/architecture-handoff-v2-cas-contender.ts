import { lstat, writeFile } from "node:fs/promises";

import { BackgroundOperationStore } from "../../src/background/background-operation-store.js";
import { backgroundHandoffTransitionId } from "../../src/background/background-schema.js";

function required(index: number, label: string): string {
  const value = process.argv[index];
  if (value === undefined || value.length === 0) throw new Error(`missing ${label}`);
  return value;
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (await lstat(path).then(() => true).catch(() => false)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("handoff V2 contender start gate timed out");
}

const root = required(2, "root");
const repositoryId = required(3, "repository id");
const operationId = required(4, "operation id");
const workerId = required(5, "worker id");
const variant = required(6, "variant");
const gatePath = required(7, "gate path");
const readyPath = required(8, "ready path");
if (variant !== "a" && variant !== "b") throw new Error("variant must be a or b");

await writeFile(readyPath, "ready\n", { encoding: "utf8", flag: "wx" });
await waitForFile(gatePath);

const store = await BackgroundOperationStore.openExisting({ operationId, repositoryId, root });
try {
  await store.compareAndSwapHandoff({
    expectedOwner: "parent",
    expectedState: "launching",
    next: {
      graphSha256: "b".repeat(64),
      operationId,
      owner: "worker",
      ownerPid: variant === "a" ? 7_001 : 7_002,
      ownerProcessStartIdentity: `contender-${variant}`,
      parentNonceSha256: "c".repeat(64),
      schemaVersion: 1,
      state: "worker_owned",
      updatedAt: variant === "a" ? "2026-08-13T00:00:01.000Z" : "2026-08-13T00:00:02.000Z",
      workerId,
      workerNonceSha256: "d".repeat(64),
    },
    nonce: `unused-v2-${variant}`,
    transitionId: backgroundHandoffTransitionId({ operationId, transition: "worker_claim", workerId }),
  });
  process.stdout.write(`${JSON.stringify({ status: "passed", variant })}\n`);
} catch (error) {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
  process.stdout.write(`${JSON.stringify({ code, status: "rejected", variant })}\n`);
  process.exitCode = code === "worker_handoff_conflict" ? 8 : 1;
}
