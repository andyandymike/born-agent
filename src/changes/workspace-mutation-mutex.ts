import { patchOperationError, throwIfPatchAborted } from "./patch-types.js";

const workspaceTails = new Map<string, Promise<void>>();

async function waitForTurn(
  predecessor: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  throwIfPatchAborted(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(
        patchOperationError(
          "cancelled",
          "patch_cancelled",
          "patch operation was cancelled while waiting for the workspace lock",
        ),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([predecessor, aborted]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export async function withWorkspaceMutationLock<T>(
  workspaceKey: string,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  // PHASE5: 进程内锁只序列化 BornAgent 自己的 mutation；外部编辑器不受它约束，
  // 所以拿到锁之后仍必须执行 preimage recheck。
  const predecessor = workspaceTails.get(workspaceKey) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = predecessor.then(() => held);
  workspaceTails.set(workspaceKey, tail);
  void tail.then(() => {
    if (workspaceTails.get(workspaceKey) === tail) {
      workspaceTails.delete(workspaceKey);
    }
  });

  try {
    await waitForTurn(predecessor, signal);
    throwIfPatchAborted(signal);
    return await operation();
  } finally {
    release?.();
  }
}
