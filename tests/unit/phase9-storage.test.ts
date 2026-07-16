import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CheckpointStore,
  type CheckpointPrivacyVerifier,
} from "../../src/checkpoints/checkpoint-store.js";
import type { BackendCheckpointCodec } from "../../src/checkpoints/checkpoint-types.js";
import {
  BackendContinuation,
  type BackendIdentity,
} from "../../src/model/model-backend.js";
import { DurableSessionStore } from "../../src/sessions/durable-session-store.js";
import type {
  ProcessIdentityProbe,
  ProcessIdentityProbeResult,
} from "../../src/sessions/process-identity.js";
import {
  assessSessionLockOwner,
  SessionLock,
  type SessionLockRecord,
} from "../../src/sessions/session-lock.js";
import {
  NodeRenameDurabilityPort,
  type RenameDurabilityPort,
} from "../../src/sessions/rename-durability.js";
import {
  SessionPathError,
  SessionPathPolicy,
} from "../../src/sessions/session-path-policy.js";
import {
  recoverSessionTail,
  SessionTailError,
  type StoredLineDecoder,
} from "../../src/sessions/tail-recovery.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000901";
const RUN_ID = "00000000-0000-4000-8000-000000000902";
const CHECKPOINT_ID = "00000000-0000-4000-8000-000000000903";
const LOCK_NONCE_A = "00000000-0000-4000-8000-000000000904";
const LOCK_NONCE_B = "00000000-0000-4000-8000-000000000905";
const TEMP_NONCE = "00000000-0000-4000-8000-000000000906";
const START_IDENTITY = "a".repeat(64);
const HOST_FINGERPRINT = "b".repeat(64);

const temporaryDirectories: string[] = [];

async function temporaryWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "bornagent-phase9-storage-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

const objectDecoder: StoredLineDecoder<Record<string, unknown>> = {
  decode(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("expected object");
    }
    return value as Record<string, unknown>;
  },
};

function fixedProbe(
  result: ProcessIdentityProbeResult,
): ProcessIdentityProbe {
  return { probe: vi.fn(async () => result) };
}

