import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const artifactRefSchema = z
  .object({
    artifactId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    bytes: z.number().int().nonnegative().max(64 * 1024),
    relativeRef: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (value) =>
          !value.includes("\\") &&
          !value.startsWith("/") &&
          !value.split("/").some((segment) => segment === "" || segment === "." || segment === ".."),
        "artifact ref must be a safe relative path",
      ),
    sha256: sha256Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.artifactId !== `sha256:${value.sha256}`) {
      context.addIssue({ code: "custom", message: "artifact ID does not match content hash" });
    }
  });

const canonicalRulePathSchema = z
  .string()
  .min(9)
  .max(4096)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.startsWith("/") &&
      value.split("/").at(-1) === "AGENTS.md" &&
      !value.split("/").some((segment) => segment === "" || segment === "." || segment === ".."),
    "repository rule path must be canonical and end in AGENTS.md",
  );

const scopePrefixSchema = z
  .string()
  .max(4096)
  .refine(
    (value) =>
      value === "" ||
      (!value.includes("\\") &&
        !value.startsWith("/") &&
        !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")),
    "scope prefix must be canonical",
  );

export const repositoryRuleEntrySchema = z
  .object({
    artifact: artifactRefSchema,
    contentBytes: z.number().int().nonnegative().max(64 * 1024),
    contentSha256: sha256Schema,
    depth: z.number().int().nonnegative().max(4095),
    relativePath: canonicalRulePathSchema,
    scopePrefix: scopePrefixSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const segments = value.relativePath.split("/");
    const expectedScope = segments.slice(0, -1).join("/");
    if (
      value.scopePrefix !== expectedScope ||
      value.depth !== (expectedScope === "" ? 0 : expectedScope.split("/").length) ||
      value.artifact.bytes !== value.contentBytes ||
      value.artifact.sha256 !== value.contentSha256
    ) {
      context.addIssue({ code: "custom", message: "repository rule entry fields are inconsistent" });
    }
  });

export type RepositoryRuleEntryV1 = Readonly<z.infer<typeof repositoryRuleEntrySchema>>;

export function repositoryRuleManifestIdentityDescriptor(value: {
  readonly discoveryComplete: true;
  readonly discoveryPolicySha256: string;
  readonly entries: readonly RepositoryRuleEntryV1[];
  readonly schemaVersion: 1;
  readonly sourceStateSha256: string;
}) {
  return {
    discoveryComplete: value.discoveryComplete,
    discoveryPolicySha256: value.discoveryPolicySha256,
    entries: value.entries.map((entry) => ({
      artifact: {
        artifactId: entry.artifact.artifactId,
        bytes: entry.artifact.bytes,
        sha256: entry.artifact.sha256,
      },
      contentBytes: entry.contentBytes,
      contentSha256: entry.contentSha256,
      depth: entry.depth,
      relativePath: entry.relativePath,
      scopePrefix: entry.scopePrefix,
    })),
    schemaVersion: value.schemaVersion,
    sourceStateSha256: value.sourceStateSha256,
  } as const;
}

export const repositoryRuleManifestSchema = z
  .object({
    discoveryComplete: z.literal(true),
    discoveryPolicySha256: sha256Schema,
    entries: z.array(repositoryRuleEntrySchema).max(4096),
    manifestSha256: sha256Schema,
    schemaVersion: z.literal(1),
    sourceStateSha256: sha256Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const sorted = [...value.entries].sort(
      (left, right) => left.depth - right.depth || (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0),
    );
    if (sorted.some((entry, index) => entry.relativePath !== value.entries[index]?.relativePath)) {
      context.addIssue({ code: "custom", message: "repository rule entries are not canonically sorted" });
    }
    const lowerPaths = value.entries.map((entry) => entry.relativePath.toLowerCase());
    const lowerScopes = value.entries.map((entry) => entry.scopePrefix.toLowerCase());
    if (new Set(lowerPaths).size !== lowerPaths.length || new Set(lowerScopes).size !== lowerScopes.length) {
      context.addIssue({ code: "custom", message: "repository rule paths/scopes must be unique" });
    }
    // PHASE17: session-local object refs are transport locations, not repository-rule facts.
    // The manifest identity binds exact content/artifact hashes while remaining stable across runs.
    const unsigned = repositoryRuleManifestIdentityDescriptor(value);
    if (sha256Canonical(unsigned) !== value.manifestSha256) {
      context.addIssue({ code: "custom", message: "repository rule manifest hash mismatch" });
    }
  });

export type RepositoryRuleManifestV1 = Readonly<z.infer<typeof repositoryRuleManifestSchema>>;
