import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "..");
const distDirectory = resolve(workspaceRoot, "dist");

if (dirname(distDirectory) !== workspaceRoot) {
  throw new Error(`Refusing to clean unexpected path: ${distDirectory}`);
}

await rm(distDirectory, { force: true, recursive: true });