describe("Phase 9 session path and writer lock primitives", () => {
  it("requires canonical lowercase UUIDs and rejects a junction directory", async () => {
    const workspace = await temporaryWorkspace();
    const policy = await SessionPathPolicy.create(workspace);

    await expect(
      policy.prepareSession("00000000-0000-4000-8000-00000000090A"),
    ).rejects.toBeInstanceOf(SessionPathError);

    const linkedTarget = join(workspace, "linked-agent-data");
    await mkdir(linkedTarget);
    await symlink(linkedTarget, join(workspace, ".bornagent"), "junction");
    await expect(policy.prepareSession(SESSION_ID)).rejects.toEqual(
      expect.objectContaining({ code: "path_uses_link" }),
    );
  });

  it("allows only one active writer and releases only its matching nonce", async () => {
    const workspace = await temporaryWorkspace();
    const policy = await SessionPathPolicy.create(workspace);
    const first = await SessionLock.acquire(policy, SESSION_ID, {
      hostFingerprint: HOST_FINGERPRINT,
      nonce: LOCK_NONCE_A,
      processIdentity: { pid: process.pid, startIdentity: START_IDENTITY },
      ownerProbe: fixedProbe("matching"),
    });

    await expect(
      SessionLock.acquire(policy, SESSION_ID, {
        hostFingerprint: HOST_FINGERPRINT,
        nonce: LOCK_NONCE_B,
        processIdentity: { pid: process.pid, startIdentity: START_IDENTITY },
        ownerProbe: fixedProbe("matching"),
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "active_session_lock" }),
    );

    await first.release();
    await expect(readFile(first.paths.lockFilePath)).rejects.toEqual(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it(
    "allows at most one writer across two real Node processes",
    async () => {
      const workspace = await temporaryWorkspace();
      const scriptPath = join(workspace, "lock-contender.mts");
      const policyModule = pathToFileURL(
        join(process.cwd(), "src", "sessions", "session-path-policy.ts"),
      ).href;
      const lockModule = pathToFileURL(
        join(process.cwd(), "src", "sessions", "session-lock.ts"),
      ).href;
      await writeFile(
        scriptPath,
        `import { SessionPathPolicy } from ${JSON.stringify(policyModule)};
import { SessionLock } from ${JSON.stringify(lockModule)};
const [workspace, sessionId] = process.argv.slice(2);
const policy = await SessionPathPolicy.create(workspace);
process.stdout.write("ready\\n");
await new Promise((resolve) => process.stdin.once("data", resolve));
try {
  const lock = await SessionLock.acquire(policy, sessionId);
  process.stdout.write("acquired\\n");
  await new Promise((resolve) => setTimeout(resolve, 400));
  await lock.release();
  process.stdout.write("released\\n");
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : "unknown";
  process.stdout.write("blocked:" + String(code) + "\\n");
  process.exitCode = 3;
}
`,
        "utf8",
      );

      const environment = { ...process.env };
      for (const name of Object.keys(environment)) {
        const canonical = name.toUpperCase();
        if (
          canonical === "OPENAI_API_KEY" ||
          canonical === "ANTHROPIC_API_KEY"
        ) {
          delete environment[name];
        }
      }
      const startWorker = () => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", scriptPath, workspace, SESSION_ID],
          {
            cwd: process.cwd(),
            env: environment,
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        let stderr = "";
        let stdout = "";
        let ready = false;
        let resolveReady: (() => void) | undefined;
        let rejectReady: ((error: Error) => void) | undefined;
        const readyPromise = new Promise<void>((resolve, reject) => {
          resolveReady = resolve;
          rejectReady = reject;
        });
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          if (!ready && stdout.includes("ready\n")) {
            ready = true;
            resolveReady?.();
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        const done = new Promise<{
          readonly code: number | null;
          readonly stderr: string;
          readonly stdout: string;
        }>((resolve) => {
          child.once("exit", (code) => {
            if (!ready) {
              rejectReady?.(
                new Error(`lock contender exited before ready: ${stderr}`),
              );
            }
            resolve({ code, stderr, stdout });
          });
        });
        return { child, done, ready: readyPromise };
      };

      const workers = [startWorker(), startWorker()];
      await Promise.all(workers.map((worker) => worker.ready));
      for (const worker of workers) worker.child.stdin.end("start\n");
      const results = await Promise.all(workers.map((worker) => worker.done));

      expect(
        results.map(({ code }) => code).sort(),
        results.map(({ stderr, stdout }) => `${stdout}\n${stderr}`).join("\n"),
      ).toEqual([0, 3]);
      expect(
        results.filter(({ stdout }) => stdout.includes("acquired\n")),
      ).toHaveLength(1);
      expect(
        results.filter(({ stdout }) => stdout.includes("blocked:")),
      ).toHaveLength(1);
    },
    10_000,
  );

  it("recovers only an aged same-host lock whose process identity is gone", async () => {
    const workspace = await temporaryWorkspace();
    const policy = await SessionPathPolicy.create(workspace);
    await SessionLock.acquire(policy, SESSION_ID, {
      hostFingerprint: HOST_FINGERPRINT,
      nonce: LOCK_NONCE_A,
      now: () => new Date("2026-07-17T00:00:00.000Z"),
      processIdentity: { pid: 91_001, startIdentity: START_IDENTITY },
      ownerProbe: fixedProbe("matching"),
    });

    const recovered = await SessionLock.acquire(policy, SESSION_ID, {
      hostFingerprint: HOST_FINGERPRINT,
      minimumStaleAgeMs: 30_000,
      nonce: LOCK_NONCE_B,
      now: () => new Date("2026-07-17T00:01:00.000Z"),
      processIdentity: { pid: 91_002, startIdentity: "c".repeat(64) },
      ownerProbe: fixedProbe("missing"),
    });

    expect(recovered.recovery).toMatchObject({ previousNonce: LOCK_NONCE_A });
    expect(recovered.recovery?.staleFileName).toContain(
      `.stale.${Date.parse("2026-07-17T00:01:00.000Z")}.${LOCK_NONCE_A}`,
    );
    expect(
      await readFile(
        join(recovered.paths.sessionDirectory, recovered.recovery!.staleFileName),
        "utf8",
      ),
    ).toContain(LOCK_NONCE_A);
    await recovered.release();
  });

  it("does not infer staleness from age or a foreign host", async () => {
    const record: SessionLockRecord = {
      createdAt: "2026-07-16T00:00:00.000Z",
      hostFingerprint: HOST_FINGERPRINT,
      nonce: LOCK_NONCE_A,
      pid: 99,
      processStartIdentity: START_IDENTITY,
      sessionId: SESSION_ID,
    };
    await expect(
      assessSessionLockOwner(record, {
        currentHostFingerprint: "d".repeat(64),
        minimumStaleAgeMs: 1,
        now: new Date("2026-07-17T00:00:00.000Z"),
        ownerProbe: fixedProbe("missing"),
      }),
    ).resolves.toEqual({
      disposition: "unknown",
      processResult: "not_probed",
    });
  });
});

describe("Phase 9 JSONL tail recovery and durable append", () => {
  it("uses the testable Windows installed-handle durability capability", async () => {
    const workspace = await temporaryWorkspace();
    const tempPath = join(workspace, "rename-source.tmp");
    const targetPath = join(workspace, "rename-target.bin");
    const bytes = Buffer.from("durable-rename-proof", "utf8");
    await writeFile(tempPath, bytes);
    const durability = new NodeRenameDurabilityPort("win32");

    expect(durability.capability).toBe("windows_installed_file_sync");
    await durability.install(tempPath, targetPath, bytes);
    expect(await readFile(targetPath)).toEqual(bytes);
    await expect(readFile(tempPath)).rejects.toEqual(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("backs up bytes before adding the sole missing final newline", async () => {
    const workspace = await temporaryWorkspace();
    const policy = await SessionPathPolicy.create(workspace);
    const lock = await SessionLock.acquire(policy, SESSION_ID, {
      nonce: LOCK_NONCE_A,
    });
    const original = Buffer.from('{"seq":1,"text":"中文"}', "utf8");
    await writeFile(lock.paths.sessionFilePath, original);

    const result = await recoverSessionTail({
      decoder: objectDecoder,
      lock,
      now: () => new Date("2026-07-17T00:00:00.000Z"),
      policy,
      recoveryNonce: TEMP_NONCE,
    });

    expect(result).toMatchObject({
      kind: "newline_added",
      lineCount: 1,
      removedBytes: 0,
    });
    expect(await readFile(lock.paths.sessionFilePath)).toEqual(
      Buffer.concat([original, Buffer.from("\n")]),
    );
    expect(
      await readFile(join(lock.paths.sessionDirectory, result.backupFileName!)),
    ).toEqual(original);
    await lock.release();
  });

  it("removes one malformed unterminated tail and preserves a byte-for-byte backup", async () => {
    const workspace = await temporaryWorkspace();
    const policy = await SessionPathPolicy.create(workspace);
    const lock = await SessionLock.acquire(policy, SESSION_ID, {
      nonce: LOCK_NONCE_A,
    });
    const prefix = Buffer.from('{"seq":1}\n', "utf8");
    const original = Buffer.concat([prefix, Buffer.from('{"seq":', "utf8")]);
    await writeFile(lock.paths.sessionFilePath, original);

    const result = await recoverSessionTail({
      decoder: objectDecoder,
      lock,
      policy,
      recoveryNonce: TEMP_NONCE,
    });

    expect(result).toMatchObject({
      kind: "tail_removed",
      lineCount: 1,
      removedBytes: Buffer.byteLength('{"seq":'),
    });
    expect(await readFile(lock.paths.sessionFilePath)).toEqual(prefix);
    expect(
      await readFile(join(lock.paths.sessionDirectory, result.backupFileName!)),
    ).toEqual(original);
    await lock.release();
  });

  it("keeps the original tail when the platform durability proof is unavailable", async () => {
    const workspace = await temporaryWorkspace();
    const policy = await SessionPathPolicy.create(workspace);
    const lock = await SessionLock.acquire(policy, SESSION_ID, {
      nonce: LOCK_NONCE_A,
    });
    const original = Buffer.from('{"seq":1}\n{"seq":', "utf8");
    await writeFile(lock.paths.sessionFilePath, original);
    const unavailable: RenameDurabilityPort = {
      capability: "windows_installed_file_sync",
      async install() {
        throw new Error("durability proof unavailable");
      },
    };

    await expect(
      recoverSessionTail({
        decoder: objectDecoder,
        lock,
        policy,
        recoveryNonce: TEMP_NONCE,
        renameDurability: unavailable,
      }),
    ).rejects.toThrow("durability proof unavailable");
    expect(await readFile(lock.paths.sessionFilePath)).toEqual(original);
    await lock.release();
  });

  it("rejects interior corruption and a complete-but-unknown final event without rewriting", async () => {
    const workspace = await temporaryWorkspace();
    const policy = await SessionPathPolicy.create(workspace);
    const lock = await SessionLock.acquire(policy, SESSION_ID, {
      nonce: LOCK_NONCE_A,
    });
    const interior = Buffer.from('{"seq":\n{"seq":2}\n', "utf8");
    await writeFile(lock.paths.sessionFilePath, interior);
    await expect(
      recoverSessionTail({ decoder: objectDecoder, lock, policy }),
    ).rejects.toBeInstanceOf(SessionTailError);
    expect(await readFile(lock.paths.sessionFilePath)).toEqual(interior);

    const completeUnknown = Buffer.from('{"schema_version":99}', "utf8");
    await writeFile(lock.paths.sessionFilePath, completeUnknown);
    await expect(
      recoverSessionTail({
        decoder: {
          decode() {
            throw new Error("unknown schema");
          },
        },
        lock,
        policy,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "stored_event_rejected" }),
    );
    expect(await readFile(lock.paths.sessionFilePath)).toEqual(completeUnknown);
    await lock.release();
  });

  it("appends one complete line and exposes it only after the durable call returns", async () => {
    const workspace = await temporaryWorkspace();
    const store = await DurableSessionStore.open({
      decoder: objectDecoder,
      sessionId: SESSION_ID,
      workspace,
    });

    expect(store.lockRecovery).toBeUndefined();
    await expect(
      store.withOwnedLock(async (lock) => lock.record.sessionId),
    ).resolves.toBe(SESSION_ID);

    await expect(store.appendEncodedLine('{"seq":1}')).resolves.toEqual({
      bytes: Buffer.byteLength('{"seq":1}\n'),
      lineNumber: 1,
    });
    expect(await readFile(store.path, "utf8")).toBe('{"seq":1}\n');
    await expect(store.appendEncodedLine("{}\n{}")).rejects.toEqual(
      expect.objectContaining({ code: "encoded_line_invalid" }),
    );
    await store.close();
  });
});

class TestContinuation extends BackendContinuation {
  constructor(readonly value: string) {
    super();
  }
}

const IDENTITY: BackendIdentity = {
  adapter: "fake-pi",
  adapterVersion: "1",
  configFingerprint: "e".repeat(64),
  model: "fake-model",
  provider: "ollama",
};

const CODEC: BackendCheckpointCodec = {
  codecVersion: "fake-v1",
  async decode(bytes, identity) {
    if (identity !== IDENTITY) {
      throw new Error("unexpected identity object");
    }
    return new TestContinuation(Buffer.from(bytes).toString("utf8"));
  },
  async encode(continuation) {
    if (!(continuation instanceof TestContinuation)) {
      throw new TypeError("unexpected continuation");
    }
    return Buffer.from(continuation.value, "utf8");
  },
  provider: "ollama",
};

const verifiedPrivacy: CheckpointPrivacyVerifier = {
  async preflight() {
    return { status: "verified" };
  },
  async verifyFile() {
    return { status: "verified" };
  },
};

describe("Phase 9 exact checkpoint storage", () => {
  it("writes temp-sync-rename, returns only a relative hash reference, and decodes after verification", async () => {
    const workspace = await temporaryWorkspace();
    const policy = await SessionPathPolicy.create(workspace);
    const lock = await SessionLock.acquire(policy, SESSION_ID, {
      nonce: LOCK_NONCE_A,
    });
    const store = await CheckpointStore.create(workspace, {
      policy,
      privacyVerifier: verifiedPrivacy,
      randomId: () => TEMP_NONCE,
    });
    const continuation = new TestContinuation("opaque-local-state");
    const reference = await store.writeExact(
      {
        codec: CODEC,
        context: {
          checkpointId: CHECKPOINT_ID,
          runId: RUN_ID,
          sessionId: SESSION_ID,
          turnNumber: 2,
        },
        continuation,
        identity: IDENTITY,
      },
      lock,
    );

    expect(reference).toMatchObject({
      bytes: Buffer.byteLength("opaque-local-state"),
      relativeRef: `.bornagent/checkpoints/${SESSION_ID}/${CHECKPOINT_ID}.bin`,
      sha256: createHash("sha256")
        .update("opaque-local-state")
        .digest("hex"),
    });
    expect(JSON.stringify(reference)).not.toContain("opaque-local-state");
    await expect(
      store.readExact({ codec: CODEC, identity: IDENTITY, reference }),
    ).resolves.toMatchObject({ value: "opaque-local-state" });
    await lock.release();
  });

  it("blocks exact storage when private file semantics are unverified", async () => {
    const workspace = await temporaryWorkspace();
    const policy = await SessionPathPolicy.create(workspace);
    const lock = await SessionLock.acquire(policy, SESSION_ID, {
      nonce: LOCK_NONCE_A,
    });
    const encode = vi.fn(CODEC.encode);
    const store = await CheckpointStore.create(workspace, {
      policy,
      privacyVerifier: {
        async preflight() {
          return { reason: "acl_unknown", status: "unverified" };
        },
        async verifyFile() {
          return { reason: "acl_unknown", status: "unverified" };
        },
      },
    });

    await expect(
      store.writeExact(
        {
          codec: { ...CODEC, encode },
          context: {
            checkpointId: CHECKPOINT_ID,
            runId: RUN_ID,
            sessionId: SESSION_ID,
            turnNumber: 1,
          },
          continuation: new TestContinuation("never-encoded"),
          identity: IDENTITY,
        },
        lock,
      ),
    ).rejects.toEqual(
      expect.objectContaining({ code: "checkpoint_private_mode_unverified" }),
    );
    expect(encode).not.toHaveBeenCalled();
    await lock.release();
  });

  it("rejects a corrupted checkpoint instead of silently degrading", async () => {
    const workspace = await temporaryWorkspace();
    const policy = await SessionPathPolicy.create(workspace);
    const lock = await SessionLock.acquire(policy, SESSION_ID, {
      nonce: LOCK_NONCE_A,
    });
    const store = await CheckpointStore.create(workspace, {
      policy,
      privacyVerifier: verifiedPrivacy,
      randomId: () => TEMP_NONCE,
    });
    const reference = await store.writeExact(
      {
        codec: CODEC,
        context: {
          checkpointId: CHECKPOINT_ID,
          runId: RUN_ID,
          sessionId: SESSION_ID,
          turnNumber: 1,
        },
        continuation: new TestContinuation("original"),
        identity: IDENTITY,
      },
      lock,
    );
    await writeFile(
      join(
        workspace,
        ".bornagent",
        "checkpoints",
        SESSION_ID,
        `${CHECKPOINT_ID}.bin`,
      ),
      "tampered",
      "utf8",
    );

    await expect(
      store.readExact({ codec: CODEC, identity: IDENTITY, reference }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "checkpoint_hash_mismatch" }),
    );
    await lock.release();
  });
});
