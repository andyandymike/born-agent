import type { RuntimePolicyProfileV1 } from "./runtime-policy-schema.js";
import { RuntimePolicyError } from "./policy-errors.js";

export type RuntimePolicyProfileSource =
  | "built_in"
  | "user_default_path"
  | "explicit_user_path";

export interface RuntimePolicyRegistryEntry {
  readonly profile: RuntimePolicyProfileV1;
  readonly profileSha256: string;
  readonly source: RuntimePolicyProfileSource;
}

export class RuntimePolicyProfileRegistry {
  readonly #entries: ReadonlyMap<string, RuntimePolicyRegistryEntry>;

  constructor(entries: readonly RuntimePolicyRegistryEntry[]) {
    const map = new Map<string, RuntimePolicyRegistryEntry>();
    for (const entry of entries) {
      if (map.has(entry.profile.id)) {
        throw new RuntimePolicyError(
          "policy_profile_duplicate",
          `runtime policy profile ${entry.profile.id} is duplicated`,
        );
      }
      map.set(entry.profile.id, Object.freeze(entry));
    }
    this.#entries = map;
  }

  get(id: string): RuntimePolicyRegistryEntry | undefined {
    return this.#entries.get(id);
  }

  list(): readonly RuntimePolicyRegistryEntry[] {
    return Object.freeze([...this.#entries.values()].sort((left, right) =>
      left.profile.id.localeCompare(right.profile.id)));
  }
}
