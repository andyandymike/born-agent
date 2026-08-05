import { Buffer } from "node:buffer";

import { spawn } from "node-pty";

const workspace = process.argv[2];
const appEntry = process.argv[3];
if (workspace === undefined || appEntry === undefined) {
  throw new Error("PTY driver requires workspace and app paths");
}
const workspacePath = workspace;
const appEntryPath = appEntry;

const MAX_OUTPUT_BYTES = 2_000_000;

interface PtyExit {
  readonly exitCode: number;
  readonly signal?: number;
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
            `${label}: PTY exited early (${String(value.exitCode)}); tail=${visibleText(raw).slice(-800)}`,
          ),
        );
      });
      const timer = setTimeout(() => {
        dataSubscription.dispose();
        exitSubscription.dispose();
        reject(
          new Error(
            `${label}: timed out; tail=${visibleText(raw).slice(-800)}`,
          ),
        );
      }, timeoutMs);
    });
  };

  try {
    await delay(100);
    terminal.write(`${launch.appCommand}\r`);
    await waitFor((plain) => plain.includes("PTY_ACTIVE"), "first run active");
    terminal.resize(103, 31);
    const resized = terminal.cols === 103 && terminal.rows === 31;
    await delay(100);
    terminal.write("\u0003");
    await waitFor((plain) => plain.includes("run=cancelled"), "first run cancelled");
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
      shellExitCode: terminalExit.exitCode,
      shellRestored:
        visibleText(raw).split("PTY_SHELL_RESTORED").length - 1 >= 2,
      signal: terminalExit.signal ?? null,
    };
    process.stdout.write(JSON.stringify(evidence), () => process.exit(0));
  } catch (error) {
    if (exit === null) terminal.kill();
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`, () => process.exit(1));
  }
}

await main();
