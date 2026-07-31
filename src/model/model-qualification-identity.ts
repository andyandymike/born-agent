import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";

const stableId = z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/u);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

const endpointScopeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("literal_loopback"),
      origin: z.string().refine((value) => {
        try {
          const url = new URL(value);
          return (
            url.protocol === "http:" &&
            (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
            url.username === "" &&
            url.password === "" &&
            url.pathname === "/" &&
            url.search === "" &&
            url.hash === ""
          );
        } catch {
          return false;
        }
      }, "literal loopback origin is invalid"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("remote_explicit"),
      originSha256: sha256,
    })
    .strict(),
]);

const runtimeIdentitySchema = z.discriminatedUnion("kind", [
  z
    .object({
      fixtureVersion: z.string().min(1).max(128),
      kind: z.literal("fake_fixture"),
    })
    .strict(),
  z
    .object({
      digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
      kind: z.literal("ollama_digest"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("provider_model_id"),
      value: z.string().min(1).max(512),
    })
    .strict(),
]);

export const modelQualificationIdentitySchema = z
  .object({
    adapterId: stableId,
    adapterVersion: z.string().min(1).max(128),
    continuationCodecVersion: z.string().min(1).max(128).nullable(),
    endpointScope: endpointScopeSchema,
    model: z.string().min(1).max(512),
    modelRuntimeIdentity: runtimeIdentitySchema,
    policyProfileId: stableId,
    policyProfileSha256: sha256,
    probeSuiteVersion: z.string().min(1).max(128),
    probeToolSchemaSha256: sha256,
    provider: stableId,
  })
  .strict();

export type ModelQualificationIdentity = Readonly<
  z.infer<typeof modelQualificationIdentitySchema>
>;

export function modelQualificationIdentitySha256(
  identity: ModelQualificationIdentity,
): string {
  return sha256Canonical(modelQualificationIdentitySchema.parse(identity));
}
