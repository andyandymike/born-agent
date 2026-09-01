import { createHash } from "node:crypto";

import {
  canonicalJson,
  sha256Canonical,
} from "../../../../src/completion/canonical-json.js";

export type MemE0FailureCode =
  | "child_observation_parse_failed"
  | "child_process_failed"
  | "child_stderr_rejected"
  | "mechanics_command_failed"
  | "offline_mechanics_failed"
  | "qualification_actor_failed"
  | "qualification_actor_observation_parse_failed"
  | "verifier_process_failed"
  | "workspace_process_failed";

export interface MemE0SanitizedFailureObservation {
  readonly failureClassSha256: string;
  readonly failureCode: MemE0FailureCode;
  readonly failureMessageSha256: string;
  readonly observationSha256: string;
  readonly schemaVersion: 1;
  readonly status: "failed_closed";
  readonly stderrSha256: string;
  readonly stdoutSha256: string;
}

function sha256Unknown(value: unknown): string {
  const hash = createHash("sha256");
  if (value instanceof Uint8Array) hash.update(value);
  else hash.update(typeof value === "string" ? value : String(value ?? ""), "utf8");
  return hash.digest("hex");
}

function errorField(error: unknown, key: "stderr" | "stdout"): unknown {
  return error !== null && typeof error === "object" && key in error
    ? (error as Readonly<Record<string, unknown>>)[key]
    : "";
}

export function observeMemE0SanitizedFailure(
  failureCode: MemE0FailureCode,
  error: unknown,
): MemE0SanitizedFailureObservation {
  if (error instanceof MemE0SanitizedBoundaryError) return error.observation;
  const failureClass = error instanceof Error ? error.name : typeof error;
  const failureMessage = error instanceof Error ? error.message : "non_error_throw";
  const content = Object.freeze({
    failureClassSha256: sha256Unknown(failureClass),
    failureCode,
    failureMessageSha256: sha256Unknown(failureMessage),
    schemaVersion: 1 as const,
    status: "failed_closed" as const,
    stderrSha256: sha256Unknown(errorField(error, "stderr")),
    stdoutSha256: sha256Unknown(errorField(error, "stdout")),
  });
  return Object.freeze({
    ...content,
    observationSha256: sha256Canonical(content),
  });
}

export class MemE0SanitizedBoundaryError extends Error {
  public readonly observation: MemE0SanitizedFailureObservation;

  public constructor(observation: MemE0SanitizedFailureObservation) {
    super(canonicalJson(observation));
    this.name = "MemE0SanitizedBoundaryError";
    this.observation = observation;
  }
}

export function createMemE0SanitizedBoundaryError(
  failureCode: MemE0FailureCode,
  error: unknown,
): MemE0SanitizedBoundaryError {
  return new MemE0SanitizedBoundaryError(
    observeMemE0SanitizedFailure(failureCode, error),
  );
}
