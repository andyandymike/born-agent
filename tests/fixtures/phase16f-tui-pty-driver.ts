import { Buffer } from "node:buffer";
import { writeFile } from "node:fs/promises";

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
const graphLifecycle = process.argv[4] === "graph";
const hookApprovalLifecycle = process.argv[4] === "hook-approval";

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
      exitCommand: "exit",
      file: process.env.ComSpec ?? "cmd.exe",
      proofCommand: "echo PTY_SHELL_RESTORED",
    };
  }
  return {
    appCommand,
    args: ["-i"],
    exitCommand: "exit",
    file: process.env.SHELL ?? "/bin/sh",
    proofCommand: "printf 'PTY_SHELL_RESTORED\\n'",
  };
}

async function main(): Promise<void> {
  let raw = "";
  let exit: PtyExit | null = null;
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
            `${label}: PTY exited early (${String(value.exitCode)}); tail=${visibleText(raw).slice(-4_000)}`,
          ),
        );
      });
      const timer = setTimeout(() => {
        dataSubscription.dispose();
        exitSubscription.dispose();
        reject(
          new Error(
            `${label}: timed out; tail=${visibleText(raw).slice(-4_000)}`,
          ),
        );
      }, timeoutMs);
    });
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

  const confirmRetainedDraftUntil = async (
    predicate: (plain: string) => boolean,
    label: string,
  ): Promise<void> => {
    // A watcher refresh deliberately keeps a command draft instead of rebinding
    // its stale Enter intent. Repeated Enter here is an explicit PTY user
    // confirmation of those same visible bytes; an empty draft is inert.
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (predicate(visibleText(raw))) return;
      await delay(100);
      if (predicate(visibleText(raw))) return;
      terminal.write("\r");
    }
    await waitFor(predicate, label, 1);
  };

  try {
    await delay(100);
    terminal.write(`${launch.appCommand}\r`);
    if (hookApprovalLifecycle) {
      const approve = async (actionKind: string, label: string): Promise<void> => {
        await waitFor(
          (plain) => plain.includes(`APPROVAL | ${actionKind}`),
          `${label} request`,
        );
        const priorAllowFocus = visibleText(raw).split("[ALLOW]").length - 1;
        await delay(300);
        for (let attempt = 0; attempt < 20; attempt += 1) {
          terminal.write("y");
          await delay(200);
          if (visibleText(raw).split("[ALLOW]").length - 1 > priorAllowFocus) break;
        }
        await waitFor(
          (plain) => plain.split("[ALLOW]").length - 1 > priorAllowFocus,
          `${label} allow focus`,
        );
        terminal.write("\r");
      };
      terminal.resize(111, 33);
      const resized = terminal.cols === 111 && terminal.rows === 33;
      await submitTuiCommand(
        "Run the approved Hook PTY plan",
        "Hook approval resume",
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
          (plain.includes("run=idle") || plain.includes("precondition_failed")),
        "Graph TUI draft",
      );
      terminal.resize(103, 31);
      const resized = terminal.cols === 103 && terminal.rows === 31;
      await submitTuiCommand("/graph approve", "Graph approval command");
      await confirmRetainedDraftUntil(
        (plain) => plain.includes("status=approved") || (plain.includes("GRAPH |") && plain.includes("approved")),
        "Graph TUI approval",
      );
      await submitTuiCommand("/graph enqueue foreground", "Graph enqueue command");
      await confirmRetainedDraftUntil(
        (plain) => (plain.includes("Graph queued:") && plain.includes("Ready: inspect")) ||
          (plain.includes("| queued |") && plain.includes("GRAPH NODE | 1:inspect | ready")),
        "Graph TUI enqueue",
      );
      await submitTuiCommand("/graph node inspect", "Graph node command");
      await confirmRetainedDraftUntil(
        (plain) => plain.includes("Graph node inspect:"),
        "Graph TUI node projection",
      );
      await submitTuiCommand("/graph cancel PTY_CANCEL", "Graph cancel command");
      await confirmRetainedDraftUntil(
        (plain) => plain.includes("Graph cancel requested:") ||
          (plain.includes("GRAPH |") && plain.includes("| cancelled |")),
        "Graph TUI cancellation",
      );
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
        graphApproved: plain.includes("status=approved") || plain.includes("| approved |"),
        graphCancelled: plain.includes("Graph cancel requested:") ||
          (plain.includes("GRAPH |") && plain.includes("| cancelled |")),
        graphEnqueued: (plain.includes("Graph queued:") && plain.includes("Ready: inspect")) ||
          (plain.includes("| queued |") && plain.includes("GRAPH NODE | 1:inspect | ready")),
        graphNodeVisible: plain.includes("Graph node inspect:"),
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
    await waitFor((plain) => plain.includes("PTY_ACTIVE"), "first run active");
    terminal.resize(103, 31);
    const resized = terminal.cols === 103 && terminal.rows === 31;
    await delay(100);
    terminal.write("\u0003");
    await waitFor((plain) => plain.includes("run=cancelled"), "first run cancelled");
    let repositoryDirty = false;
    let repositoryReady = false;
    let repositoryRefreshed = false;
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
    }
    terminal.write("Second PTY run");
    await waitFor(
      (plain) => plain.includes("> Second PTY run"),
      "second run draft",
    );
    // The session file watcher may still be replacing the run-owned snapshot
    // after cancellation. The controller deliberately keeps the draft and
    // requires a fresh Enter instead of creating a hidden queued turn.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      terminal.write("\r");
      await delay(100);
      if (visibleText(raw).includes("PTY_SECOND")) break;
    }
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
      outputBase64: Buffer.from(raw, "utf8").toString("base64"),
      resized,
      repositoryDirty,
      repositoryReady,
      repositoryRefreshed,
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
