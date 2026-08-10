import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

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
const envelope = JSON.parse(readFileSync(envelopePath, "utf8"));
const actor = envelope.prepared.actor;
const descriptorSha256 = envelope.execution.executableDescriptorSha256;
const nonceProofSha256 = createHash("sha256").update(canonical({
  nonce,
  operation_id: operationId,
  attempt_id: actor.attemptId,
  envelope_sha256: envelope.envelopeSha256,
})).digest("hex");

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
  processStartIdentity: `phase20-loss-fixture:${String(process.pid)}`,
  nonceProofSha256,
}), 20);

const fallback = setTimeout(() => process.exit(92), 2_000);
fallback.unref();
process.on("message", (frame) => {
  if (
    frame?.frame === "start" &&
    frame.operationId === operationId &&
    frame.childAttemptId === actor.attemptId
  ) {
    process.exit(73);
  }
});
