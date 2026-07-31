import {
  parseStrictJson as parseSystemStrictJson,
  StrictJsonError,
} from "../system/strict-json.js";
import { RuntimePolicyError } from "./policy-errors.js";

export function parseStrictJson(source: string): unknown {
  try {
    return parseSystemStrictJson(source);
  } catch (error) {
    if (error instanceof StrictJsonError) {
      throw new RuntimePolicyError(
        "policy_config_invalid",
        error.message,
        2,
        { cause: error },
      );
    }
    throw error;
  }
}
