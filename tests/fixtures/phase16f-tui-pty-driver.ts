import { Buffer } from "node:buffer";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { spawn } from "node-pty";

const workspace = process.argv[2];
const appEntry = process.argv[3];
if (workspace === undefined || appEntry === undefined) {
  throw new Error("PTY driver requires workspace and app paths");
}
const workspacePath = workspace;
const appEntryPath = appEntry;
const repositoryLifecycle = process.argv[4] === "repository";
const capabilityLifecycle = process.argv[4] === "capability";
const delegationCodingCancelLifecycle = process.argv[4] === "delegation-coding-cancel";
const delegationCodingExitCancelLifecycle = process.argv[4] === "delegation-coding-exit-cancel";
const delegationCodingLifecycle = process.argv[4] === "delegation-coding";
const delegationCodingAnyLifecycle = delegationCodingLifecycle || delegationCodingCancelLifecycle || delegationCodingExitCancelLifecycle;
const delegationLifecycle = process.argv[4] === "delegation";
const graphLifecycle = process.argv[4] === "graph";
const hookApprovalLifecycle = process.argv[4] === "hook-approval";
const controlStateRoot = join(workspacePath, ".bornagent", "pty-user-state", "application-control");

const MAX_OUTPUT_BYTES = 2_000_000;

interface PtyExit {
  readonly exitCode: number;
  readonly signal?: number;
}

function canonicalPtySignal(signal: number | undefined): number | null {
  // node-pty reports a clean POSIX shell exit as signal 0 while Windows
  // ConPTY omits it. Closure evidence uses one domain-level no-signal value.
  return signal === undefined || signal === 0 ? null : signal;
}

function childEnvironment(): Record<string, string> {
  const allowed = [
    "APPDATA",
    "COLORTERM",
    "ComSpec",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "PATH",
    "PATHEXT",
    "SHELL",
    "SystemRoot",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "WINDIR",
  ];
  const result: Record<string, string> = {
    COLORTERM: "truecolor",
    TERM: "xterm-256color",
  };
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  // Every real PTY child owns an isolated Host authority. Inheriting the
  // developer machine's application state makes old operation revisions and
  // concurrent test processes part of the fixture, which is neither a valid
  // product proof nor safe test isolation.
  // Keep the authority under the product's ignored repository metadata root so
  // its own prepared-action and operation journals cannot invalidate Phase 17
  // source intelligence while remaining fixture-local and inspectable.
  result.BORN_CONTROL_STATE_ROOT = controlStateRoot;
  return result;
}

function visibleText(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\r") continue;
    if (character !== "\u001b") {
      result += character;
      continue;
    }
    const introducer = value[index + 1];
    if (introducer === "[") {
      let cursor = index + 2;
      while (cursor < value.length) {
        const code = value.charCodeAt(cursor);
        if (code >= 0x40 && code <= 0x7e) break;
        cursor += 1;
      }
      index = cursor;
      continue;
    }
    if (introducer === "]" || introducer === "P") {
      let cursor = index + 2;
      while (cursor < value.length) {
        if (value[cursor] === "\u0007") break;
        if (value[cursor] === "\u001b" && value[cursor + 1] === "\\") {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      index = cursor;
      continue;
    }
    index += 1;
  }
  return result;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function hostOperationCount(
  actionKind: string,
  state?: string,
): Promise<number> {
  const operationRoot = join(controlStateRoot, "control-plane", "v1", "operations");
  let operationIds: string[];
  try {
    operationIds = await readdir(operationRoot);
  } catch {
    return 0;
  }
  let count = 0;
  for (const operationId of operationIds) {
    if (operationId === "indexes") continue;
    let revisions: string[];
    try {
      revisions = (await readdir(join(operationRoot, operationId)))
        .filter((name) => /^\d{12}\.json$/u.test(name))
        .sort();
    } catch {
      continue;
    }
    const latest = revisions.at(-1);
    if (latest === undefined) continue;
    try {
      const record = JSON.parse(await readFile(join(operationRoot, operationId, latest), "utf8")) as {
        readonly actionKind?: unknown;
        readonly state?: unknown;
      };
      if (record.actionKind === actionKind && (state === undefined || record.state === state)) count += 1;
    } catch {
      // A writer may replace the latest revision between directory listing and
      // read. The next bounded observation retries from the durable directory.
    }
  }
  return count;
}

async function completedHostOperationCount(actionKind: string): Promise<number> {
  return hostOperationCount(actionKind, "completed");
}

async function waitForCompletedHostOperation(
  actionKind: string,
  minimumCount: number,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await completedHostOperationCount(actionKind) >= minimumCount) return;
    await delay(100);
  }
  throw new Error(`${actionKind}: Host operation did not become completed`);
}

