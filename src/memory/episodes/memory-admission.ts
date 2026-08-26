export type Ml1MemoryAdmissionResult =
  | Readonly<{ admitted: true }>
  | Readonly<{
      admitted: false;
      reason: "known_secret" | "non_persistable" | "private_key" | "raw_environment";
    }>;

const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/iu;
const KNOWN_TOKEN = /(?:\bAKIA[A-Z0-9]{16}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bghp_[A-Za-z0-9]{20,}\b|\bsk-[A-Za-z0-9_-]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b)/u;
const SECRET_ASSIGNMENT = /\b(?:authorization|cookie|password|passwd|api[_-]?key|client[_-]?secret|access[_-]?token|credential)\b\s*[:=]\s*\S+/iu;
const ENV_ASSIGNMENT = /^(?:export\s+)?[A-Z_][A-Z0-9_]{0,127}=\S+/u;

export function inspectMemoryAdmission(values: readonly string[]): Ml1MemoryAdmissionResult {
  const joined = values.join("\n");
  if (/\bnon[-_ ]persistable\b/iu.test(joined)) {
    return Object.freeze({ admitted: false, reason: "non_persistable" });
  }
  if (PRIVATE_KEY.test(joined)) {
    return Object.freeze({ admitted: false, reason: "private_key" });
  }
  if (KNOWN_TOKEN.test(joined) || SECRET_ASSIGNMENT.test(joined)) {
    return Object.freeze({ admitted: false, reason: "known_secret" });
  }
  const environmentLines = joined.split(/\r?\n/u).filter((line) => ENV_ASSIGNMENT.test(line.trim()));
  if (environmentLines.length >= 3) {
    return Object.freeze({ admitted: false, reason: "raw_environment" });
  }
  return Object.freeze({ admitted: true });
}

/** Backward-compatible ML1 name; ML4 applies the same scanner to every canonical record. */
export const inspectMl1MemoryAdmission = inspectMemoryAdmission;
