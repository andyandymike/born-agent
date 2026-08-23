import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const DEFAULT_MANIFEST = "tests/evidence/architecture-simplification-v1.json";
const HEX_256 = /^[a-f0-9]{64}$/u;
const ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const PLATFORM_VALUES = new Set(["linux", "win32"]);
const PROFILE_VALUES = new Set(["default", "built_paths", "pack", "metric"]);
const RUNNER_VALUES = new Set(["vitest", "dependency", "build", "pack", "metric"]);
const CASE_STATUS_VALUES = new Set(["passed", "failed", "skipped", "missing"]);

export class ArchitectureEvidenceError extends Error {
  constructor(code, message, options) {
    super(`${code}: ${message}`, options);
    this.code = code;
    this.name = "ArchitectureEvidenceError";
  }
}

class StrictJsonParser {
  #index = 0;

  constructor(source) {
    this.source = source;
  }

  parse() {
    if (this.source.charCodeAt(0) === 0xfeff) this.fail("UTF-8 BOM is not allowed");
    const value = this.value(0);
    this.whitespace();
    if (this.#index !== this.source.length) this.fail("trailing bytes after JSON value");
    return value;
  }

  value(depth) {
    if (depth > 64) this.fail("JSON nesting exceeds 64 levels");
    this.whitespace();
    const token = this.source[this.#index];
    if (token === "{") return this.object(depth + 1);
    if (token === "[") return this.array(depth + 1);
    if (token === '"') return this.string();
    if (token === "t") return this.literal("true", true);
    if (token === "f") return this.literal("false", false);
    if (token === "n") return this.literal("null", null);
    if (token === "-" || (token !== undefined && /[0-9]/u.test(token))) return this.number();
    this.fail("expected a JSON value");
  }

  object(depth) {
    this.#index += 1;
    const result = {};
    const keys = new Set();
    this.whitespace();
    if (this.source[this.#index] === "}") {
      this.#index += 1;
      return result;
    }
    for (;;) {
      this.whitespace();
      if (this.source[this.#index] !== '"') this.fail("object key must be a string");
      const key = this.string();
      if (keys.has(key)) this.fail(`duplicate object key ${JSON.stringify(key)}`);
      keys.add(key);
      this.whitespace();
      if (this.source[this.#index] !== ":") this.fail("expected ':' after object key");
      this.#index += 1;
      result[key] = this.value(depth);
      this.whitespace();
      const separator = this.source[this.#index];
      if (separator === "}") {
        this.#index += 1;
        return result;
      }
      if (separator !== ",") this.fail("expected ',' or '}' in object");
      this.#index += 1;
    }
  }

  array(depth) {
    this.#index += 1;
    const result = [];
    this.whitespace();
    if (this.source[this.#index] === "]") {
      this.#index += 1;
      return result;
    }
    for (;;) {
      result.push(this.value(depth));
      this.whitespace();
      const separator = this.source[this.#index];
      if (separator === "]") {
        this.#index += 1;
        return result;
      }
      if (separator !== ",") this.fail("expected ',' or ']' in array");
      this.#index += 1;
    }
  }

  string() {
    const start = this.#index;
    this.#index += 1;
    let escaped = false;
    while (this.#index < this.source.length) {
      const character = this.source[this.#index];
      if (!escaped && character === '"') {
        this.#index += 1;
        try {
          return JSON.parse(this.source.slice(start, this.#index));
        } catch {
          this.fail("invalid JSON string");
        }
      }
      if (!escaped && character !== undefined && character.charCodeAt(0) < 0x20) {
        this.fail("unescaped control character in string");
      }
      escaped = !escaped && character === "\\";
      if (character !== "\\") escaped = false;
      this.#index += 1;
    }
    this.fail("unterminated JSON string");
  }

  number() {
    const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/uy;
    match.lastIndex = this.#index;
    const found = match.exec(this.source)?.[0];
    if (found === undefined) this.fail("invalid JSON number");
    this.#index += found.length;
    const value = Number(found);
    if (!Number.isFinite(value)) this.fail("JSON number must be finite");
    return value;
  }

  literal(source, value) {
    if (!this.source.startsWith(source, this.#index)) this.fail(`expected ${source}`);
    this.#index += source.length;
    return value;
  }

  whitespace() {
    while (/[ \t\r\n]/u.test(this.source[this.#index] ?? "")) this.#index += 1;
  }

  fail(message) {
    throw new ArchitectureEvidenceError(
      "strict_json_invalid",
      `${message} at byte-like character offset ${String(this.#index)}`,
    );
  }
}

export function parseStrictJson(source) {
  if (typeof source !== "string") {
    throw new ArchitectureEvidenceError("strict_json_invalid", "JSON source must be a string");
  }
  return new StrictJsonParser(source).parse();
}

function fail(code, message, options) {
  throw new ArchitectureEvidenceError(code, message, options);
}

function record(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("evidence_schema_invalid", `${label} must be an object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail("evidence_schema_invalid", `${label} has unknown fields: ${unknown.sort().join(", ")}`);
  }
}

function string(value, label, maximum = 1_024) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    fail("evidence_schema_invalid", `${label} must be a non-empty bounded string`);
  }
  return value;
}

function identifier(value, label) {
  const parsed = string(value, label, 128);
  if (!ID.test(parsed)) fail("evidence_schema_invalid", `${label} is not a stable identifier`);
  return parsed;
}

function boolean(value, label) {
  if (typeof value !== "boolean") fail("evidence_schema_invalid", `${label} must be a boolean`);
  return value;
}

function integer(value, label) {
  if (!Number.isSafeInteger(value)) fail("evidence_schema_invalid", `${label} must be a safe integer`);
  return value;
}

function stringArray(value, label, allowed) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("evidence_schema_invalid", `${label} must be a non-empty array`);
  }
  const parsed = value.map((item, index) => string(item, `${label}[${String(index)}]`, 128));
  if (new Set(parsed).size !== parsed.length) fail("evidence_schema_invalid", `${label} contains duplicates`);
  if (allowed !== undefined && parsed.some((item) => !allowed.has(item))) {
    fail("evidence_schema_invalid", `${label} contains an unsupported value`);
  }
  return Object.freeze(parsed);
}

function safeRepositoryPath(value, label) {
  const parsed = string(value, label, 512);
  if (
    parsed.includes("\\") || parsed.startsWith("/") || /^[A-Za-z]:/u.test(parsed) ||
    parsed.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail("evidence_schema_invalid", `${label} must be a safe repository-relative POSIX path`);
  }
  return parsed;
}

function parseManifestCase(value, index) {
  const item = record(value, `manifest.cases[${String(index)}]`);
  exactKeys(item, new Set([
    "blocking", "file", "fullName", "id", "invariant", "platforms", "profiles", "runner", "workPackage",
  ]), `manifest.cases[${String(index)}]`);
  const runner = string(item.runner, `manifest.cases[${String(index)}].runner`, 32);
  if (!RUNNER_VALUES.has(runner)) fail("evidence_schema_invalid", `unsupported runner ${runner}`);
  const parsed = {
    blocking: boolean(item.blocking, `manifest.cases[${String(index)}].blocking`),
    id: identifier(item.id, `manifest.cases[${String(index)}].id`),
    invariant: string(item.invariant, `manifest.cases[${String(index)}].invariant`, 512),
    platforms: stringArray(item.platforms, `manifest.cases[${String(index)}].platforms`, PLATFORM_VALUES),
    profiles: stringArray(item.profiles, `manifest.cases[${String(index)}].profiles`, PROFILE_VALUES),
    runner,
    workPackage: string(item.workPackage, `manifest.cases[${String(index)}].workPackage`, 32),
  };
  if (!/^AS[0-6](?:\.[0-9]+)?$/u.test(parsed.workPackage)) {
    fail("evidence_schema_invalid", `manifest case ${parsed.id} has an invalid work package`);
  }
  if (runner === "vitest") {
    parsed.file = safeRepositoryPath(item.file, `manifest case ${parsed.id}.file`);
    parsed.fullName = string(item.fullName, `manifest case ${parsed.id}.fullName`, 2_048);
  } else if (item.file !== undefined || item.fullName !== undefined) {
    fail("evidence_schema_invalid", `non-Vitest case ${parsed.id} cannot carry a test selector`);
  }
  return Object.freeze(parsed);
}

export function parseEvidenceManifest(source) {
  const value = record(parseStrictJson(source), "manifest");
  exactKeys(value, new Set(["cases", "manifestId", "schemaVersion"]), "manifest");
  if (value.schemaVersion !== 1) fail("evidence_schema_invalid", "manifest.schemaVersion must equal 1");
  const manifestId = identifier(value.manifestId, "manifest.manifestId");
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    fail("evidence_schema_invalid", "manifest.cases must be a non-empty array");
  }
  const cases = Object.freeze(value.cases.map(parseManifestCase));
  const ids = new Set();
  const selectors = new Set();
  for (const item of cases) {
    if (ids.has(item.id)) fail("evidence_duplicate_id", `manifest repeats evidence id ${item.id}`);
    ids.add(item.id);
    if (item.runner === "vitest") {
      const selector = `${item.file}\0${item.fullName}`;
      if (selectors.has(selector)) {
        fail("evidence_duplicate_selector", `manifest assigns more than one id to ${item.file} :: ${item.fullName}`);
      }
      selectors.add(selector);
    }
  }
  return Object.freeze({ cases, manifestId, schemaVersion: 1 });
}

export function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function normalizeTestFile(name, workspaceRoot) {
  const supplied = string(name, "Vitest result file name", 4_096);
  const absolute = isAbsolute(supplied) ? resolve(supplied) : resolve(workspaceRoot, supplied);
  const delta = relative(workspaceRoot, absolute);
  if (delta === "" || delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) {
    fail("evidence_report_invalid", `Vitest result escapes the workspace: ${supplied}`);
  }
  return delta.split(sep).join("/");
}

function normalizeVitestReport(document, workspaceRoot) {
  const value = record(parseStrictJson(document.source), `Vitest report ${document.path}`);
  if (!Array.isArray(value.testResults) || typeof value.success !== "boolean") {
    fail("evidence_report_invalid", `Vitest report ${document.path} has no bounded result set`);
  }
  const results = [];
  for (const [suiteIndex, suiteValue] of value.testResults.entries()) {
    const suite = record(suiteValue, `Vitest report suite ${String(suiteIndex)}`);
    const file = normalizeTestFile(suite.name, workspaceRoot);
    if (!Array.isArray(suite.assertionResults)) {
      fail("evidence_report_invalid", `Vitest suite ${file} has no assertion results`);
    }
    for (const [assertionIndex, assertionValue] of suite.assertionResults.entries()) {
      const assertion = record(assertionValue, `Vitest assertion ${String(assertionIndex)}`);
      const fullName = string(assertion.fullName, `Vitest assertion ${String(assertionIndex)}.fullName`, 2_048);
      const rawStatus = string(assertion.status, `Vitest assertion ${fullName}.status`, 32);
      const status = rawStatus === "passed" ? "passed"
        : rawStatus === "failed" ? "failed"
          : ["pending", "skipped", "todo"].includes(rawStatus) ? "skipped"
            : fail("evidence_report_invalid", `Vitest assertion ${fullName} has unknown status ${rawStatus}`);
      results.push(Object.freeze({ file, fullName, status }));
    }
  }
  return Object.freeze({ format: "vitest-json", metrics: Object.freeze({}), results: Object.freeze(results), success: value.success });
}

function normalizeMetrics(value, label) {
  if (value === undefined) return Object.freeze({});
  const metrics = record(value, label);
  const result = {};
  for (const [key, metric] of Object.entries(metrics)) {
    if (!ID.test(key) || typeof metric !== "number" || !Number.isFinite(metric) || metric < 0) {
      fail("evidence_report_invalid", `${label}.${key} must be a finite non-negative metric`);
    }
    result[key] = metric;
  }
  return Object.freeze(result);
}

function normalizeCommandReport(document) {
  const value = record(parseStrictJson(document.source), `command report ${document.path}`);
  exactKeys(value, new Set(["metrics", "reportId", "results", "schemaVersion"]), `command report ${document.path}`);
  if (value.schemaVersion !== 1 || value.reportId !== "architecture-command-report-v1" || !Array.isArray(value.results)) {
    fail("evidence_report_invalid", `command report ${document.path} has an invalid identity`);
  }
  const results = value.results.map((resultValue, index) => {
    const result = record(resultValue, `command report result ${String(index)}`);
    exactKeys(result, new Set(["id", "status"]), `command report result ${String(index)}`);
    const status = string(result.status, `command report result ${String(index)}.status`, 32);
    if (!CASE_STATUS_VALUES.has(status) || status === "missing") {
      fail("evidence_report_invalid", `command report result ${String(index)} has an invalid status`);
    }
    return Object.freeze({ id: identifier(result.id, `command report result ${String(index)}.id`), status });
  });
  return Object.freeze({
    format: "architecture-command-json",
    metrics: normalizeMetrics(value.metrics, `command report ${document.path}.metrics`),
    results: Object.freeze(results),
    success: results.every((item) => item.status === "passed"),
  });
}

function normalizeReport(document, workspaceRoot) {
  const parsed = parseStrictJson(document.source);
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && "testResults" in parsed) {
    return normalizeVitestReport(document, workspaceRoot);
  }
  return normalizeCommandReport(document);
}

function normalizeArgv(value, label) {
  if (!Array.isArray(value) || value.length === 0) fail("evidence_schema_invalid", `${label} must be a non-empty argv array`);
  return Object.freeze(value.map((item, index) => string(item, `${label}[${String(index)}]`, 4_096)));
}

function selectedCases(manifest, profile, platform) {
  if (!PROFILE_VALUES.has(profile)) fail("evidence_profile_invalid", `unsupported profile ${profile}`);
  if (!PLATFORM_VALUES.has(platform)) fail("evidence_platform_invalid", `unsupported platform ${platform}`);
  const selected = manifest.cases.filter((item) => item.profiles.includes(profile) && item.platforms.includes(platform));
  if (!selected.some((item) => item.blocking)) {
    fail("evidence_selection_empty", `profile ${profile} has no blocking evidence for ${platform}`);
  }
  return selected;
}

export function evaluateEvidence({ manifest, platform, profile, reportDocuments, workspaceRoot }) {
  const selected = selectedCases(manifest, profile, platform);
  const vitestResults = new Map();
  const commandResults = new Map();
  const metrics = {};
  const normalizedReports = [];
  for (const document of reportDocuments) {
    const normalized = normalizeReport(document, workspaceRoot);
    if (!normalized.success) fail("evidence_runner_failed", `runner report failed: ${document.path}`);
    normalizedReports.push(Object.freeze({
      argv: normalizeArgv(document.argv, `report ${document.path}.argv`),
      exitCode: 0,
      format: normalized.format,
      path: resolve(document.path).split(sep).join("/"),
      sha256: sha256(document.source),
      signal: null,
    }));
    for (const [key, value] of Object.entries(normalized.metrics)) {
      if (Object.hasOwn(metrics, key)) fail("evidence_report_duplicate", `runner metric is not unique: ${key}`);
      metrics[key] = value;
    }
    if (normalized.format === "vitest-json") {
      for (const result of normalized.results) {
        const key = `${result.file}\0${result.fullName}`;
        vitestResults.set(key, vitestResults.has(key) ? "duplicate" : result.status);
      }
    } else {
      for (const result of normalized.results) {
        commandResults.set(result.id, commandResults.has(result.id) ? "duplicate" : result.status);
      }
    }
  }
  const cases = selected.map((item) => {
    const observed = item.runner === "vitest"
      ? vitestResults.get(`${item.file}\0${item.fullName}`) ?? "missing"
      : commandResults.get(item.id) ?? "missing";
    if (observed === "duplicate") {
      fail("evidence_report_duplicate", item.runner === "vitest"
        ? `required Vitest assertion is not unique: ${item.file} :: ${item.fullName}`
        : `required command result is not unique: ${item.id}`);
    }
    return Object.freeze({
      ...(item.file === undefined ? {} : { file: item.file }),
      ...(item.fullName === undefined ? {} : { fullName: item.fullName }),
      id: item.id,
      status: observed,
    });
  }).sort((left, right) => left.id.localeCompare(right.id, "en"));
  const failed = cases.filter((result) => {
    const definition = selected.find((item) => item.id === result.id);
    return definition?.blocking === true && result.status !== "passed";
  });
  if (failed.length > 0) {
    fail("evidence_required_case_failed", failed.map((item) => `${item.id}=${item.status}`).join(", "));
  }
  return Object.freeze({ cases: Object.freeze(cases), metrics: Object.freeze(metrics), reports: Object.freeze(normalizedReports) });
}

function validateDirty(value) {
  if (value === null) return null;
  const item = record(value, "receipt.dirty");
  exactKeys(item, new Set(["patchSha256", "paths"]), "receipt.dirty");
  if (!HEX_256.test(item.patchSha256 ?? "")) fail("evidence_schema_invalid", "receipt dirty patch hash is invalid");
  const paths = stringArray(item.paths, "receipt.dirty.paths").map((path) => safeRepositoryPath(path, "receipt dirty path"));
  return Object.freeze({ patchSha256: item.patchSha256, paths: Object.freeze(paths) });
}

function parseReceiptReport(value, index) {
  const item = record(value, `receipt.reports[${String(index)}]`);
  exactKeys(item, new Set(["argv", "exitCode", "format", "path", "sha256", "signal"]), `receipt.reports[${String(index)}]`);
  const format = string(item.format, `receipt.reports[${String(index)}].format`, 64);
  if (!["vitest-json", "architecture-command-json"].includes(format)) fail("evidence_schema_invalid", "receipt report format is invalid");
  if (!HEX_256.test(item.sha256 ?? "")) fail("evidence_schema_invalid", "receipt report hash is invalid");
  if (item.signal !== null && typeof item.signal !== "string") fail("evidence_schema_invalid", "receipt report signal is invalid");
  return Object.freeze({
    argv: normalizeArgv(item.argv, `receipt.reports[${String(index)}].argv`),
    exitCode: integer(item.exitCode, `receipt.reports[${String(index)}].exitCode`),
    format,
    path: string(item.path, `receipt.reports[${String(index)}].path`, 4_096),
    sha256: item.sha256,
    signal: item.signal,
  });
}

function parseReceiptCase(value, index) {
  const item = record(value, `receipt.cases[${String(index)}]`);
  exactKeys(item, new Set(["file", "fullName", "id", "status"]), `receipt.cases[${String(index)}]`);
  const status = string(item.status, `receipt.cases[${String(index)}].status`, 32);
  if (!CASE_STATUS_VALUES.has(status)) fail("evidence_schema_invalid", "receipt case status is invalid");
  return Object.freeze({
    ...(item.file === undefined ? {} : { file: safeRepositoryPath(item.file, "receipt case file") }),
    ...(item.fullName === undefined ? {} : { fullName: string(item.fullName, "receipt case fullName", 2_048) }),
    id: identifier(item.id, "receipt case id"),
    status,
  });
}

export function parseEvidenceReceipt(source) {
  const value = record(parseStrictJson(source), "receipt");
  exactKeys(value, new Set([
    "arch", "argv", "cases", "commitSha", "dirty", "exitCode", "manifestId", "manifestSha256", "metrics",
    "nodeVersion", "platform", "pnpmVersion", "profile", "receiptId", "reports", "schemaVersion", "signal",
  ]), "receipt");
  if (value.schemaVersion !== 1 || value.receiptId !== "architecture-simplification-receipt-v1") {
    fail("evidence_schema_invalid", "receipt identity is invalid");
  }
  if (!HEX_256.test(value.manifestSha256 ?? "")) fail("evidence_schema_invalid", "receipt manifest hash is invalid");
  if (!/^[a-f0-9]{40,64}$/u.test(value.commitSha ?? "")) fail("evidence_schema_invalid", "receipt commit hash is invalid");
  const platform = string(value.platform, "receipt.platform", 32);
  const profile = string(value.profile, "receipt.profile", 32);
  if (!PLATFORM_VALUES.has(platform) || !PROFILE_VALUES.has(profile)) fail("evidence_schema_invalid", "receipt platform/profile is invalid");
  if (!Array.isArray(value.reports) || value.reports.length === 0 || !Array.isArray(value.cases)) {
    fail("evidence_schema_invalid", "receipt reports/cases are invalid");
  }
  const metrics = record(value.metrics, "receipt.metrics");
  for (const [key, metric] of Object.entries(metrics)) {
    if (!ID.test(key) || typeof metric !== "number" || !Number.isFinite(metric) || metric < 0) {
      fail("evidence_schema_invalid", `receipt metric ${key} is invalid`);
    }
  }
  if (value.signal !== null && typeof value.signal !== "string") fail("evidence_schema_invalid", "receipt signal is invalid");
  return Object.freeze({
    arch: string(value.arch, "receipt.arch", 64),
    argv: normalizeArgv(value.argv, "receipt.argv"),
    cases: Object.freeze(value.cases.map(parseReceiptCase)),
    commitSha: value.commitSha,
    dirty: validateDirty(value.dirty),
    exitCode: integer(value.exitCode, "receipt.exitCode"),
    manifestId: identifier(value.manifestId, "receipt.manifestId"),
    manifestSha256: value.manifestSha256,
    metrics: Object.freeze({ ...metrics }),
    nodeVersion: string(value.nodeVersion, "receipt.nodeVersion", 64),
    platform,
    pnpmVersion: string(value.pnpmVersion, "receipt.pnpmVersion", 64),
    profile,
    receiptId: value.receiptId,
    reports: Object.freeze(value.reports.map(parseReceiptReport)),
    schemaVersion: 1,
    signal: value.signal,
  });
}

export function createEvidenceReceipt({ context, manifest, manifestSource, platform, profile, reportDocuments, workspaceRoot }) {
  const evaluated = evaluateEvidence({ manifest, platform, profile, reportDocuments, workspaceRoot });
  const metrics = { ...(context.metrics ?? {}) };
  for (const [key, value] of Object.entries(evaluated.metrics)) {
    if (Object.hasOwn(metrics, key) && metrics[key] !== value) {
      fail("evidence_report_duplicate", `receipt metric disagrees with runner report: ${key}`);
    }
    metrics[key] = value;
  }
  return Object.freeze({
    arch: context.arch,
    argv: Object.freeze([...context.argv]),
    cases: evaluated.cases,
    commitSha: context.commitSha,
    dirty: context.dirty,
    exitCode: 0,
    manifestId: manifest.manifestId,
    manifestSha256: sha256(manifestSource),
    metrics: Object.freeze(metrics),
    nodeVersion: context.nodeVersion,
    platform,
    pnpmVersion: context.pnpmVersion,
    profile,
    receiptId: "architecture-simplification-receipt-v1",
    reports: evaluated.reports,
    schemaVersion: 1,
    signal: null,
  });
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function verifyEvidenceReceipt({ expectedContext, manifest, manifestSource, receipt, workspaceRoot }) {
  if (receipt.manifestId !== manifest.manifestId || receipt.manifestSha256 !== sha256(manifestSource)) {
    fail("evidence_manifest_hash_mismatch", "receipt is not bound to the exact manifest bytes");
  }
  if (receipt.exitCode !== 0 || receipt.signal !== null) fail("evidence_receipt_failed", "receipt did not record a successful validator run");
  if (expectedContext !== undefined) {
    const checkoutMatches = receipt.commitSha === expectedContext.commitSha && sameJson(receipt.dirty, expectedContext.dirty);
    const runtimeMatches = receipt.arch === expectedContext.arch
      && receipt.nodeVersion === expectedContext.nodeVersion
      && receipt.platform === expectedContext.platform
      && receipt.pnpmVersion === expectedContext.pnpmVersion;
    if (!checkoutMatches || !runtimeMatches) {
      fail("evidence_execution_context_mismatch", "receipt does not belong to the exact checkout and runtime context");
    }
  }
  const reportDocuments = [];
  for (const report of receipt.reports) {
    const source = await readFile(report.path, "utf8").catch((error) => {
      fail("evidence_report_missing", `receipt report is unavailable: ${report.path}`, { cause: error });
    });
    if (sha256(source) !== report.sha256) fail("evidence_report_hash_mismatch", `runner report changed: ${report.path}`);
    reportDocuments.push(Object.freeze({ argv: report.argv, path: report.path, source }));
  }
  const evaluated = evaluateEvidence({
    manifest,
    platform: receipt.platform,
    profile: receipt.profile,
    reportDocuments,
    workspaceRoot,
  });
  if (!sameJson(evaluated.cases, receipt.cases)) fail("evidence_receipt_case_mismatch", "receipt case results do not match its reports");
  if (!sameJson(evaluated.reports, receipt.reports)) fail("evidence_receipt_report_mismatch", "receipt report metadata do not match its reports");
  const expectedMetrics = Object.freeze({ ...(expectedContext?.metrics ?? {}), ...evaluated.metrics });
  if (!sameJson(expectedMetrics, receipt.metrics)) fail("evidence_receipt_metric_mismatch", "receipt metrics do not exactly match their reports and execution context");
  return receipt;
}

function runGit(workspaceRoot, args, encoding = "utf8") {
  const result = spawnSync("git", args, { cwd: workspaceRoot, encoding: encoding === "buffer" ? null : encoding, shell: false });
  if (result.status !== 0) fail("evidence_git_unavailable", `git ${args.join(" ")} failed: ${String(result.stderr)}`);
  return result.stdout;
}

async function captureGitState(workspaceRoot) {
  const commitSha = String(runGit(workspaceRoot, ["rev-parse", "HEAD"])).trim();
  if (!/^[a-f0-9]{40,64}$/u.test(commitSha)) fail("evidence_git_unavailable", "HEAD is not a full commit hash");
  const changed = String(runGit(workspaceRoot, ["diff", "--name-only", "-z", "HEAD"])).split("\0").filter(Boolean);
  const untracked = String(runGit(workspaceRoot, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  const paths = [...new Set([...changed, ...untracked])].sort((left, right) => left.localeCompare(right, "en"));
  if (paths.length === 0) return Object.freeze({ commitSha, dirty: null });
  const hash = createHash("sha256");
  hash.update(runGit(workspaceRoot, ["diff", "--binary", "--no-ext-diff", "HEAD"], "buffer"));
  for (const path of untracked.sort((left, right) => left.localeCompare(right, "en"))) {
    hash.update(`\0untracked\0${path}\0`);
    hash.update(await readFile(resolve(workspaceRoot, path)));
  }
  return Object.freeze({
    commitSha,
    dirty: Object.freeze({ patchSha256: hash.digest("hex"), paths: Object.freeze(paths.map((path) => path.split(sep).join("/"))) }),
  });
}

async function captureExecutionContext(workspaceRoot) {
  const git = await captureGitState(workspaceRoot);
  const packageJson = JSON.parse(await readFile(resolve(workspaceRoot, "package.json"), "utf8"));
  const pnpmVersion = /^pnpm@(.+)$/u.exec(packageJson.packageManager ?? "")?.[1];
  if (pnpmVersion === undefined) fail("evidence_schema_invalid", "packageManager does not pin pnpm");
  return Object.freeze({
    arch: process.arch,
    commitSha: git.commitSha,
    dirty: git.dirty,
    nodeVersion: process.version,
    platform: process.platform,
    pnpmVersion,
  });
}

export function parseArchitectureArguments(argv) {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const options = { reportArgv: [], reports: [], receipts: [] };
  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const option = normalizedArgv[index];
    const value = normalizedArgv[index + 1];
    if (option === "--help") return Object.freeze({ ...options, help: true });
    if (value === undefined || value.startsWith("--")) fail("evidence_cli_invalid", `${option} requires a value`);
    index += 1;
    if (option === "--manifest") options.manifest = value;
    else if (option === "--profile") options.profile = value;
    else if (option === "--platform") options.platform = value;
    else if (option === "--report") options.reports.push(value);
    else if (option === "--report-argv-json") options.reportArgv.push(value);
    else if (option === "--receipt-out") options.receiptOut = value;
    else if (option === "--receipt") options.receipts.push(value);
    else fail("evidence_cli_invalid", `unknown option ${option}`);
  }
  return Object.freeze(options);
}

function reportsFromEnvironment() {
  return Object.keys(process.env)
    .map((key) => /^BORN_ARCHITECTURE_REPORT_([0-9]+)$/u.exec(key))
    .filter((match) => match !== null)
    .sort((left, right) => Number(left[1]) - Number(right[1]))
    .map((match) => {
      const key = match[0];
      const path = process.env[key];
      const argvSource = process.env[`${key}_ARGV`];
      if (path === undefined || argvSource === undefined) fail("evidence_cli_invalid", `${key} and ${key}_ARGV must both be set`);
      return Object.freeze({ argvSource, path });
    });
}

function usage() {
  return [
    "Usage:",
    "  node scripts/validate-architecture-simplification.mjs --manifest <path> --profile <profile> --report <path> --report-argv-json <json> --receipt-out <path>",
    "  node scripts/validate-architecture-simplification.mjs --manifest <path> --receipt <path> [--receipt <path> ...]",
    "Environment collection: BORN_ARCHITECTURE_PROFILE, BORN_ARCHITECTURE_REPORT_<n>, BORN_ARCHITECTURE_REPORT_<n>_ARGV, BORN_ARCHITECTURE_RECEIPT_OUT.",
  ].join("\n");
}

async function main() {
  const workspaceRoot = resolve(import.meta.dirname, "..");
  const options = parseArchitectureArguments(process.argv.slice(2));
  if (options.help === true) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const manifestPath = resolve(workspaceRoot, options.manifest ?? process.env.BORN_ARCHITECTURE_MANIFEST ?? DEFAULT_MANIFEST);
  const manifestSource = await readFile(manifestPath, "utf8");
  const manifest = parseEvidenceManifest(manifestSource);
  if (options.receipts.length > 0) {
    if (options.reports.length > 0) fail("evidence_cli_invalid", "receipt verification cannot also collect reports");
    const expectedContext = await captureExecutionContext(workspaceRoot);
    for (const path of options.receipts) {
      const receipt = parseEvidenceReceipt(await readFile(resolve(path), "utf8"));
      await verifyEvidenceReceipt({ expectedContext, manifest, manifestSource, receipt, workspaceRoot });
      process.stdout.write(`Architecture evidence receipt verified: ${receipt.profile}/${receipt.platform}, ${String(receipt.cases.length)} cases.\n`);
    }
    return;
  }

  const environmentReports = reportsFromEnvironment();
  const paths = options.reports.length > 0 ? options.reports : environmentReports.map((item) => item.path);
  const argvSources = options.reportArgv.length > 0 ? options.reportArgv : environmentReports.map((item) => item.argvSource);
  if (paths.length === 0 || paths.length !== argvSources.length) {
    fail("evidence_cli_invalid", "collection requires one exact argv JSON array for every report");
  }
  const profile = options.profile ?? process.env.BORN_ARCHITECTURE_PROFILE;
  const platform = options.platform ?? process.env.BORN_ARCHITECTURE_PLATFORM ?? process.platform;
  const receiptOut = options.receiptOut ?? process.env.BORN_ARCHITECTURE_RECEIPT_OUT;
  if (profile === undefined || receiptOut === undefined) fail("evidence_cli_invalid", "collection requires profile and receipt output");
  const reportDocuments = [];
  for (let index = 0; index < paths.length; index += 1) {
    const path = resolve(paths[index]);
    const argvValue = parseStrictJson(argvSources[index]);
    reportDocuments.push(Object.freeze({ argv: normalizeArgv(argvValue, `report argv ${String(index)}`), path, source: await readFile(path, "utf8") }));
  }
  const executionContext = await captureExecutionContext(workspaceRoot);
  const receipt = createEvidenceReceipt({
    context: {
      arch: executionContext.arch,
      argv: [process.execPath, ...process.argv.slice(1)],
      commitSha: executionContext.commitSha,
      dirty: executionContext.dirty,
      metrics: {},
      nodeVersion: executionContext.nodeVersion,
      pnpmVersion: executionContext.pnpmVersion,
    },
    manifest,
    manifestSource,
    platform,
    profile,
    reportDocuments,
    workspaceRoot,
  });
  const output = resolve(receiptOut);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  await verifyEvidenceReceipt({
    expectedContext: executionContext,
    manifest,
    manifestSource,
    receipt,
    workspaceRoot,
  });
  process.stdout.write(`Architecture evidence passed: ${profile}/${platform}, ${String(receipt.cases.length)} cases; receipt=${output}\n`);
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (process.env.GITHUB_ACTIONS === "true") {
      const escaped = message
        .replaceAll("%", "%25")
        .replaceAll("\r", "%0D")
        .replaceAll("\n", "%0A");
      process.stdout.write(`::error title=Architecture evidence invalid::${escaped}\n`);
    }
    process.stderr.write(`architecture_evidence_invalid: ${message}\n`);
    process.exitCode = 1;
  });
}