function quoteCommandArgument(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shellLaunch(): {
  readonly appCommand: string;
  readonly args: readonly string[];
  readonly exitCommand: string;
  readonly file: string;
  readonly proofCommand: string;
} {
  const appCommand = [
    process.execPath,
    "--import",
    import.meta.resolve("tsx"),
    appEntryPath,
    workspacePath,
    ...(capabilityLifecycle
      ? ["capability"]
      : delegationCodingAnyLifecycle
        ? [delegationCodingExitCancelLifecycle
            ? "delegation-coding-exit-cancel"
            : delegationCodingCancelLifecycle
              ? "delegation-coding-cancel"
              : "delegation-coding"]
      : delegationLifecycle
        ? ["delegation"]
      : graphLifecycle
        ? ["graph"]
        : hookApprovalLifecycle
          ? ["hook-approval"]
          : []),
  ]
    .map(quoteCommandArgument)
    .join(" ");
  if (process.platform === "win32") {
    return {
      appCommand,
      args: ["/d", "/q"],
      // The driver has already verified the app exit marker and restored-shell
      // proof before closing its parent shell. Do not let an unrelated stale
      // cmd.exe ERRORLEVEL turn that deterministic harness shutdown into a
      // false application failure.
      exitCommand: "exit /b 0",
      file: process.env.ComSpec ?? "cmd.exe",
      proofCommand: "echo PTY_SHELL_RESTORED",
    };
  }
  return {
    appCommand,
    args: ["-i"],
    exitCommand: "exit 0",
    file: process.env.SHELL ?? "/bin/sh",
    proofCommand: "printf 'PTY_SHELL_RESTORED\\n'",
  };
}

async function main(): Promise<void> {
  let raw = "";
  let exit: PtyExit | null = null;
  const confirmedHostActions: string[] = [];
  let hostPreparedExactIdentityVisible = false;
  let hostPreparedSummaryVisible = false;
  let hostPreparedTargetVisible = false;
  const launch = shellLaunch();
  const terminal = spawn(
    launch.file,
    [...launch.args],
    {
      cols: 80,
      cwd: workspacePath,
      env: childEnvironment(),
      name: "xterm-256color",
      rows: 24,
    },
  );
  terminal.onData((data) => {
    raw += data;
    if (Buffer.byteLength(raw, "utf8") > MAX_OUTPUT_BYTES) {
      terminal.kill();
    }
  });
  const exitPromise = new Promise<PtyExit>((resolve) => {
    terminal.onExit((value) => {
      exit = value;
      resolve(value);
    });
  });

  const waitFor = async (
    predicate: (plain: string) => boolean,
    label: string,
    timeoutMs = 12_000,
  ): Promise<void> => {
    if (predicate(visibleText(raw))) return;
    await new Promise<void>((resolve, reject) => {
      const dataSubscription = terminal.onData(() => {
        if (!predicate(visibleText(raw))) return;
        clearTimeout(timer);
        dataSubscription.dispose();
        exitSubscription.dispose();
        resolve();
      });
      const exitSubscription = terminal.onExit((value) => {
        clearTimeout(timer);
        dataSubscription.dispose();
        exitSubscription.dispose();
        reject(
          new Error(
            `${label}: PTY exited early (${String(value.exitCode)}); tail=${visibleText(raw).slice(-100_000)}`,
          ),
        );
      });
      const timer = setTimeout(() => {
        dataSubscription.dispose();
        exitSubscription.dispose();
        reject(
          new Error(
            `${label}: timed out; tail=${visibleText(raw).slice(-100_000)}`,
          ),
        );
      }, timeoutMs);
    });
  };

  const confirmPreparedAction = async (
    actionKind: string,
    label: string,
    minimumOffset = 0,
    progressedBeforeConfirm?: (plain: string) => boolean,
  ): Promise<{
    readonly noProgressBeforeConfirm: boolean;
    readonly preparedActionId: string;
  }> => {
    const header = `HOST PREPARED ACTION | ${actionKind}`;
    await waitFor(
      (plain) => plain.slice(minimumOffset).includes(header),
      `${label} Host prepared action`,
      25_000,
    );

    // Exact hashes do not fit the fixture's initial 80-column shell. Resize
    // while the modal is still default-cancel so the real renderer has to show
    // the complete Host identity before this driver can confirm it.
    terminal.resize(140, 45);
    await waitFor(
      (plain) => {
        const rendered = plain.slice(Math.max(minimumOffset, plain.lastIndexOf(header)));
        return rendered.includes(`summary: `) &&
          /target=(?:[^\r\n\s]+)/u.test(rendered) &&
          /prepared=[0-9a-f-]{36} sha256=[a-f0-9]{64}/u.test(rendered) &&
          /display_sha256=[a-f0-9]{64} expires=[^\r\n\s]+/u.test(rendered) &&
          rendered.includes("[CANCEL]  confirm exact prepared action (default cancel)");
      },
      `${label} exact Host identity`,
      12_000,
    );
    const beforeConfirm = visibleText(raw);
    const rendered = beforeConfirm.slice(Math.max(minimumOffset, beforeConfirm.lastIndexOf(header)));
    if (rendered.includes(`${header} | STALE`)) {
      throw new Error(`${label}: Host prepared action became stale before confirmation`);
    }
    const noProgressBeforeConfirm = progressedBeforeConfirm === undefined ||
      !progressedBeforeConfirm(beforeConfirm);
    if (!noProgressBeforeConfirm) {
      throw new Error(`${label}: domain progress was visible before Host confirmation`);
    }
    hostPreparedSummaryVisible ||= /summary: [^\r\n]+/u.test(rendered);
    hostPreparedTargetVisible ||= /target=(?:[^\r\n\s]+)/u.test(rendered);
    hostPreparedExactIdentityVisible ||= /prepared=[0-9a-f-]{36} sha256=[a-f0-9]{64}/u.test(rendered) &&
      /display_sha256=[a-f0-9]{64} expires=[^\r\n\s]+/u.test(rendered);
    const preparedActionId = /prepared=([0-9a-f-]{36}) sha256=[a-f0-9]{64}/u.exec(rendered)?.[1];
    if (preparedActionId === undefined) {
      throw new Error(`${label}: exact prepared action id is unavailable`);
    }

    const focusOffset = beforeConfirm.length;
    terminal.write("\u001b[C");
    await waitFor(
      (plain) => plain.slice(focusOffset).includes("[CONFIRM EXACT PREPARED ACTION]"),
      `${label} Host confirm focus`,
    );
    // Exactly one Enter is sent for this exact id/hash. Never retry Enter
    // across a Host modal boundary: a delayed duplicate could bind to another
    // prepared action or activate a default-deny modal.
    terminal.write("\r");
    confirmedHostActions.push(actionKind);
    return Object.freeze({ noProgressBeforeConfirm, preparedActionId });
  };

  const confirmFreshPreparedActionsUntilHostOperation = async (
    actionKind: string,
    label: string,
    minimumOffset: number,
    progressedBeforeConfirm?: (plain: string) => boolean,
  ): Promise<{ readonly noProgressBeforeConfirm: boolean }> => {
    const baseline = await hostOperationCount(actionKind);
    let review = await confirmPreparedAction(
      actionKind,
      label,
      minimumOffset,
      progressedBeforeConfirm,
    );
    let noProgressBeforeConfirm = review.noProgressBeforeConfirm;
    let confirmedPreparedActionId = review.preparedActionId;
    const header = `HOST PREPARED ACTION | ${actionKind}`;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await hostOperationCount(actionKind) > baseline) {
        return Object.freeze({ noProgressBeforeConfirm });
      }
      const plain = visibleText(raw);
      const rendered = plain.slice(Math.max(minimumOffset, plain.lastIndexOf(header)));
      const freshPreparedActionId = /prepared=([0-9a-f-]{36}) sha256=[a-f0-9]{64}/u.exec(rendered)?.[1];
      if (
        freshPreparedActionId !== undefined &&
        freshPreparedActionId !== confirmedPreparedActionId &&
        rendered.includes("[CANCEL]  confirm exact prepared action (default cancel)")
      ) {
        review = await confirmPreparedAction(
          actionKind,
          `${label} fresh Host review`,
          minimumOffset,
          progressedBeforeConfirm,
        );
        noProgressBeforeConfirm &&= review.noProgressBeforeConfirm;
        confirmedPreparedActionId = review.preparedActionId;
      }
      await delay(50);
    }
    throw new Error(`${label}: confirmed Host action never created a durable operation`);
  };

  const confirmPreparedActionAfterCatalogBootstrap = async (
    actionKind: string,
    label: string,
    minimumOffset: number,
    progressedBeforeConfirm?: (plain: string) => boolean,
  ): Promise<{ readonly noProgressBeforeConfirm: boolean }> => {
    await waitFor(
      (plain) => {
        const fresh = plain.slice(minimumOffset);
        return fresh.includes("HOST PREPARED ACTION | repository.register") ||
          fresh.includes(`HOST PREPARED ACTION | ${actionKind}`);
      },
      `${label} Host action or catalog bootstrap`,
      25_000,
    );
    const fresh = visibleText(raw).slice(minimumOffset);
    if (fresh.includes("HOST PREPARED ACTION | repository.register")) {
      await confirmPreparedAction(
        "repository.register",
        `${label} repository bootstrap`,
        minimumOffset,
        progressedBeforeConfirm,
      );
    }
    return confirmPreparedAction(
      actionKind,
      label,
      minimumOffset,
      progressedBeforeConfirm,
    );
  };

  const submitRetainedDraftForPreparedAction = async (
    command: string,
    actionKind: string,
    label: string,
    minimumOffset: number,
    progressedBeforeConfirm?: (plain: string) => boolean,
  ): Promise<{ readonly noProgressBeforeConfirm: boolean }> => {
    const header = `HOST PREPARED ACTION | ${actionKind}`;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const before = visibleText(raw);
      const fresh = before.slice(minimumOffset);
      if (fresh.includes(header)) {
        return confirmPreparedAction(
          actionKind,
          label,
          minimumOffset,
          progressedBeforeConfirm,
        );
      }
      if (!fresh.includes(`> ${command}`)) {
        throw new Error(`${label}: exact retained draft is no longer visible`);
      }
      const retainedCount = fresh.split("input kept locally").length - 1;
      // This Enter is a fresh command submission only. A Host modal is absent
      // in the exact output slice, and the next Enter is forbidden until this
      // one has either opened that modal or emitted a new retained-draft fact.
      terminal.write("\r");
      await waitFor(
        (plain) => {
          const current = plain.slice(minimumOffset);
          return current.includes(header) ||
            current.split("input kept locally").length - 1 > retainedCount;
        },
        `${label} prepared action or retained draft`,
        15_000,
      );
      if (visibleText(raw).slice(minimumOffset).includes(header)) {
        return confirmPreparedAction(
          actionKind,
          label,
          minimumOffset,
          progressedBeforeConfirm,
        );
      }
      await delay(100);
    }
    throw new Error(`${label}: retained draft never reached Host preparation`);
  };

  const submitTuiCommand = async (command: string, label: string): Promise<void> => {
    // ConPTY may deliver a text payload and its trailing carriage return in one
    // packet. The TUI intentionally rejects mixed printable/control packets, so
    // model a real typist: wait until the draft is visibly accepted, then send
    // Enter as its own key event.
    terminal.write(command);
    await waitFor((plain) => plain.includes(`> ${command}`), `${label} draft`);
    terminal.write("\r");
  };

  const submitRetainedDraftForResult = async (
    command: string,
    label: string,
    minimumOffset: number,
    resultVisible: (plain: string) => boolean,
  ): Promise<void> => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const before = visibleText(raw);
      const fresh = before.slice(minimumOffset);
      if (resultVisible(fresh)) return;
      if (!fresh.includes(`> ${command}`)) {
        throw new Error(`${label}: exact retained draft is no longer visible`);
      }
      const retainedCount = fresh.split("input kept locally").length - 1;
      terminal.write("\r");
      await waitFor(
        (plain) => {
          const current = plain.slice(minimumOffset);
          return resultVisible(current) ||
            current.split("input kept locally").length - 1 > retainedCount;
        },
        `${label} result or retained draft`,
        15_000,
      );
      if (resultVisible(visibleText(raw).slice(minimumOffset))) return;
      await delay(100);
    }
    throw new Error(`${label}: retained draft never reached its typed result`);
  };

  try {
    await delay(100);
    const appLaunchOffset = visibleText(raw).length;
    terminal.write(`${launch.appCommand}\r`);
    if (!graphLifecycle && !delegationLifecycle && !delegationCodingAnyLifecycle &&
        !capabilityLifecycle && !hookApprovalLifecycle) {
      await confirmPreparedAction(
        "repository.register",
        "TUI repository registration",
        appLaunchOffset,
      );
      await confirmPreparedAction(
        "session.message.submit",
        "initial task submission",
        visibleText(raw).length,
        (plain) => plain.includes("PTY_ACTIVE"),
      );
    }
    if (delegationCodingAnyLifecycle) {
      await waitFor((plain) => plain.includes("DELEGATIONS | 1") && plain.includes("INPUT"), "coding delegation panel", 25_000);
      terminal.resize(118, 39);
      const resized = terminal.cols === 118 && terminal.rows === 39;
      terminal.write("d");
      await waitFor((plain) => plain.includes("Canonical managed-worktree coding child"), "coding delegation detail");
      terminal.write("s");
      await waitFor((plain) => plain.includes("DELEGATION DECISION | START_OR_RESUME"), "coding delegation start confirmation");
      terminal.write("\u001b[C");
      await waitFor((plain) => plain.includes("[CONFIRM]"), "coding delegation start confirm focus");
      // Do not retry Enter across modal boundaries: a delayed duplicate can
      // become the default-deny decision for the child's first effect.
      await delay(300);
      const codingStartOffset = visibleText(raw).length;
      terminal.write("\r");
      const codingStartReview = await confirmPreparedActionAfterCatalogBootstrap(
        "delegation.resume",
        "coding delegation composite start",
        codingStartOffset,
        (plain) => plain.includes("actors=1/1") || plain.includes("#1 active"),
      );
      const patchApprovalVisible = (plain: string) =>
        plain.includes("APPROVAL | apply_patch") &&
        plain.includes("CHILD APPROVAL | actor=") &&
        plain.includes("action=apply_patch");
      // The authenticated composite now performs durable owner registration,
      // projection refresh, and child startup before the first effect review.
      // On loaded Windows workers that complete path can legitimately exceed
      // the old 35s fixture budget without any duplicate dispatch.
      await waitFor(patchApprovalVisible, "actor-bound child patch approval", 60_000);
      if (delegationCodingExitCancelLifecycle) {
        terminal.write("\u0004");
        await waitFor(
          (plain) => plain.includes("EXIT WITH ACTIVE CHILD") &&
            plain.includes("BACKGROUND HANDOFF UNAVAILABLE") &&
            plain.includes("DELEGATION DECISION | CANCEL"),
          "active child exit confirmation",
        );
        terminal.write("\u001b[C");
        await waitFor((plain) => plain.includes("[CONFIRM]"), "active child exit confirm focus");
        const exitCancelOffset = visibleText(raw).length;
        terminal.write("\r");
        await confirmFreshPreparedActionsUntilHostOperation(
          "delegation.cancel",
          "active child exit typed cancellation",
          exitCancelOffset,
          (plain) => plain.includes("#1 cancelled Canonical managed-worktree coding child"),
        );
        await waitFor(
          (plain) => plain.includes("#1 cancelled Canonical managed-worktree coding child"),
          "exit-cancelled coding child",
          25_000,
        );
        await waitFor((plain) => plain.replace(/\s+/gu, "").includes(
          "PTY_CODING_CANCEL_SNAPSHOT={\"accepted\":0,\"activeActorSlots\":0,\"activeConflictClaims\":0,\"approvedEffects\":0,\"cancelRequests\":1,\"cancelled\":1,\"childApprovalRequests\":1,\"childStartCount\":1}",
        ), "exit cancellation snapshot");
        await waitFor((plain) => plain.includes("PTY_APP_EXIT=0"), "exit cancellation app exit");
        terminal.write(`${launch.proofCommand}\r`);
        await waitFor((plain) => plain.split("PTY_SHELL_RESTORED").length - 1 >= 2, "exit cancellation shell restore");
        terminal.write(`${launch.exitCommand}\r`);
        const terminalExit = await Promise.race([
          exitPromise,
          delay(12_000).then(() => {
            throw new Error("Phase 20 active child exit cancellation PTY app did not exit");
          }),
        ]);
        const plain = visibleText(raw);
        process.stdout.write(JSON.stringify({
          appExitCode: 0,
          cancelledVisible: plain.includes("#1 cancelled Canonical managed-worktree coding child"),
          childPatchApprovalVisible: patchApprovalVisible(plain),
          cleanProjectionVisible: plain.replace(/\s+/gu, "").includes(
            "PTY_CODING_CANCEL_SNAPSHOT={\"accepted\":0,\"activeActorSlots\":0,\"activeConflictClaims\":0,\"approvedEffects\":0,\"cancelRequests\":1,\"cancelled\":1,\"childApprovalRequests\":1,\"childStartCount\":1}",
          ),
          delegationPreparedNoProgress: codingStartReview.noProgressBeforeConfirm,
          exitChoiceVisible: plain.includes("EXIT WITH ACTIVE CHILD") && plain.includes("BACKGROUND HANDOFF UNAVAILABLE"),
          outputBase64: Buffer.from(raw, "utf8").toString("base64"),
          resized,
          shellExitCode: terminalExit.exitCode,
          shellRestored: plain.split("PTY_SHELL_RESTORED").length - 1 >= 2,
          signal: canonicalPtySignal(terminalExit.signal),
        }), () => process.exit(0));
        return;
      }
      if (delegationCodingCancelLifecycle) {
        const interruptCancelOffset = visibleText(raw).length;
        terminal.write("\u0003");
        await confirmFreshPreparedActionsUntilHostOperation(
          "delegation.cancel",
          "coding child interrupt typed cancellation",
          interruptCancelOffset,
          (plain) => plain.includes("#1 cancelled Canonical managed-worktree coding child"),
        );
        await waitFor(
          (plain) => plain.includes("#1 cancelled Canonical managed-worktree coding child"),
          "cancelled coding child",
          25_000,
        );
        // Cancellation and app exit are separate decisions. The second
        // Ctrl+C is issued only after both the typed cancellation and its
        // owning composite have durably completed. The cancelled projection
        // can become visible slightly before ApplicationService releases the
        // active core-run authority; sending the exit key in that interval is
        // correctly interpreted as another run cancellation, not app exit.
        await waitForCompletedHostOperation("delegation.cancel", 1, 25_000);
        await waitForCompletedHostOperation("delegation.resume", 1, 25_000);
        await delay(500);
        terminal.write("\u0003");
        await waitFor((plain) => plain.replace(/\s+/gu, "").includes(
          "PTY_CODING_CANCEL_SNAPSHOT={\"accepted\":0,\"activeActorSlots\":0,\"activeConflictClaims\":0,\"approvedEffects\":0,\"cancelRequests\":1,\"cancelled\":1,\"childApprovalRequests\":1,\"childStartCount\":1}",
        ), "coding cancellation snapshot");
        await waitFor((plain) => plain.includes("PTY_APP_EXIT=0"), "coding cancellation app exit");
        terminal.write(`${launch.proofCommand}\r`);
        await waitFor((plain) => plain.split("PTY_SHELL_RESTORED").length - 1 >= 2, "coding cancellation shell restore");
        terminal.write(`${launch.exitCommand}\r`);
        const terminalExit = await Promise.race([
          exitPromise,
          delay(12_000).then(() => {
            throw new Error("Phase 20 coding cancellation PTY app did not exit");
          }),
        ]);
        const plain = visibleText(raw);
        process.stdout.write(JSON.stringify({
          appExitCode: 0,
          cancelledVisible: plain.includes("#1 cancelled Canonical managed-worktree coding child"),
          childPatchApprovalVisible: patchApprovalVisible(plain),
          cleanProjectionVisible: plain.replace(/\s+/gu, "").includes(
            "PTY_CODING_CANCEL_SNAPSHOT={\"accepted\":0,\"activeActorSlots\":0,\"activeConflictClaims\":0,\"approvedEffects\":0,\"cancelRequests\":1,\"cancelled\":1,\"childApprovalRequests\":1,\"childStartCount\":1}",
          ),
          delegationPreparedNoProgress: codingStartReview.noProgressBeforeConfirm,
          outputBase64: Buffer.from(raw, "utf8").toString("base64"),
          resized,
          shellExitCode: terminalExit.exitCode,
          shellRestored: plain.split("PTY_SHELL_RESTORED").length - 1 >= 2,
          signal: canonicalPtySignal(terminalExit.signal),
        }), () => process.exit(0));
        return;
      }
      terminal.resize(103, 33);
      await delay(300);
      const patchAllowBaseline = visibleText(raw).split("[ALLOW]").length - 1;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        // Use the same discrete navigation key as the other real-PTY
        // confirmation gates.  A printable `y` can be reinterpreted as draft
        // input if an invalidation briefly replaces the approval projection;
        // Right is never valid draft text and therefore remains fail-closed.
        // Keep it as one exact keypress: repeated navigation could toggle a
        // newly-arrived request or escape the modal boundary.
        terminal.write("\u001b[C");
        await delay(100);
        if (visibleText(raw).split("[ALLOW]").length - 1 > patchAllowBaseline) break;
      }
      await waitFor((plain) => plain.split("[ALLOW]").length - 1 > patchAllowBaseline, "child patch allow focus");
      terminal.write("\r");
      const commandApprovalVisible = (plain: string) =>
        plain.includes("APPROVAL | run_command") && plain.includes("action=run_command");
      await waitFor(commandApprovalVisible, "actor-bound child command approval");
      const commandAllowBaseline = visibleText(raw).split("[ALLOW]").length - 1;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        terminal.write("y");
        await delay(100);
        if (visibleText(raw).split("[ALLOW]").length - 1 > commandAllowBaseline) break;
      }
      await waitFor((plain) => plain.split("[ALLOW]").length - 1 > commandAllowBaseline, "child command allow focus");
      terminal.write("\r");
      await waitFor(
        (plain) => plain.includes("#1 accepted Canonical managed-worktree coding child"),
        "accepted coding child",
      );
      terminal.write("v");
      await waitFor((plain) => plain.includes("RECEIPT |") && plain.includes("status=succeeded"), "coding change receipt");
      // The accepted projection/receipt can become visible before the outer
      // delegation.resume Application operation releases its active core run.
      // Bind exit to the durable completed operation, then allow one renderer
      // turn; an immediate Ctrl+C here would correctly target the still-active
      // owner instead of exiting the TUI.
      await waitForCompletedHostOperation("delegation.resume", 1);
      await delay(500);
      terminal.write("\u0003");
      await waitFor((plain) => plain.replace(/\s+/gu, "").includes(
        "PTY_CODING_DELEGATION_SNAPSHOT={\"accepted\":1,\"activeActorSlots\":0,\"activeConflictClaims\":0,\"approvedEffects\":2,\"cancelRequests\":0,\"cancelled\":0,\"childApprovalRequests\":2,\"childStartCount\":1}",
      ), "coding delegation snapshot");
      await waitFor((plain) => plain.includes("PTY_APP_EXIT=0"), "coding delegation app exit");
      terminal.write(`${launch.proofCommand}\r`);
      await waitFor((plain) => plain.split("PTY_SHELL_RESTORED").length - 1 >= 2, "coding delegation shell restore");
      terminal.write(`${launch.exitCommand}\r`);
      const terminalExit = await Promise.race([
        exitPromise,
        delay(12_000).then(() => {
          throw new Error("Phase 20 coding delegation PTY app did not exit");
        }),
      ]);
      const plain = visibleText(raw);
      process.stdout.write(JSON.stringify({
        appExitCode: 0,
        childCommandApprovalVisible: plain.includes("APPROVAL | run_command") && plain.includes("action=run_command"),
        childPatchApprovalVisible: plain.includes("APPROVAL | apply_patch") && plain.includes("action=apply_patch"),
        delegationPreparedNoProgress: codingStartReview.noProgressBeforeConfirm,
        outputBase64: Buffer.from(raw, "utf8").toString("base64"),
        receiptVisible: plain.includes("RECEIPT |") && plain.includes("status=succeeded"),
        resized,
        shellExitCode: terminalExit.exitCode,
        shellRestored: plain.split("PTY_SHELL_RESTORED").length - 1 >= 2,
        signal: canonicalPtySignal(terminalExit.signal),
      }), () => process.exit(0));
      return;
    }
    if (delegationLifecycle) {
      await waitFor(
        (plain) => plain.includes("DELEGATIONS | 3") && plain.includes("INPUT"),
        "Phase 20 delegation panel header",
        20_000,
      );
      terminal.resize(118, 39);
      const resized = terminal.cols === 118 && terminal.rows === 39;
      terminal.write("d");
      await waitFor((plain) => plain.includes("DELEGATION DETAIL |") && plain.includes("Canonical read-only child 1"), "delegation detail");
      terminal.write("j");
      await delay(150);
      terminal.write("j");
      await waitFor((plain) => plain.includes("#3 draft Canonical PTY rejection child") && plain.includes("Reject this exact third delegation"), "third proposed delegation");
      terminal.write("r");
      await waitFor((plain) => plain.includes("DELEGATION DECISION | REJECT"), "delegation reject confirmation");
      terminal.write("\u001b[C");
      await waitFor((plain) => plain.includes("[CONFIRM]"), "delegation reject confirm focus");
      const delegationRejectOffset = visibleText(raw).length;
      terminal.write("\r");
      await confirmPreparedActionAfterCatalogBootstrap(
        "delegation.decide",
        "delegation rejection",
        delegationRejectOffset,
      );
      await waitFor((plain) => plain.includes("#3 rejected Canonical PTY rejection child"), "delegation rejected result");
      terminal.write("k");
      await delay(150);
      terminal.write("k");
      await delay(150);
      terminal.write("s");
      await waitFor((plain) => plain.includes("DELEGATION DECISION | START_OR_RESUME"), "delegation start confirmation");
      terminal.write("\u001b[C");
      await waitFor((plain) => plain.includes("[CONFIRM]"), "delegation start confirm focus");
      const delegationStartOffset = visibleText(raw).length;
      terminal.write("\r");
      const delegationStartReview = await confirmPreparedActionAfterCatalogBootstrap(
        "delegation.resume",
        "delegation composite start",
        delegationStartOffset,
        (plain) => plain.includes("actors=2/2"),
      );
      await waitFor((plain) => plain.includes("actors=2/2"), "two active Phase 20 children", 65_000);
      await waitFor(
        (plain) => plain.includes("#1 accepted Canonical read-only child 1") && plain.includes("#2 accepted Canonical read-only child 2"),
        "two accepted Phase 20 receipts",
        // The four-suite real-PTY matrix cold-starts multiple built worker
        // processes on Windows. Keep the success condition exact, but allow
        // those two child processes to consume the outer fixture's existing
        // lifecycle budget instead of killing an otherwise-progressing owner
        // at an arbitrary shorter boundary.
        75_000,
      );
      terminal.write("v");
      await waitFor((plain) => plain.includes("RECEIPT |") && plain.includes("status=succeeded"), "verified child receipt");
      // The group projection and receipts become visible before the owning
      // delegation.resume Application operation necessarily releases the
      // active core-run authority. Bind the separate exit decision to the
      // durable operation terminal so Ctrl+C cannot be reinterpreted as a
      // second cancellation request during that narrow handoff window.
      await waitForCompletedHostOperation("delegation.resume", 1, 30_000);
      await delay(500);
      terminal.write("\u0003");
      await waitFor((plain) => plain.includes("PTY_DELEGATION_SNAPSHOT={\"accepted\":2,\"childStartCount\":2,\"rejected\":1,\"receipts\":2}"), "first delegation snapshot");
      await waitFor((plain) => plain.includes("PTY_APP_EXIT=0"), "first delegation app exit");
      terminal.write(`${launch.proofCommand}\r`);
      await waitFor((plain) => plain.split("PTY_SHELL_RESTORED").length - 1 >= 2, "first restored parent shell");

      const delegationHeaderCount = visibleText(raw).split("DELEGATIONS | 3").length - 1;
      terminal.write(`${launch.appCommand}\r`);
      await waitFor(
        (plain) => plain.split("DELEGATIONS | 3").length - 1 > delegationHeaderCount,
        "replayed Phase 20 delegation panel",
        20_000,
      );
      terminal.write("d");
      await delay(250);
      terminal.write("v");
      await waitFor(
        (plain) => plain.split("RECEIPT |").length - 1 >= 2 && plain.includes("status=succeeded"),
        "replayed verified child receipt",
      );
      terminal.write("\u0003");
      await waitFor((plain) => plain.split("PTY_APP_EXIT=0").length - 1 >= 2, "second delegation app exit");
      await waitFor(
        (plain) => plain.split("PTY_DELEGATION_SNAPSHOT={\"accepted\":2,\"childStartCount\":2,\"rejected\":1,\"receipts\":2}").length - 1 >= 2,
        "stable replay snapshot",
      );
      terminal.write(`${launch.proofCommand}\r`);
      await waitFor((plain) => plain.split("PTY_SHELL_RESTORED").length - 1 >= 4, "second restored parent shell");
      terminal.write(`${launch.exitCommand}\r`);
      const terminalExit = await Promise.race([
        exitPromise,
        delay(12_000).then(() => {
          throw new Error("Phase 20 delegation PTY app did not exit");
        }),
      ]);
      const plain = visibleText(raw);
      process.stdout.write(JSON.stringify({
        appExitCode: 0,
        delegationRejected: plain.includes("#3 rejected Canonical PTY rejection child"),
        delegationPreparedNoProgress: delegationStartReview.noProgressBeforeConfirm,
        hostPreparedActions: confirmedHostActions,
        hostPreparedExactIdentityVisible,
        hostPreparedSummaryVisible,
        hostPreparedTargetVisible,
        maximumActiveChildrenVisible: plain.includes("actors=2/2"),
        outputBase64: Buffer.from(raw, "utf8").toString("base64"),
        receiptsVisible: plain.includes("#1 accepted Canonical read-only child 1") && plain.includes("#2 accepted Canonical read-only child 2"),
        replayStable: plain.split("PTY_DELEGATION_SNAPSHOT={\"accepted\":2,\"childStartCount\":2,\"rejected\":1,\"receipts\":2}").length - 1 >= 2,
        resized,
        shellExitCode: terminalExit.exitCode,
        shellRestored: plain.split("PTY_SHELL_RESTORED").length - 1 >= 4,
        signal: canonicalPtySignal(terminalExit.signal),
        verifiedReceiptVisible: plain.includes("RECEIPT |") && plain.includes("status=succeeded"),
      }), () => process.exit(0));
      return;
    }
    if (hookApprovalLifecycle) {
      const approve = async (actionKind: string, label: string): Promise<void> => {
        const pendingRequestId = (plain: string): string | undefined => {
          const escapedKind = actionKind.replaceAll(".", "\\.");
          const requests = [...plain.matchAll(new RegExp(
            `\\[approval:requested\\] ${escapedKind} ([0-9a-f-]{36})`,
            "gu",
          ))];
          for (const match of requests.toReversed()) {
            const requestId = match[1];
            if (
              requestId !== undefined &&
              !plain.includes(`[approval:approved] ${actionKind} ${requestId}`) &&
              !plain.includes(`[approval:denied] ${actionKind} ${requestId}`)
            ) return requestId;
          }
          return undefined;
        };
        await waitFor(
          (plain) => pendingRequestId(plain) !== undefined,
          `${label} request`,
        );
        // The approval row may be rendered more than once before input is
        // accepted. Bind the proof to one immutable request id. The redraw
        // after the single Right key must show that same request together with
        // the live allow focus; an older [ALLOW] token in accumulated PTY
        // output is not sufficient authority for Enter.
        const requestOffset = visibleText(raw).lastIndexOf(`APPROVAL | ${actionKind}`);
        const requestId = pendingRequestId(visibleText(raw));
        if (requestId === undefined) {
          throw new Error(`${label}: approval request identity is unavailable`);
        }
        terminal.write("\u001b[C");
        await waitFor(
          (plain) => {
            const exact = `APPROVAL | ${actionKind} | request=${requestId}`;
            const latestRequest = plain.lastIndexOf(exact);
            const latestAllow = plain.lastIndexOf("deny  [ALLOW]");
            const latestDeny = plain.lastIndexOf("[DENY]  allow (default deny)");
            return latestRequest >= requestOffset &&
              latestAllow > latestRequest &&
              latestAllow > latestDeny;
          },
          `${label} exact allow focus`,
        );
        // Enter follows the observed focus immediately. A delay here gives a
        // concurrent durable projection refresh time to restore default-deny
        // focus even though the request identity itself has not changed.
        terminal.write("\r");
        await waitFor(
          (plain) => plain.includes(`[approval:approved] ${actionKind} ${requestId}`) ||
            plain.includes(`[approval:denied] ${actionKind} ${requestId}`),
          `${label} durable decision`,
        );
        if (visibleText(raw).includes(`[approval:denied] ${actionKind} ${requestId}`)) {
          const tail = visibleText(raw).slice(-4_000).replaceAll("\n", "\\n");
          throw new Error(`${label}: exact approval request was denied; tail=${tail}`);
        }
      };
      terminal.resize(111, 33);
      const resized = terminal.cols === 111 && terminal.rows === 33;
      const hookTaskOffset = visibleText(raw).length;
      await submitTuiCommand(
        "Run the approved Hook PTY plan",
        "Hook approval resume",
      );
      await confirmPreparedActionAfterCatalogBootstrap(
        "session.message.submit",
        "Hook task submission",
        hookTaskOffset,
        (plain) => plain.includes("APPROVAL | mcp.server.start"),
      );
      await approve("mcp.server.start", "MCP server start approval");
      await approve("mcp.tool.call", "original MCP action approval");
      await waitFor(
        (plain) => plain.includes("APPROVAL | run_command") && plain.includes("Hook: user_install:bornagent.hook-pty@1.0.0/hook/command-gate#sha256:"),
        "independent command Hook approval",
      );
      terminal.write("\r");
      await waitFor(
        (plain) => plain.includes("Hook failed: hook_approval_denied") ||
          plain.includes("[approval:denied] run_command"),
        "command Hook denial",
      );
      await waitFor(
        (plain) =>
          plain.includes("[model:accepted:user_visible] HOOK_PTY_DENIED") ||
          plain.includes("[model:rejected:internal_candidate] HOOK_PTY_DENIED"),
        "post-denial model terminal",
      );
      terminal.write("\u0003");
      await waitFor((plain) => plain.includes("PTY_APP_EXIT=0"), "Hook approval app exit");
      await delay(300);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        terminal.write(`${launch.proofCommand}\r`);
        await delay(200);
        if (visibleText(raw).split("PTY_SHELL_RESTORED").length - 1 >= 2) break;
      }
      await waitFor(
        (plain) => plain.split("PTY_SHELL_RESTORED").length - 1 >= 2,
        "restored parent shell",
      );
      terminal.write(`${launch.exitCommand}\r`);
      const terminalExit = await Promise.race([
        exitPromise,
        delay(12_000).then(() => {
          throw new Error("Hook approval PTY app did not exit");
        }),
      ]);
      const plain = visibleText(raw);
      process.stdout.write(JSON.stringify({
        appExitCode: 0,
        hookApprovalDenied: plain.includes("Hook failed: hook_approval_denied") ||
          plain.includes("[approval:denied] run_command"),
        hookApprovalVisible: plain.includes("APPROVAL | run_command"),
        originalApprovalVisible: plain.includes("APPROVAL | mcp.tool.call"),
        outputBase64: Buffer.from(raw, "utf8").toString("base64"),
        resized,
        serverApprovalVisible: plain.includes("APPROVAL | mcp.server.start"),
        shellExitCode: terminalExit.exitCode,
        shellRestored: plain.split("PTY_SHELL_RESTORED").length - 1 >= 2,
        signal: canonicalPtySignal(terminalExit.signal),
      }), () => process.exit(0));
      return;
    }
    if (graphLifecycle) {
      await waitFor(
        (plain) => plain.includes("GRAPH |") && plain.includes("draft") && plain.includes("INPUT") &&
          (plain.includes("run=idle") || plain.includes("run=completed") || plain.includes("precondition_failed")),
        "Graph TUI draft",
        30_000,
      );
      terminal.resize(103, 31);
      const resized = terminal.cols === 103 && terminal.rows === 31;
      const graphApproveOffset = visibleText(raw).length;
      await submitTuiCommand("/graph approve", "Graph approval command");
      const graphApproveReview = await submitRetainedDraftForPreparedAction(
        "/graph approve",
        "graph.decide",
        "Graph approval",
        graphApproveOffset,
        (plain) => plain.includes("status=approved") || plain.includes("| approved |"),
      );
      await waitFor(
        (plain) => plain.includes("status=approved") || (plain.includes("GRAPH |") && plain.includes("approved")),
        "Graph TUI approval",
      );
      await waitForCompletedHostOperation("graph.decide", 1);
      await delay(500);
      const graphEnqueueOffset = visibleText(raw).length;
      await submitTuiCommand("/graph enqueue foreground", "Graph enqueue command");
      await submitRetainedDraftForPreparedAction(
        "/graph enqueue foreground",
        "graph.enqueue",
        "Graph enqueue",
        graphEnqueueOffset,
        (plain) => (plain.includes("Graph queued:") && plain.includes("Ready: inspect")) ||
          plain.includes("| queued |"),
      );
      await waitFor(
        (plain) => (plain.includes("Graph queued:") && plain.includes("Ready: inspect")) ||
          (plain.includes("| queued |") && plain.includes("GRAPH NODE | 1:inspect | ready")),
        "Graph TUI enqueue",
      );
      await waitForCompletedHostOperation("graph.enqueue", 1);
      await delay(500);
      const graphNodeOffset = visibleText(raw).length;
      await submitTuiCommand("/graph node inspect", "Graph node command");
      await submitRetainedDraftForResult(
        "/graph node inspect",
        "Graph TUI node projection",
        graphNodeOffset,
        (plain) => plain.includes("Graph node inspect:"),
      );
      const graphCancelOffset = visibleText(raw).length;
      await submitTuiCommand("/graph cancel PTY_CANCEL", "Graph cancel command");
      await submitRetainedDraftForPreparedAction(
        "/graph cancel PTY_CANCEL",
        "graph.cancel",
        "Graph cancellation",
        graphCancelOffset,
        (plain) => plain.includes("Graph cancel requested:") ||
          (plain.includes("GRAPH |") && plain.includes("| cancelled |")),
      );
      await waitFor(
        (plain) => plain.includes("Graph cancel requested:") ||
          (plain.includes("GRAPH |") && plain.includes("| cancelled |")),
        "Graph TUI cancellation",
      );
      await waitForCompletedHostOperation("graph.cancel", 1);
      terminal.write("\u0003");
      await waitFor((plain) => plain.includes("PTY_APP_EXIT=0"), "Graph app exit");
      terminal.write(`${launch.proofCommand}\r`);
      await waitFor(
        (plain) => plain.split("PTY_SHELL_RESTORED").length - 1 >= 2,
        "restored parent shell",
      );
      terminal.write(`${launch.exitCommand}\r`);
      const terminalExit = await Promise.race([
        exitPromise,
        delay(12_000).then(() => {
          throw new Error("Graph PTY app did not exit");
        }),
      ]);
      const plain = visibleText(raw);
      process.stdout.write(JSON.stringify({
        appExitCode: 0,
        graphPreparedNoProgress: graphApproveReview.noProgressBeforeConfirm,
        graphApproved: plain.includes("status=approved") || plain.includes("| approved |"),
        graphCancelled: plain.includes("Graph cancel requested:") ||
          (plain.includes("GRAPH |") && plain.includes("| cancelled |")),
        graphEnqueued: (plain.includes("Graph queued:") && plain.includes("Ready: inspect")) ||
          (plain.includes("| queued |") && plain.includes("GRAPH NODE | 1:inspect | ready")),
        graphNodeVisible: plain.includes("Graph node inspect:"),
        hostPreparedActions: confirmedHostActions,
        hostPreparedExactIdentityVisible,
        hostPreparedSummaryVisible,
        hostPreparedTargetVisible,
        outputBase64: Buffer.from(raw, "utf8").toString("base64"),
        resized,
        shellExitCode: terminalExit.exitCode,
        shellRestored: plain.split("PTY_SHELL_RESTORED").length - 1 >= 2,
        signal: canonicalPtySignal(terminalExit.signal),
      }), () => process.exit(0));
      return;
    }
    if (capabilityLifecycle) {
      await waitFor(
        (plain) => plain.includes("STATUS") && plain.includes("run=idle"),
        "capability TUI idle",
      );
      terminal.resize(103, 31);
      const resized = terminal.cols === 103 && terminal.rows === 31;
      await submitTuiCommand("/plugins", "Plugin inventory command");
      await waitFor(
        (plain) => plain.includes("bornagent.m9-review-pack@1.0.0") && plain.includes("enabled-next-run"),
        "Plugin panel",
      );
      await submitTuiCommand("/skill review-change PTY_OPAQUE_ARGUMENT", "Skill command");
      await waitFor(
        (plain) => plain.includes("Skill selected for the next run:"),
        "Skill selection",
      );
      await submitTuiCommand(
        '/mcp-prompt offline-docs:review {"topic":"PTY_SAFE"}',
        "MCP prompt command",
      );
      await waitFor(
        (plain) => plain.includes("MCP prompt selected for the next run: offline-docs:review"),
        "MCP prompt selection",
      );
      terminal.write("\u0003");
      await waitFor((plain) => plain.includes("PTY_APP_EXIT=0"), "capability app exit");
      terminal.write(`${launch.proofCommand}\r`);
      await waitFor(
        (plain) => plain.split("PTY_SHELL_RESTORED").length - 1 >= 2,
        "restored parent shell",
      );
      terminal.write(`${launch.exitCommand}\r`);
      const terminalExit = await Promise.race([
        exitPromise,
        delay(12_000).then(() => {
          throw new Error("capability PTY app did not exit");
        }),
      ]);
      process.stdout.write(JSON.stringify({
        appExitCode: 0,
        mcpPromptSelected: visibleText(raw).includes("MCP prompt selected for the next run"),
        outputBase64: Buffer.from(raw, "utf8").toString("base64"),
        pluginVisible: visibleText(raw).includes("bornagent.m9-review-pack@1.0.0"),
        resized,
        shellExitCode: terminalExit.exitCode,
        shellRestored: visibleText(raw).split("PTY_SHELL_RESTORED").length - 1 >= 2,
        signal: canonicalPtySignal(terminalExit.signal),
        skillSelected: visibleText(raw).includes("Skill selected for the next run"),
      }), () => process.exit(0));
      return;
    }
    // Phase21 Host registration/session materialization adds bounded startup
    // work before the first model delta. Keep the real PTY gate tolerant of
    // full-suite CPU contention without weakening the visible-state proof.
    await waitFor((plain) => plain.includes("PTY_ACTIVE"), "first run active", 45_000);
    terminal.resize(103, 31);
    const resized = terminal.cols === 103 && terminal.rows === 31;
    await delay(100);
    terminal.write("\u0003");
    await waitFor((plain) => plain.includes("run=cancelled"), "first run cancelled");
    let repositoryDirty = false;
    let repositoryReady = false;
    let repositoryRefreshed = false;
    let retainedDraftBlockedVisible = false;
    let secondTaskOffset = 0;
    if (repositoryLifecycle) {
      const firstRefreshOffset = visibleText(raw).length;
      terminal.write("/refresh\r");
      // Cancelling the first run can finish just before the session watcher
      // publishes its fresh idle snapshot. The controller deliberately keeps
      // `/refresh` as a local draft instead of rebinding that stale Enter, so
      // submit the exact preserved draft again until the bounded refresh has
      // produced its repository projection.
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await delay(100);
        const refreshed = visibleText(raw).slice(firstRefreshOffset);
        if (refreshed.includes("engine=typescript-language-service") && refreshed.includes("index=ready")) break;
        terminal.write("\r");
      }
      await waitFor(
        (plain) => {
          const refreshed = plain.slice(firstRefreshOffset);
          return refreshed.includes("engine=typescript-language-service") && refreshed.includes("index=ready");
        },
        "repository first refresh",
      );
      repositoryReady = true;
      const readyOffset = visibleText(raw).lastIndexOf("index=ready");
      await writeFile(
        `${workspacePath}${process.platform === "win32" ? "\\" : "/"}repo.ts`,
        "export const ptyValue = 2;\n",
        "utf8",
      );
      await waitFor(
        (plain) => plain.indexOf("index=dirty", readyOffset + 1) >= 0,
        "repository external invalidation",
      );
      repositoryDirty = true;
      const dirtyOffset = visibleText(raw).lastIndexOf("index=dirty");
      // `/refresh` deliberately remains visible in the local draft. Re-submit it, then clear
      // the draft before the second ordinary task.
      for (let attempt = 0; attempt < 50; attempt += 1) {
        terminal.write("\r");
        await delay(100);
        if (visibleText(raw).indexOf("index=ready", dirtyOffset + 1) >= 0) break;
      }
      await waitFor(
        (plain) => plain.indexOf("index=ready", dirtyOffset + 1) >= 0,
        "repository second refresh",
      );
      repositoryRefreshed = true;
      terminal.write("\u007f".repeat(8));
    } else {
      secondTaskOffset = visibleText(raw).length;
      terminal.write("Second PTY run");
      await waitFor(
        (plain) => plain.includes("> Second PTY run"),
        "second run retained draft",
      );
      terminal.write("\r");
      await waitFor(
        (plain) => {
          const fresh = plain.slice(secondTaskOffset);
          return (fresh.includes("Run active") || fresh.includes("Session refresh in progress")) &&
            fresh.includes("input kept locally") &&
            fresh.includes("> Second PTY run");
        },
        "active operation retains second run draft",
      );
      retainedDraftBlockedVisible = true;
    }
    // The durable cancelled projection is visible before the outer message
    // operation releases its in-process runner. Observe that exact Host
    // operation reaching completed before submitting another command; this
    // proves the driver never relies on an arbitrary sleep to cross ownership.
    await waitForCompletedHostOperation("session.message.submit", 1);
    // The operation record is the authority boundary. Give the TUI one bounded
    // renderer turn to clear its in-memory coordinator before sending the fresh
    // command Enter; no modal exists during this settle interval.
    await delay(500);
    if (repositoryLifecycle) {
      secondTaskOffset = visibleText(raw).length;
      terminal.write("Second PTY run");
      await waitFor(
        (plain) => plain.slice(secondTaskOffset).includes("> Second PTY run"),
        "second run draft",
      );
    }
    const secondTaskReview = await submitRetainedDraftForPreparedAction(
      "Second PTY run",
      "session.resume",
      "second task submission",
      secondTaskOffset,
      (plain) => plain.includes("PTY_SECOND"),
    );
    await waitFor((plain) => plain.includes("PTY_SECOND"), "second run response");
    await waitFor((plain) => plain.includes("run=incomplete"), "second run idle");
    terminal.write("\u0003");
    await waitFor((plain) => plain.includes("PTY_APP_EXIT=0"), "app exit");
    terminal.write(`${launch.proofCommand}\r`);
    await waitFor(
      (plain) => plain.split("PTY_SHELL_RESTORED").length - 1 >= 2,
      "restored parent shell",
    );
    terminal.write(`${launch.exitCommand}\r`);
    const terminalExit = await Promise.race([
      exitPromise,
      delay(12_000).then(() => {
        throw new Error("PTY app did not exit from idle Ctrl+C");
      }),
    ]);
    const evidence = {
      appExitCode: 0,
      hostPreparedActions: confirmedHostActions,
      hostPreparedExactIdentityVisible,
      hostPreparedSummaryVisible,
      hostPreparedTargetVisible,
      outputBase64: Buffer.from(raw, "utf8").toString("base64"),
      resized,
      repositoryDirty,
      repositoryReady,
      repositoryRefreshed,
      retainedDraftBlockedVisible,
      taskPreparedNoProgress: secondTaskReview.noProgressBeforeConfirm,
      shellExitCode: terminalExit.exitCode,
      shellRestored:
        visibleText(raw).split("PTY_SHELL_RESTORED").length - 1 >= 2,
      signal: canonicalPtySignal(terminalExit.signal),
    };
    process.stdout.write(JSON.stringify(evidence), () => process.exit(0));
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    if (exit === null) {
      terminal.write("\u0003");
      terminal.write(`${launch.exitCommand}\r`);
      await delay(250);
    }
    process.exit(1);
  }
}

await main();
