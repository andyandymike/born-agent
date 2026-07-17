export type SnapshotEntryKind =
  | "device"
  | "directory"
  | "file"
  | "junction"
  | "socket"
  | "submodule"
  | "symlink"
  | "other";

export type SnapshotOmissionCategory =
  | "host_cache"
  | "ignored"
  | "internal_state"
  | "sensitive_path";

export interface SnapshotFilterInput {
  readonly ignored: boolean;
  readonly kind: SnapshotEntryKind;
  readonly relativePath: string;
}

export type SnapshotFilterDecision =
  | { readonly disposition: "include"; readonly path: string }
  | { readonly disposition: "directory"; readonly path: string }
  | {
      readonly category: SnapshotOmissionCategory;
      readonly disposition: "omit";
      readonly path: string;
    };

export class SnapshotPolicyError extends Error {
  override readonly name = "SnapshotPolicyError";

  public constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const INTERNAL_SEGMENTS = new Set([".agents", ".bornagent", ".codex", ".git"]);
const CACHE_SEGMENTS = new Set([
  ".cache",
  ".gradle",
  ".npm",
  ".pnpm-store",
  "coverage",
  "node_modules",
]);
const SENSITIVE_NAMES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  "_netrc",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
]);

export function normalizeSnapshotRelativePath(value: string): string {
  if (
    value.length === 0 ||
    value.length > 4_096 ||
    value !== value.normalize("NFC") ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[a-zA-Z]:/u.test(value) ||
    value.startsWith("//")
  ) {
    throw new SnapshotPolicyError(
      "invalid_snapshot_path",
      "snapshot path must be normalized portable workspace-relative text",
    );
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.length > 255,
    )
  ) {
    throw new SnapshotPolicyError(
      "snapshot_path_escape",
      "snapshot path contains an empty, dot, or oversized segment",
    );
  }
  return value;
}

function sensitiveName(name: string): boolean {
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    SENSITIVE_NAMES.has(name) ||
    /(?:^service[-_]?account.*\.json$)|(?:\.(?:key|kdbx|p12|pem|pfx)$)/u.test(
      name,
    )
  );
}

export function filterSnapshotEntry(
  input: SnapshotFilterInput,
): SnapshotFilterDecision {
  const path = normalizeSnapshotRelativePath(input.relativePath);
  const segments = path.split("/").map((segment) => segment.toLowerCase());
  const name = segments.at(-1)!;
  if (segments.some((segment) => INTERNAL_SEGMENTS.has(segment))) {
    return Object.freeze({
      category: "internal_state",
      disposition: "omit",
      path,
    });
  }
  if (sensitiveName(name)) {
    return Object.freeze({
      category: "sensitive_path",
      disposition: "omit",
      path,
    });
  }
  if (input.ignored) {
    return Object.freeze({ category: "ignored", disposition: "omit", path });
  }
  if (
    segments.some((segment) => CACHE_SEGMENTS.has(segment)) ||
    segments.some(
      (segment, index) =>
        segment === ".yarn" && segments[index + 1] === "cache",
    )
  ) {
    return Object.freeze({
      category: "host_cache",
      disposition: "omit",
      path,
    });
  }
  if (input.kind === "directory") {
    return Object.freeze({ disposition: "directory", path });
  }
  if (input.kind !== "file") {
    throw new SnapshotPolicyError(
      `unsupported_${input.kind}`,
      "snapshot refuses symlink, junction, submodule, socket, device, and special entries",
    );
  }
  return Object.freeze({ disposition: "include", path });
}
