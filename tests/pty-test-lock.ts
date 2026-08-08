import { open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const LOCK_PATH = join(tmpdir(), "bornagent-real-pty-tests-v1.lock");

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export async function withRealPtyTestLock<T>(run: () => Promise<T>): Promise<T> {
  const nonce = randomUUID();
  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      const handle = await open(LOCK_PATH, "wx");
      await handle.writeFile(JSON.stringify({ createdAt: Date.now(), nonce, pid: process.pid }));
      await handle.close();
      break;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(await readFile(LOCK_PATH, "utf8")) as {
          readonly createdAt?: unknown;
          readonly pid?: unknown;
        };
        if (
          typeof owner.pid !== "number" ||
          typeof owner.createdAt !== "number" ||
          !processAlive(owner.pid) ||
          Date.now() - owner.createdAt > 120_000
        ) {
          await rm(LOCK_PATH, { force: true });
          continue;
        }
      } catch {
        await rm(LOCK_PATH, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for the real PTY test lock", { cause: error });
      }
      await delay(50);
    }
  }
  try {
    return await run();
  } finally {
    try {
      const owner = JSON.parse(await readFile(LOCK_PATH, "utf8")) as { readonly nonce?: unknown };
      if (owner.nonce === nonce) await rm(LOCK_PATH, { force: true });
    } catch {
      // The exact lock is already absent or no longer belongs to this test.
    }
  }
}
