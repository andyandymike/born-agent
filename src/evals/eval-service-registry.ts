import { z } from "zod";

import { sha256Canonical } from "../completion/canonical-json.js";
import { EvalCoreError } from "./eval-errors.js";

export const evalServiceModeSchema = z.enum([
  "normal",
  "crash_before_result",
  "result_then_exit",
  "hang_after_start",
]);

export const evalServiceRefSchema = z
  .object({
    ref: z.literal("mcp_stdio_fixture"),
    fixture_id: z.string().regex(/^[a-z0-9][a-z0-9-]*-v[1-9][0-9]*$/u),
    mode: evalServiceModeSchema,
  })
  .strict();

export type EvalServiceRef = z.infer<typeof evalServiceRefSchema>;
export type EvalServiceMode = z.infer<typeof evalServiceModeSchema>;

export interface EvalServiceDefinition {
  readonly ref: "mcp_stdio_fixture";
  readonly fixtureId: string;
  readonly registryVersion: number;
  readonly fixtureVersion: number;
  readonly supportedModes: readonly EvalServiceMode[];
  readonly implementationSha256: string;
}

export interface ResolvedEvalService {
  readonly ref: "mcp_stdio_fixture";
  readonly fixtureId: string;
  readonly mode: EvalServiceMode;
  readonly registryVersion: number;
  readonly fixtureVersion: number;
  readonly implementationSha256: string;
  readonly resolutionSha256: string;
}

const SHA256 = /^[a-f0-9]{64}$/u;

function serviceKey(ref: EvalServiceRef): string {
  return `${ref.ref}:${ref.fixture_id}:${ref.mode}`;
}

export class EvalServiceRegistry {
  readonly #definitions: ReadonlyMap<string, EvalServiceDefinition>;

  public constructor(definitions: readonly EvalServiceDefinition[]) {
    const entries = new Map<string, EvalServiceDefinition>();
    for (const definition of definitions) {
      if (
        definition.ref !== "mcp_stdio_fixture" ||
        !/^[a-z0-9][a-z0-9-]*-v[1-9][0-9]*$/u.test(definition.fixtureId) ||
        !Number.isSafeInteger(definition.registryVersion) ||
        definition.registryVersion < 1 ||
        !Number.isSafeInteger(definition.fixtureVersion) ||
        definition.fixtureVersion < 1 ||
        !SHA256.test(definition.implementationSha256) ||
        definition.supportedModes.length === 0
      ) {
        throw new EvalCoreError("eval_harness_invariant", "invalid checked-in eval service definition", 1);
      }
      for (const mode of definition.supportedModes) {
        const key = serviceKey({ ref: definition.ref, fixture_id: definition.fixtureId, mode });
        if (entries.has(key)) {
          throw new EvalCoreError("eval_harness_invariant", `duplicate eval service registry key: ${key}`, 1);
        }
        entries.set(key, Object.freeze({ ...definition, supportedModes: Object.freeze([...definition.supportedModes]) }));
      }
    }
    this.#definitions = entries;
  }

  public resolve(input: unknown): ResolvedEvalService {
    const parsed = evalServiceRefSchema.safeParse(input);
    if (!parsed.success) {
      throw new EvalCoreError("eval_scenario_invalid", "invalid eval service reference", 1, {
        cause: parsed.error,
      });
    }
    const definition = this.#definitions.get(serviceKey(parsed.data));
    if (definition === undefined) {
      throw new EvalCoreError(
        "eval_service_unknown",
        `unknown checked-in eval service: ${serviceKey(parsed.data)}`,
        1,
      );
    }
    // PHASE14: manifests name a pinned fixture ID/mode; accepting commands here would turn a test task into a process launcher.
    const resolution = {
      ref: definition.ref,
      fixtureId: definition.fixtureId,
      mode: parsed.data.mode,
      registryVersion: definition.registryVersion,
      fixtureVersion: definition.fixtureVersion,
      implementationSha256: definition.implementationSha256,
    } as const;
    return Object.freeze({ ...resolution, resolutionSha256: sha256Canonical(resolution) });
  }

  public resolveSet(inputs: readonly unknown[]): {
    readonly services: readonly ResolvedEvalService[];
    readonly serviceSetSha256: string;
  } {
    const services = inputs.map((input) => this.resolve(input));
    const keys = services.map((entry) => `${entry.ref}:${entry.fixtureId}:${entry.mode}`);
    if (new Set(keys).size !== keys.length) {
      throw new EvalCoreError("eval_scenario_invalid", "duplicate eval service reference", 1);
    }
    const sorted = [...services].sort((left, right) =>
      `${left.ref}:${left.fixtureId}:${left.mode}`.localeCompare(`${right.ref}:${right.fixtureId}:${right.mode}`),
    );
    return Object.freeze({
      services: Object.freeze(sorted),
      serviceSetSha256: sha256Canonical(sorted),
    });
  }
}
