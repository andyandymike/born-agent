import type { DoctorRuntime } from "../doctor/types.js";

export interface OutputWriter {
  write(value: string): void;
}

export interface CliIO {
  readonly stderr: OutputWriter;
  readonly stdout: OutputWriter;
}

export interface CliRuntime extends DoctorRuntime {
  readonly version: string;
}

