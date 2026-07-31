import {
  canonicalJson,
  sha256Canonical,
} from "../completion/canonical-json.js";
import {
  MAX_CANONICAL_PLAN_BYTES,
  planRevisionContentSchema,
  type PlanRevisionContent,
  type Sha256,
} from "./plan-schema.js";

export interface CanonicalPlanIdentity {
  readonly canonicalJson: string;
  readonly content: PlanRevisionContent;
  readonly sha256: Sha256;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

export function canonicalPlanIdentity(
  input: unknown,
): CanonicalPlanIdentity {
  const content = deepFreeze(
    planRevisionContentSchema.parse(input) as PlanRevisionContent,
  );
  const serialized = canonicalJson(content);
  if (Buffer.byteLength(serialized, "utf8") > MAX_CANONICAL_PLAN_BYTES) {
    throw new RangeError(
      `canonical plan content exceeds ${MAX_CANONICAL_PLAN_BYTES} UTF-8 bytes`,
    );
  }
  return Object.freeze({
    canonicalJson: serialized,
    content,
    sha256: sha256Canonical(content),
  });
}
