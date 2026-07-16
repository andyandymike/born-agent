import { sanitizeChildEnvironment } from "../security/child-environment.js";

export interface ProcessTreeCleanupResult {
  readonly verified: boolean;
  readonly forced: boolean;
  readonly detail: "clean" | "force_failed" | "graceful_failed" | "identity_missing";
}

export interface ProcessTreeCleanup {
  terminate(processIdentity: number | undefined): Promise<ProcessTreeCleanupResult>;
}

export interface CleanupTimerApi {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type KillProcess = (
  processIdentity: number,
  signal: "SIGKILL" | "SIGTERM" | 0,
) => void;

export type IsProcessAlive = (processIdentity: number) => boolean;

export type TaskkillArgvRunner = (args: readonly string[]) => Promise<number>;

function delay(timer: CleanupTimerApi, milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const handle = timer.setTimeout(() => {
      timer.clearTimeout(handle);
      resolve();
    }, milliseconds);
  });
}

export class NodeProcessTreeCleanup implements ProcessTreeCleanup {
  constructor(
    private readonly options: {
      readonly platform: NodeJS.Platform;
      readonly killProcess: KillProcess;
      readonly isProcessAlive: IsProcessAlive;
      readonly taskkill?: TaskkillArgvRunner;
      readonly timers: CleanupTimerApi;
      readonly gracePeriodMs?: number;
      readonly forceWaitMs?: number;
      readonly pollIntervalMs?: number;
    },
  ) {}

  async terminate(
    processIdentity: number | undefined,
  ): Promise<ProcessTreeCleanupResult> {
    if (processIdentity === undefined || processIdentity <= 0) {
      return { detail: "identity_missing", forced: false, verified: false };
    }
    // PHASE6: An exited wrapper PID is not cleanup proof. Termination targets the
    // Windows /T tree or the POSIX process group and then verifies that identity.
    return this.options.platform === "win32"
      ? this.terminateWindows(processIdentity)
      : this.terminatePosix(processIdentity);
  }

  private async terminateWindows(pid: number): Promise<ProcessTreeCleanupResult> {
    if (!this.options.taskkill) {
      return { detail: "graceful_failed", forced: false, verified: false };
    }
    const gracefulExit = await this.options.taskkill(["/PID", String(pid), "/T"]);
    if (gracefulExit === 0 && (await this.waitUntilGone(pid, this.gracePeriodMs))) {
      return { detail: "clean", forced: false, verified: true };
    }
    await this.options.taskkill([
      "/PID",
      String(pid),
      "/T",
      "/F",
    ]);
    // taskkill may report "not found" when the graceful /T request won the race.
    // Liveness after the full wait is stronger evidence than that racy exit code.
    const verified = await this.waitUntilGone(pid, this.forceWaitMs);
    return {
      detail: verified ? "clean" : "force_failed",
      forced: true,
      verified,
    };
  }

  private async terminatePosix(pid: number): Promise<ProcessTreeCleanupResult> {
    const groupIdentity = -pid;
    try {
      this.options.killProcess(groupIdentity, "SIGTERM");
    } catch {
      if (!this.options.isProcessAlive(groupIdentity)) {
        return { detail: "clean", forced: false, verified: true };
      }
    }
    if (await this.waitUntilGone(groupIdentity, this.gracePeriodMs)) {
      return { detail: "clean", forced: false, verified: true };
    }
    try {
      this.options.killProcess(groupIdentity, "SIGKILL");
    } catch {
      // The verification below is authoritative; ESRCH here can mean the tree exited.
    }
    const verified = await this.waitUntilGone(groupIdentity, this.forceWaitMs);
    return {
      detail: verified ? "clean" : "force_failed",
      forced: true,
      verified,
    };
  }

  private async waitUntilGone(identity: number, budgetMs: number): Promise<boolean> {
    const interval = this.options.pollIntervalMs ?? 25;
    let remaining = budgetMs;
    while (this.options.isProcessAlive(identity) && remaining > 0) {
      const wait = Math.min(interval, remaining);
      await delay(this.options.timers, wait);
      remaining -= wait;
    }
    return !this.options.isProcessAlive(identity);
  }

  private get gracePeriodMs(): number {
    return this.options.gracePeriodMs ?? 250;
  }

  private get forceWaitMs(): number {
    return this.options.forceWaitMs ?? 2000;
  }
}

export interface TaskkillSpawnedProcess {
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (exitCode: number | null) => void): this;
}

export type TaskkillSpawn = (
  file: string,
  args: readonly string[],
  options: {
    readonly env: Readonly<Record<string, string>>;
    readonly shell: false;
    readonly stdio: "ignore";
    readonly windowsHide: true;
  },
) => TaskkillSpawnedProcess;

export function createTaskkillArgvRunner(
  spawnFile: TaskkillSpawn,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): TaskkillArgvRunner {
  return async (args) =>
    new Promise<number>((resolve) => {
      // This is an internal fixed executable/argv adapter; no model text is parsed as shell.
      const child = spawnFile("taskkill.exe", args, {
        // PHASE8: cleanup helpers run outside the reviewed command env, so they
        // need their own final-boundary provider-credential stripping.
        env: sanitizeChildEnvironment(environment),
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      let settled = false;
      const finish = (exitCode: number): void => {
        if (!settled) {
          settled = true;
          resolve(exitCode);
        }
      };
      child.once("error", () => finish(-1));
      child.once("close", (exitCode) => finish(exitCode ?? -1));
    });
}
