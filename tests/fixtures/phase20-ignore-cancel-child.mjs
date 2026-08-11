import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || process.argv[index + 1] === undefined) process.exit(94);
  return process.argv[index + 1];
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

if (typeof process.send !== "function") process.exit(93);
const operationId = argument("--operation");
const envelopePath = argument("--envelope");
const nonce = argument("--nonce");
const stateRoot = process.env.BORN_DELEGATION_CHILD_STATE_ROOT;
if (stateRoot === undefined) process.exit(92);
const envelope = JSON.parse(readFileSync(envelopePath, "utf8"));
const actor = envelope.prepared.actor;
const descriptorSha256 = envelope.execution.executableDescriptorSha256;
const nonceProofSha256 = createHash("sha256").update(canonical({
  nonce,
  operation_id: operationId,
  attempt_id: actor.attemptId,
  envelope_sha256: envelope.envelopeSha256,
})).digest("hex");

// The grandchild stays in this child's process group. Host cleanup must target
// the whole tree; both processes retain a fallback so a failed test cannot leak.
const grandchild = spawn(process.execPath, [
  "-e",
  "setTimeout(()=>process.exit(89),8000); setInterval(()=>undefined,1000);",
], { detached: false, stdio: "ignore", windowsHide: true });
const evidenceDirectory = join(stateRoot, "delegations", "operations", "v1", operationId);
mkdirSync(evidenceDirectory, { recursive: true });
const evidencePath = join(evidenceDirectory, "ignored-cancel-tree.json");
let startObserved = false;
let cancelObserved = false;
const writeEvidence = () => writeFileSync(evidencePath, JSON.stringify({
  cancelObserved,
  childPid: process.pid,
  grandchildPid: grandchild.pid,
  startObserved,
}));
writeEvidence();

setTimeout(() => process.send({
  schemaVersion: 1,
  protocolVersion: 1,
  frame: "handshake",
  operationId,
  childActorId: actor.actorId,
  childAttemptId: actor.attemptId,
  envelopeSha256: envelope.envelopeSha256,
  executableDescriptorSha256: descriptorSha256,
  pid: process.pid,
  processStartIdentity: `phase20-ignore-cancel:${String(process.pid)}`,
  nonceProofSha256,
}), 20);

// Intentionally acknowledge neither start nor cancel with a terminal frame.
// The Host must enforce its own bounded cancellation grace and process-tree
// cleanup rather than trusting child cooperation.
process.on("message", (frame) => {
  if (frame?.frame === "start") startObserved = true;
  if (frame?.frame === "cancel") cancelObserved = true;
  writeEvidence();
});
process.on("disconnect", () => undefined);
setTimeout(() => process.exit(91), 8_000);
setInterval(() => undefined, 1_000);
