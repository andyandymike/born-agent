import type { StreamingChatRuntime } from "../chat/run-streaming-chat.js";
import type { DoctorRuntime } from "../doctor/types.js";

export interface OutputWriter {
  write(value: string): void;
}

export interface CliIO {
  readonly stderr: OutputWriter;
  readonly stdout: OutputWriter;
}

export interface CliRuntime extends StreamingChatRuntime, DoctorRuntime {
  readonly version: string;
}
