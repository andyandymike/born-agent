import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "..");
const annotationLimit = 3_500;

function argumentsFrom(argv) {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  if (normalized.length !== 1) {
    throw new TypeError("report-vitest-failures expects exactly one JSON report path");
  }
  return Object.freeze({ reportPath: resolve(normalized[0]) });
}

function strings(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string")
    : [];
}

function reportFile(value) {
  if (typeof value !== "string") return ".github";
  const difference = relative(workspaceRoot, resolve(value));
  return difference !== "" && difference !== ".." &&
      !difference.startsWith(`..${sep}`) && !isAbsolute(difference)
    ? difference.split(sep).join("/")
    : ".github";
}

function escapeWorkflowValue(value) {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function emitFailure(failure) {
  const message = failure.message.slice(-annotationLimit);
  process.stderr.write(`${failure.file}\n${failure.title}\n${message}\n`);
  if (process.env.GITHUB_ACTIONS !== "true") return;
  process.stdout.write(
    `::error file=${escapeWorkflowValue(failure.file)},title=${escapeWorkflowValue(failure.title.slice(0, 200))}::${escapeWorkflowValue(message)}\n`,
  );
}

function failuresFrom(report) {
  const failures = [];
  for (const testFile of Array.isArray(report.testResults) ? report.testResults : []) {
    const file = reportFile(testFile?.name);
    let assertionFailureCount = 0;
    for (const assertion of Array.isArray(testFile?.assertionResults)
      ? testFile.assertionResults
      : []) {
      if (assertion?.status !== "failed") continue;
      assertionFailureCount += 1;
      const titleParts = typeof assertion.fullName === "string"
        ? [assertion.fullName]
        : [
            ...strings(assertion.ancestorTitles),
            ...(typeof assertion.title === "string" ? [assertion.title] : []),
          ];
      failures.push(Object.freeze({
        file,
        message: strings(assertion.failureMessages).join("\n") ||
          "Vitest reported a failed assertion without a failure message.",
        title: titleParts.join(" > ") || "Vitest assertion failed",
      }));
    }
    if (assertionFailureCount === 0 && testFile?.status === "failed") {
      failures.push(Object.freeze({
        file,
        message: typeof testFile.message === "string" && testFile.message.length > 0
          ? testFile.message
          : "Vitest reported a failed suite without a failure message.",
        title: "Vitest suite failed",
      }));
    }
  }
  for (const error of Array.isArray(report.unhandledErrors) ? report.unhandledErrors : []) {
    failures.push(Object.freeze({
      file: ".github",
      message: typeof error?.stack === "string"
        ? error.stack
        : typeof error?.message === "string"
          ? error.message
          : JSON.stringify(error),
      title: "Vitest unhandled error",
    }));
  }
  return failures;
}

async function main() {
  const { reportPath } = argumentsFrom(process.argv.slice(2));
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const failures = failuresFrom(report);
  if (failures.length === 0) {
    failures.push(Object.freeze({
      file: ".github",
      message: `report=${reportPath}\ncounts=${JSON.stringify({
        failedSuites: report.numFailedTestSuites,
        failedTests: report.numFailedTests,
        passedTests: report.numPassedTests,
        totalTests: report.numTotalTests,
      })}`,
      title: "Vitest command failed without a reported assertion",
    }));
  }
  for (const failure of failures) emitFailure(failure);
  throw new Error(`Vitest evidence command failed with ${String(failures.length)} reported failure(s)`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`vitest_failure_report_failed: ${message}\n`);
  process.exitCode = 1;
});
