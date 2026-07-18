export interface DockerAcquisitionCommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface DockerAcquisitionCommandPort {
  run(
    argv: readonly string[],
    options?: {
      readonly cwd?: string;
      readonly timeoutMs?: number;
    },
  ): Promise<DockerAcquisitionCommandResult>;
}
