export type ExecutableResult =
  | {
      kind: "completed";
      exitCode: number;
      stderr: string;
      stdout: string;
    }
  | {
      kind: "missing";
    }
  | {
      kind: "timeout";
    }
  | {
      kind: "failed";
      message: string;
    };

export interface DoctorRuntime {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly nodeVersion: string;
  readonly platform: NodeJS.Platform;
  isReadableDirectory(path: string): Promise<boolean>;
  runExecutable(
    command: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<ExecutableResult>;
}

export interface DoctorCheck {
  readonly detail: string;
  readonly name: string;
  readonly ok: boolean;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly failed: number;
  readonly ok: boolean;
  readonly passed: number;
}
