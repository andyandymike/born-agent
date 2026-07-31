import { z } from "zod";

export const adapterCapabilityDeclarationSchema = z
  .object({
    adapterId: z.string().min(1).max(128),
    adapterVersion: z.string().min(1).max(128),
    continuationCodecVersion: z.string().min(1).max(128).nullable(),
    provider: z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/u),
    schemaVersion: z.literal(1),
    supports: z
      .object({
        cancellation: z.enum(["abort_signal", "none"]),
        sequentialToolCalls: z.boolean(),
        streamingText: z.boolean(),
        strictTools: z.boolean(),
        toolContinuation: z.boolean(),
        usage: z.enum(["complete", "partial", "unavailable"]),
      })
      .strict(),
  })
  .strict();

export type AdapterCapabilityDeclaration = Readonly<
  z.infer<typeof adapterCapabilityDeclarationSchema>
>;

export function assertModeDeclared(
  declaration: AdapterCapabilityDeclaration,
  mode: "plan" | "build",
): void {
  const required = [
    declaration.supports.streamingText,
    declaration.supports.strictTools,
    declaration.supports.toolContinuation,
    declaration.supports.cancellation === "abort_signal",
    mode === "plan" || declaration.supports.sequentialToolCalls,
  ];
  if (required.some((supported) => !supported)) {
    throw new Error(`adapter declaration does not support ${mode} qualification`);
  }
}
