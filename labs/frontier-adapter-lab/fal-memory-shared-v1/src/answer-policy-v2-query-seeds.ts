import type { AnswerPolicyV2QuerySeed } from "./answer-policy-v2.js";

// This executor-side projection intentionally contains query wording only. It excludes
// stable values, filtered distractor values, answer atoms, and evidence labels so the
// retrieval worker never needs to load scorer seeds or goldens.
export const developmentAnswerPolicyV2QuerySeeds:
readonly AnswerPolicyV2QuerySeed[] = Object.freeze([
  Object.freeze({
    absentFieldEn: "emergency translation owner",
    absentFieldZh: "紧急翻译负责人",
    stableKeyEn: "catalog load order",
    subjectEn: "Atlas desktop localization",
    subjectZh: "Atlas 桌面端本地化",
  }),
  Object.freeze({
    absentFieldEn: "manual exception approver",
    absentFieldZh: "手工例外审批人",
    stableKeyEn: "generated-file treatment",
    subjectEn: "Basil source-header policy",
    subjectZh: "Basil 源码头部策略",
  }),
  Object.freeze({
    absentFieldEn: "manual SDK release owner",
    absentFieldZh: "SDK 手工发布负责人",
    stableKeyEn: "schema pinning mode",
    subjectEn: "Coral API client generation",
    subjectZh: "Coral API 客户端生成",
  }),
  Object.freeze({
    absentFieldEn: "break-glass root operator",
    absentFieldZh: "紧急 root 操作人",
    stableKeyEn: "writable output path",
    subjectEn: "Denim worker container",
    subjectZh: "Denim Worker 容器",
  }),
  Object.freeze({
    absentFieldEn: "after-hours database caller",
    absentFieldZh: "非工作时间数据库联系人",
    stableKeyEn: "idle timeout",
    subjectEn: "Elm database connection pool",
    subjectZh: "Elm 数据库连接池",
  }),
  Object.freeze({
    absentFieldEn: "manual art override owner",
    absentFieldZh: "美术手工覆盖负责人",
    stableKeyEn: "sampling filter",
    subjectEn: "Fable image import pipeline",
    subjectZh: "Fable 图片导入流水线",
  }),
]);

export const calibrationAnswerPolicyV2QuerySeeds:
readonly AnswerPolicyV2QuerySeed[] = Object.freeze([
  Object.freeze({
    absentFieldEn: "emergency mastering contact",
    absentFieldZh: "紧急母带联系人",
    stableKeyEn: "channel policy",
    subjectEn: "Glacier audio import",
    subjectZh: "Glacier 音频导入",
  }),
  Object.freeze({
    absentFieldEn: "manual flaky-test dispatcher",
    absentFieldZh: "手工不稳定测试调度人",
    stableKeyEn: "allocation key",
    subjectEn: "Hazel test shard allocation",
    subjectZh: "Hazel 测试分片分配",
  }),
  Object.freeze({
    absentFieldEn: "manual schema waiver owner",
    absentFieldZh: "Schema 手工豁免负责人",
    stableKeyEn: "error stream",
    subjectEn: "Ivory CLI output contract",
    subjectZh: "Ivory CLI 输出合同",
  }),
  Object.freeze({
    absentFieldEn: "temporary origin exception owner",
    absentFieldZh: "临时 Origin 例外负责人",
    stableKeyEn: "credential mode",
    subjectEn: "Jade browser origin policy",
    subjectZh: "Jade 浏览器 Origin 策略",
  }),
  Object.freeze({
    absentFieldEn: "emergency certificate custodian",
    absentFieldZh: "紧急证书保管人",
    stableKeyEn: "target architecture",
    subjectEn: "Koala desktop signing",
    subjectZh: "Koala 桌面签名",
  }),
  Object.freeze({
    absentFieldEn: "manual log disclosure approver",
    absentFieldZh: "日志手工披露审批人",
    stableKeyEn: "request identifier treatment",
    subjectEn: "Linen structured logging",
    subjectZh: "Linen 结构化日志",
  }),
]);

export function answerPolicyV2QuerySeedsFor(
  split: "calibration" | "development",
): readonly AnswerPolicyV2QuerySeed[] {
  return split === "development"
    ? developmentAnswerPolicyV2QuerySeeds
    : calibrationAnswerPolicyV2QuerySeeds;
}
