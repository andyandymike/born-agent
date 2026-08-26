import { canonicalJson } from "../../completion/canonical-json.js";
import { parseStrictJson } from "../../system/strict-json.js";
import { Ml1MemoryError } from "./ml1-memory-error.js";
import {
  ML1_EPISODE_MAX_BYTES,
  ml1EpisodeRecordV1Schema,
  type Ml1EpisodeRecordV1,
} from "./ml1-episode-record.js";

// MEMORY-ML1: 持久化边界必须重新 strict decode，不能信任 SQL 列或普通 JSON.parse。
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

export function encodeMl1EpisodeRecord(record: Ml1EpisodeRecordV1): Buffer {
  let parsed: Ml1EpisodeRecordV1;
  try {
    parsed = ml1EpisodeRecordV1Schema.parse(record);
  } catch (error) {
    throw new Ml1MemoryError("memory_record_invalid", "episode record is invalid", { cause: error });
  }
  const bytes = Buffer.from(canonicalJson(parsed), "utf8");
  if (bytes.byteLength > ML1_EPISODE_MAX_BYTES) {
    throw new Ml1MemoryError("memory_record_too_large", "episode record exceeds its hard byte bound");
  }
  return bytes;
}

export function decodeMl1EpisodeRecord(bytes: Uint8Array): Ml1EpisodeRecordV1 {
  if (bytes.byteLength <= 0 || bytes.byteLength > ML1_EPISODE_MAX_BYTES) {
    throw new Ml1MemoryError("memory_store_corrupt", "stored episode byte bound is invalid");
  }
  try {
    const source = STRICT_UTF8.decode(bytes);
    const value = ml1EpisodeRecordV1Schema.parse(parseStrictJson(source));
    if (canonicalJson(value) !== source) {
      throw new Error("stored episode is not canonical JSON");
    }
    return value;
  } catch (error) {
    if (error instanceof Ml1MemoryError) throw error;
    throw new Ml1MemoryError("memory_store_corrupt", "stored episode failed strict decoding", { cause: error });
  }
}
