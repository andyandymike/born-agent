import type { ChatRuntime } from "../chat/types.js";
import type { DoctorRuntime } from "../doctor/types.js";

export interface OutputWriter {
  write(value: string): void;
}

export interface CliIO {
  readonly stderr: OutputWriter;
  readonly stdout: OutputWriter;
}

export interface CliRuntime extends ChatRuntime, DoctorRuntime {
  readonly version: string;
}
