import { ControlOperationJournal } from "../../src/control-plane/control-operation-journal.ts";
import { loadOrCreateHostControlAuthority } from "../../src/control-plane/host-control-identity.ts";

function operationSnapshot(operation) {
  return {
    domainRecordRefs: operation.domainRecordRefs,
    errorCode: operation.errorCode,
    operationId: operation.operationId,
    operationRevision: operation.operationRevision,
    ownerClaim: operation.ownerClaim,
    preparedActionId: operation.preparedActionId,
    primaryDomainRecord: operation.primaryDomainRecord,
    recordSha256: operation.recordSha256,
    state: operation.state,
    underlyingOperationRefs: operation.underlyingOperationRefs,
  };
}

function driverSnapshot(result) {
  if (result.kind === "acquired") {
    return {
      claim: result.claim,
      kind: result.kind,
      operation: operationSnapshot(result.operation),
      takeover: result.takeover,
    };
  }
  return {
    kind: result.kind,
    operation: operationSnapshot(result.operation),
  };
}

function writeResult(value) {
  process.stdout.write(`${JSON.stringify({ pid: process.pid, ...value })}\n`);
}

const [root, leaseText, command, encodedPayload] = process.argv.slice(2);

try {
  if (root === undefined || leaseText === undefined || command === undefined || encodedPayload === undefined) {
    throw new TypeError("usage: phase21a-control-worker <root> <lease-ms> <command> <payload>");
  }
  const driverLeaseMs = Number.parseInt(leaseText, 10);
  if (!Number.isSafeInteger(driverLeaseMs)) throw new TypeError("driver lease must be an integer");
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  const authority = await loadOrCreateHostControlAuthority({ root });
  const journal = new ControlOperationJournal(authority.paths, { driverLeaseMs });

  if (command === "accept") {
    const acceptance = await journal.accept(payload.acceptInput);
    writeResult({
      acceptance: {
        created: acceptance.created,
        operation: operationSnapshot(acceptance.operation),
      },
      command,
    });
  } else if (command === "accept-and-acquire") {
    const acceptance = await journal.accept(payload.acceptInput);
    const driver = await journal.acquireDriver(acceptance.operation.operationId);
    writeResult({
      acceptance: {
        created: acceptance.created,
        operation: operationSnapshot(acceptance.operation),
      },
      command,
      driver: driverSnapshot(driver),
    });
  } else if (command === "acquire") {
    const driver = await journal.acquireDriver(payload.operationId);
    writeResult({ command, driver: driverSnapshot(driver) });
  } else if (command === "claim-and-hold") {
    const driver = await journal.acquireDriver(payload.operationId);
    if (driver.kind !== "acquired") {
      writeResult({ command, driver: driverSnapshot(driver) });
    } else {
      let operation = driver.operation;
      for (const state of payload.transitions ?? []) {
        operation = await journal.updateClaimed({ claim: driver.claim, patch: { state } });
      }
      writeResult({
        command,
        driver: driverSnapshot({ ...driver, operation }),
      });
      setInterval(() => undefined, 1_000);
      await new Promise(() => undefined);
    }
  } else {
    throw new TypeError(`unknown worker command: ${command}`);
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    code: typeof error === "object" && error !== null && "code" in error ? error.code : null,
    message: error instanceof Error ? error.message : "unknown worker error",
    name: error instanceof Error ? error.name : "Error",
    pid: process.pid,
  })}\n`);
  process.exitCode = 1;
}
