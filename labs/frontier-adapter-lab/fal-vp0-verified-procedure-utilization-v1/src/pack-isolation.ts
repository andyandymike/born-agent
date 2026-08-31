import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { sha256Canonical } from "../../../../src/completion/canonical-json.js";
import {
  FAL_VP0_EXPERIMENT_ID,
  logicalIdentity,
  nonnegativeIntegerSchema,
  sha256Schema,
} from "./protocol.js";

const execFileAsync = promisify(execFile);
const PATH_MARKER = "fal-vp0-verified-procedure-utilization-v1";

const packIsolationContentSchema = z.object({
  schemaVersion: z.literal(1),
  experimentId: z.literal(FAL_VP0_EXPERIMENT_ID),
  command: z.literal("pnpm pack --dry-run --json"),
  commandSucceeded: z.boolean(),
  staticPolicyPassed: z.boolean(),
  packageInventorySha256: sha256Schema,
  packageEntryCount: nonnegativeIntegerSchema,
  labEntryCount: nonnegativeIntegerSchema,
  experimentFixtureEntryCount: nonnegativeIntegerSchema,
  packedArtifactDeltaBytes: nonnegativeIntegerSchema,
  productionSourceMarkerCount: nonnegativeIntegerSchema,
  status: z.enum(["passed", "failed"]),
}).strict();

export const falVp0PackIsolationEvidenceSchema = packIsolationContentSchema.extend({
  evidenceSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const passed = value.commandSucceeded &&
    value.staticPolicyPassed &&
    value.labEntryCount === 0 &&
    value.experimentFixtureEntryCount === 0 &&
    value.packedArtifactDeltaBytes === 0 &&
    value.productionSourceMarkerCount === 0;
  if ((value.status === "passed") !== passed) {
    context.addIssue({ code: "custom", message: "pack isolation status is not derived" });
  }
  if (value.evidenceSha256 !== logicalIdentity(value, "evidenceSha256")) {
    context.addIssue({ code: "custom", message: "pack isolation evidence hash mismatch" });
  }
});

export type FalVp0PackIsolationEvidence = Readonly<
  z.infer<typeof falVp0PackIsolationEvidenceSchema>
>;

async function productionSourceMarkerCount(repositoryRoot: string): Promise<number> {
  const sourceRoot = join(repositoryRoot, "src");
  const entries = await readdir(sourceRoot, { recursive: true, withFileTypes: true });
  const sources = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"));
  let count = 0;
  for (const entry of sources) {
    const content = await readFile(join(entry.parentPath, entry.name), "utf8");
    if (content.includes(PATH_MARKER)) count += 1;
  }
  return count;
}

export async function verifyFalVp0PackIsolation(
  repositoryRoot: string,
): Promise<FalVp0PackIsolationEvidence> {
  const [packageJsonText, buildConfigText, productionMarkers] = await Promise.all([
    readFile(join(repositoryRoot, "package.json"), "utf8"),
    readFile(join(repositoryRoot, "tsconfig.build.json"), "utf8"),
    productionSourceMarkerCount(repositoryRoot),
  ]);
  const packageJson = JSON.parse(packageJsonText) as { readonly files?: readonly string[] };
  const buildConfig = JSON.parse(buildConfigText) as { readonly include?: readonly string[] };
  const packageRoots = packageJson.files ?? [];
  const staticPolicyPassed = JSON.stringify(buildConfig.include) === JSON.stringify(["src/**/*.ts"]) &&
    !packageRoots.some((entry) => entry === "labs" || entry.startsWith("labs/") || entry.includes(PATH_MARKER));
  let commandSucceeded: boolean;
  let files: readonly Readonly<{ readonly path: string }>[] = [];
  try {
    const executable = process.platform === "win32"
      ? process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe"
      : "pnpm";
    const args = process.platform === "win32"
      ? ["/d", "/s", "/c", "pnpm pack --dry-run --json"]
      : ["pack", "--dry-run", "--json"];
    const result = await execFileAsync(executable, args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    const parsed = JSON.parse(result.stdout) as {
      readonly files?: readonly Readonly<{ readonly path?: unknown }>[];
    };
    if (!Array.isArray(parsed.files) || parsed.files.some((entry) =>
      typeof entry.path !== "string")) {
      throw new Error("pnpm pack returned an invalid inventory");
    }
    files = parsed.files.map((entry) => ({
      path: String(entry.path).replaceAll("\\", "/"),
    }));
    commandSucceeded = true;
  } catch {
    commandSucceeded = false;
  }
  const labEntries = files.filter((entry) => entry.path === "labs" || entry.path.startsWith("labs/"));
  const fixtureEntries = files.filter((entry) => entry.path.includes(PATH_MARKER));
  const isolatedEntries = [...new Map(
    [...labEntries, ...fixtureEntries].map((entry) => [entry.path, entry]),
  ).values()];
  const isolatedSizes = await Promise.all(isolatedEntries.map(async (entry) => {
    try {
      return (await stat(join(repositoryRoot, entry.path))).size;
    } catch {
      return 0;
    }
  }));
  const content = {
    schemaVersion: 1 as const,
    experimentId: FAL_VP0_EXPERIMENT_ID,
    command: "pnpm pack --dry-run --json" as const,
    commandSucceeded,
    staticPolicyPassed,
    packageInventorySha256: sha256Canonical(files),
    packageEntryCount: files.length,
    labEntryCount: labEntries.length,
    experimentFixtureEntryCount: fixtureEntries.length,
    packedArtifactDeltaBytes: isolatedSizes.reduce((sum, size) => sum + size, 0),
    productionSourceMarkerCount: productionMarkers,
    status: commandSucceeded && staticPolicyPassed && labEntries.length === 0 &&
      fixtureEntries.length === 0 && productionMarkers === 0
      ? "passed" as const
      : "failed" as const,
  };
  return falVp0PackIsolationEvidenceSchema.parse({
    ...content,
    evidenceSha256: sha256Canonical(content),
  });
}
