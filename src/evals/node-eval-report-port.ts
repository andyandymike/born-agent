import { open, mkdir, readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "../completion/canonical-json.js";
import { EvalCoreError } from "./eval-errors.js";
import type { AtomicEvalReportPort } from "./eval-report-store.js";

function assertSafeRelative(relativePath: string): string {
  if (
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new EvalCoreError("eval_storage_failed", "unsafe eval report path", 1);
  }
  return relativePath;
}

export class NodeEvalReportPort implements AtomicEvalReportPort {
  public constructor(readonly root: string) {}

  private resolve(relativePath: string): string {
    return path.join(this.root, ...assertSafeRelative(relativePath).split("/"));
  }

  public async writeTemp(relativePath: string, bytes: Uint8Array): Promise<void> {
    const destination = this.resolve(relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    const handle = await open(destination, "w");
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
  }

  public async syncFile(relativePath: string): Promise<void> {
    const handle = await open(this.resolve(relativePath), "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  public async rename(tempPath: string, finalPath: string): Promise<void> {
    await rename(this.resolve(tempPath), this.resolve(finalPath));
  }

  public async syncDirectory(relativePath: string): Promise<void> {
    const directory = this.resolve(relativePath);
    try {
      const handle = await open(directory, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (!["EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes(String(code))) throw error;
    }
  }

  public async readAttemptFiles(runId: string): Promise<readonly unknown[]> {
    const attemptsRoot = this.resolve(`${runId}/attempts`);
    const taskDirectories = await readdir(attemptsRoot, { withFileTypes: true }).catch((error: unknown) => {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT") return [];
      throw error;
    });
    const documents: unknown[] = [];
    for (const directory of taskDirectories.filter((entry) => entry.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
      const files = await readdir(path.join(attemptsRoot, directory.name), { withFileTypes: true });
      for (const file of files.filter((entry) => entry.isFile() && /^r[1-9][0-9]*\.json$/u.test(entry.name)).sort((left, right) => left.name.localeCompare(right.name))) {
        documents.push(JSON.parse(await readFile(path.join(attemptsRoot, directory.name, file.name), "utf8")) as unknown);
      }
    }
    return documents;
  }

  public async writeJson(relativePath: string, value: unknown): Promise<void> {
    const finalPath = assertSafeRelative(relativePath);
    const tempPath = `${finalPath}.tmp`;
    await this.writeTemp(tempPath, new TextEncoder().encode(`${canonicalJson(value)}\n`));
    await this.syncFile(tempPath);
    await this.rename(tempPath, finalPath);
    await this.syncDirectory(path.posix.dirname(finalPath));
  }

  public async writeText(relativePath: string, value: string): Promise<void> {
    const finalPath = assertSafeRelative(relativePath);
    const tempPath = `${finalPath}.tmp`;
    await this.writeTemp(tempPath, new TextEncoder().encode(value));
    await this.syncFile(tempPath);
    await this.rename(tempPath, finalPath);
    await this.syncDirectory(path.posix.dirname(finalPath));
  }

  public async readJson(relativePath: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.resolve(relativePath), "utf8")) as unknown;
    } catch (error) {
      throw new EvalCoreError("eval_report_corrupt", "eval report JSON is missing or corrupt", 1, { cause: error });
    }
  }

  public async readText(relativePath: string): Promise<string> {
    try {
      return await readFile(this.resolve(relativePath), "utf8");
    } catch (error) {
      throw new EvalCoreError("eval_report_corrupt", "eval report text is missing", 1, { cause: error });
    }
  }
}
