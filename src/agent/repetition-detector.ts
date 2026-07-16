import { createHash } from "node:crypto";

function canonicalJson(value: unknown): string {
  // PHASE4: 递归排序 object keys，让语义相同但排版/key 顺序不同的参数得到同一 fingerprint。
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function toolCallFingerprint(
  toolName: string,
  argumentsJson: string,
): string {
  // PHASE4: session 只保存 SHA-256 fingerprint，不复制可能含敏感内容的原始参数作为检测状态。
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    return hash(`${toolName}\n${canonicalJson(parsed)}`);
  } catch {
    return hash(`${toolName}\n${argumentsJson}`);
  }
}

export interface RepetitionObservation {
  readonly blocked: boolean;
  readonly count: number;
  readonly fingerprint: string;
}

export class RepetitionDetector {
  // PHASE4: 只检测“连续”重复；工具名或参数变化就重置，让模型仍有机会修正调用。
  private consecutiveCount = 0;
  private previousFingerprint: string | undefined;

  observe(toolName: string, argumentsJson: string): RepetitionObservation {
    const fingerprint = toolCallFingerprint(toolName, argumentsJson);
    if (fingerprint === this.previousFingerprint) {
      this.consecutiveCount += 1;
    } else {
      this.previousFingerprint = fingerprint;
      this.consecutiveCount = 1;
    }
    return {
      // PHASE4: 前两次允许，第三次在 ToolRegistry executor 之前阻止真实重复工作。
      blocked: this.consecutiveCount >= 3,
      count: this.consecutiveCount,
      fingerprint,
    };
  }
}
