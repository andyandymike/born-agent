import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";

export async function isReadableDirectory(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

