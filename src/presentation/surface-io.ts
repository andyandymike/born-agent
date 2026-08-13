/** Transport-neutral text sink used by CLI and terminal UI composition. */
export interface OutputWriter {
  write(value: string): void;
}

/** Presentation authority only; it has no filesystem, process, or domain port. */
export interface SurfaceIO {
  readonly stderr: OutputWriter;
  readonly stdout: OutputWriter;
}
