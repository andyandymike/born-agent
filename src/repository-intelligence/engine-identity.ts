import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";
import { repositoryLanguageHint } from "./repository-language.js";
import { sha256Schema } from "./navigation-types.js";

export const languageCapabilitySchema = z
  .object({
    definitions: z.enum(["semantic", "syntactic", "textual_fallback", "unsupported"]),
    imports: z.enum(["semantic", "syntactic", "unsupported"]),
    language: z.string().min(1).max(64),
    references: z.enum(["semantic", "syntactic", "textual_fallback", "unsupported"]),
  })
  .strict();

export const repositoryEngineIdentityV1Schema = z
  .object({
    adapterVersion: z.string().min(1).max(128),
    configSha256: sha256Schema,
    engineKind: z.enum(["tree_sitter", "language_service", "lsp", "hybrid"]),
    engineVersion: z.string().min(1).max(128),
    identitySha256: sha256Schema,
    indexSchemaVersion: z.literal(1),
    languageCapabilities: z.array(languageCapabilitySchema).min(1),
    normalizationVersion: z.string().min(1).max(128),
    runtimeAssetsSha256: sha256Schema,
    schemaVersion: z.literal(1),
  })
  .strict()
  .superRefine((value, context) => {
    const unsigned = {
      adapterVersion: value.adapterVersion,
      configSha256: value.configSha256,
      engineKind: value.engineKind,
      engineVersion: value.engineVersion,
      indexSchemaVersion: value.indexSchemaVersion,
      languageCapabilities: value.languageCapabilities,
      normalizationVersion: value.normalizationVersion,
      runtimeAssetsSha256: value.runtimeAssetsSha256,
      schemaVersion: value.schemaVersion,
    };
    if (sha256Canonical(unsigned) !== value.identitySha256) {
      context.addIssue({ code: "custom", message: "engine identity hash mismatch" });
    }
    const languages = value.languageCapabilities.map((entry) => entry.language);
    if (new Set(languages).size !== languages.length || [...languages].sort().some((entry, index) => entry !== languages[index])) {
      context.addIssue({ code: "custom", message: "language capabilities must be unique and sorted" });
    }
  });

export type RepositoryEngineIdentityV1 = Readonly<z.infer<typeof repositoryEngineIdentityV1Schema>>;

export const TYPESCRIPT_ENGINE_ASSET = Object.freeze({
  integrity: "sha512-y2TvuxSZPDyQakkFRPZHKFm+KKVqIisdg9/CZwm9ftvKXLP8NRWj38/ODjNbr43SsoXqNuAisEf1GdCxqWcdBw==",
  package: "typescript",
  version: "6.0.3",
});

export const TYPESCRIPT_ENGINE_CONFIG = Object.freeze({
  allowJs: true,
  allowRepositoryCompilerConfig: false,
  allowRepositoryPlugins: false,
  checkJs: true,
  maxSourceBytes: 512 * 1024 * 1024,
  noLib: true,
  resolvePackageJsonExports: false,
  resolvePackageJsonImports: false,
  runtimeNetwork: false,
});

export function createTypeScriptEngineIdentity(): RepositoryEngineIdentityV1 {
  const languageCapabilities = Object.freeze([
    Object.freeze({ definitions: "semantic" as const, imports: "semantic" as const, language: "javascript", references: "semantic" as const }),
    Object.freeze({ definitions: "semantic" as const, imports: "semantic" as const, language: "typescript", references: "semantic" as const }),
    Object.freeze({ definitions: "textual_fallback" as const, imports: "unsupported" as const, language: "unknown", references: "textual_fallback" as const }),
  ]);
  const unsigned = {
    adapterVersion: "bornagent-typescript-adapter-v2",
    configSha256: sha256Canonical(TYPESCRIPT_ENGINE_CONFIG),
    engineKind: "language_service" as const,
    engineVersion: TYPESCRIPT_ENGINE_ASSET.version,
    indexSchemaVersion: 1 as const,
    languageCapabilities,
    normalizationVersion: "repository-navigation-normalization-v1",
    runtimeAssetsSha256: sha256Canonical(TYPESCRIPT_ENGINE_ASSET),
    schemaVersion: 1 as const,
  };
  return repositoryEngineIdentityV1Schema.parse({ ...unsigned, identitySha256: sha256Canonical(unsigned) });
}

export function capabilityForPath(identity: RepositoryEngineIdentityV1, path: string) {
  const language = repositoryLanguageHint(path);
  return identity.languageCapabilities.find((entry) => entry.language === language) ??
    identity.languageCapabilities.find((entry) => entry.language === "unknown")!;
}
