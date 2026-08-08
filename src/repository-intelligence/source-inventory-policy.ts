import { sha256Canonical } from "../completion/canonical-json.js";

export interface SourceInventoryBounds {
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly maxParseBytes: number;
  readonly maxRelativePathBytes: number;
}

export interface SourceInventoryPolicy {
  readonly bounds: SourceInventoryBounds;
  readonly ignoredDirectoryNames: readonly string[];
  readonly policyVersion: 1;
}

export const DEFAULT_SOURCE_INVENTORY_BOUNDS: SourceInventoryBounds = Object.freeze({
  maxFileBytes: 2 * 1024 * 1024,
  maxFiles: 50_000,
  maxParseBytes: 512 * 1024 * 1024,
  maxRelativePathBytes: 4 * 1024,
});

export const HARD_SOURCE_INVENTORY_BOUNDS: SourceInventoryBounds = Object.freeze({
  maxFileBytes: 8 * 1024 * 1024,
  maxFiles: 200_000,
  maxParseBytes: 4 * 1024 * 1024 * 1024,
  maxRelativePathBytes: 4 * 1024,
});

export const DEFAULT_IGNORED_DIRECTORY_NAMES = Object.freeze([
  ".bornagent",
  ".git",
  ".hg",
  ".svn",
  ".agents",
  ".codex",
  ".next",
  ".nuxt",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
] as const);

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function createSourceInventoryPolicy(
  bounds: Partial<SourceInventoryBounds> = {},
): SourceInventoryPolicy {
  const resolved = Object.freeze({
    ...DEFAULT_SOURCE_INVENTORY_BOUNDS,
    ...bounds,
  });
  for (const [name, value] of Object.entries(resolved)) {
    if (!positiveSafeInteger(value)) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  if (
    resolved.maxFileBytes > HARD_SOURCE_INVENTORY_BOUNDS.maxFileBytes ||
    resolved.maxFiles > HARD_SOURCE_INVENTORY_BOUNDS.maxFiles ||
    resolved.maxParseBytes > HARD_SOURCE_INVENTORY_BOUNDS.maxParseBytes ||
    resolved.maxRelativePathBytes > HARD_SOURCE_INVENTORY_BOUNDS.maxRelativePathBytes
  ) {
    throw new RangeError("repository inventory bounds exceed the hard safety limit");
  }
  return Object.freeze({
    bounds: resolved,
    ignoredDirectoryNames: DEFAULT_IGNORED_DIRECTORY_NAMES,
    policyVersion: 1 as const,
  });
}

export function sourceInventoryPolicySha256(policy: SourceInventoryPolicy): string {
  return sha256Canonical(policy);
}
