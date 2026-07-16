import type { ExecutionPurpose } from "../execution/execution-types.js";

export const VERIFICATION_COMMAND_KINDS = [
  "build",
  "check",
  "lint",
  "test",
  "typecheck",
] as const;

export type VerificationCommandKind =
  (typeof VERIFICATION_COMMAND_KINDS)[number];

export interface ApprovedCommandForVerification {
  readonly actionSha256: string;
  readonly approved: boolean;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly logicalExecutable: string;
  readonly purpose: ExecutionPurpose;
}

export interface RegistryVerificationClassification {
  readonly inputPaths: readonly string[];
  readonly kind: VerificationCommandKind;
  readonly packageScriptSha256?: string;
}

export interface VerificationRegistryAdapter {
  classify(
    command: ApprovedCommandForVerification,
  ): Promise<RegistryVerificationClassification | null>;
}

export type VerificationClassificationResult =
  | {
      readonly eligible: true;
      readonly inputPaths: readonly string[];
      readonly kind: VerificationCommandKind;
      readonly packageScriptSha256?: string;
    }
  | {
      readonly eligible: false;
      readonly reason:
        | "command_not_approved"
        | "command_not_classified"
        | "command_not_verify_purpose"
        | "verification_inputs_unknown";
    };

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function canonicalInputPath(path: string): string | null {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/u.test(path)
  ) {
    return null;
  }
  const normalized = path.normalize("NFC");
  const components = normalized.split("/");
  if (components.some((component) => component.length === 0 || component === "." || component === "..")) {
    return null;
  }
  return components.join("/");
}

export class VerificationCommandClassifier {
  constructor(private readonly adapter: VerificationRegistryAdapter) {}

  async classify(
    command: ApprovedCommandForVerification,
  ): Promise<VerificationClassificationResult> {
    if (!command.approved || !isSha256(command.actionSha256)) {
      return { eligible: false, reason: "command_not_approved" };
    }
    if (command.purpose !== "verify") {
      return { eligible: false, reason: "command_not_verify_purpose" };
    }

    const classified = await this.adapter.classify(command);
    if (classified === null) {
      return { eligible: false, reason: "command_not_classified" };
    }

    const canonicalPaths = classified.inputPaths.map(canonicalInputPath);
    if (
      canonicalPaths.length === 0 ||
      canonicalPaths.some((path) => path === null) ||
      new Set(canonicalPaths).size !== canonicalPaths.length ||
      !VERIFICATION_COMMAND_KINDS.includes(classified.kind) ||
      (classified.packageScriptSha256 !== undefined &&
        !isSha256(classified.packageScriptSha256))
    ) {
      // PHASE7: verify eligibility is supplied by the reviewed executable-registry
      // adapter. Guessing from argv (or accepting an unknown manifest) would let an
      // arbitrary exit-0 command masquerade as test evidence.
      return { eligible: false, reason: "verification_inputs_unknown" };
    }

    return {
      eligible: true,
      inputPaths: Object.freeze(canonicalPaths as string[]),
      kind: classified.kind,
      ...(classified.packageScriptSha256 === undefined
        ? {}
        : { packageScriptSha256: classified.packageScriptSha256 }),
    };
  }
}
