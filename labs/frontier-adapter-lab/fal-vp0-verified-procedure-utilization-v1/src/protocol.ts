import { createHash } from "node:crypto";

import { z } from "zod";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";

export const FAL_VP0_EXPERIMENT_ID =
  "fal-vp0-verified-procedure-utilization-v1" as const;
export const FAL_VP0_FIXTURE_DIRECTORY =
  "fixtures/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1" as const;
export const FAL_VP0_LAB_DIRECTORY =
  "labs/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1" as const;
export const FAL_VP0_HOST_FACT_EVALUATOR = "fal-vp0-host-facts-v1" as const;
export const FAL_VP0_PAYLOAD_TOKEN_LIMIT = 800 as const;
export const FAL_VP0_CONTEXT_TOKEN_LIMIT = 1_800 as const;

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const commitSchema = z.string().regex(/^[a-f0-9]{40,64}$/u);
export const identifierSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
export const safeIntegerSchema = z.number().int().safe();
export const nonnegativeIntegerSchema = safeIntegerSchema.nonnegative();

export function boundedNfcText(maximumUtf8Bytes: number): z.ZodString {
  return z.string()
    .min(1)
    .refine((value) => value === value.normalize("NFC"), "text must be NFC")
    .refine((value) => !value.includes("\0"), "text cannot contain NUL")
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= maximumUtf8Bytes,
      `text exceeds ${String(maximumUtf8Bytes)} UTF-8 bytes`,
    );
}

export const relativeArtifactRefSchema = z.string()
  .min(1)
  .max(512)
  .refine((value) => value === value.normalize("NFC"), "artifact ref must be NFC")
  .refine((value) =>
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/u.test(value) &&
    !value.split("/").some((part) => part === "" || part === "." || part === ".."), {
      message: "artifact refs must be normalized relative paths",
    });

export const hostFactValueSchema = z.union([
  z.null(),
  z.boolean(),
  safeIntegerSchema,
  boundedNfcText(1_024),
]);

export function rawSha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isUtf8Boundary(bytes: Uint8Array, offset: number): boolean {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.byteLength) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
    return true;
  } catch {
    return false;
  }
}

export function isStrictlySortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) =>
    index === 0 || (values[index - 1]?.localeCompare(value) ?? -1) < 0);
}

export function logicalIdentity<T extends Readonly<Record<string, unknown>>>(
  value: T,
  hashField: keyof T,
): string {
  const content = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== hashField),
  );
  return sha256Canonical(content);
}
