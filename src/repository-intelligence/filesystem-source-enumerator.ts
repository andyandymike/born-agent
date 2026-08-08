import { opendir } from "node:fs/promises";
import { join } from "node:path";

import type { SourceInventoryPolicy } from "./source-inventory-policy.js";
import { canonicalRelativePath, type SourceEnumeration, type SourceEnumerator } from "./source-enumerator.js";

export class FilesystemSourceEnumerator implements SourceEnumerator {
  constructor(
    private readonly workspaceRealPath: string,
    private readonly policy: SourceInventoryPolicy,
  ) {}

  async enumerate(signal: AbortSignal): Promise<SourceEnumeration> {
    const paths: string[] = [];
    let linkedEntries = 0;
    let unreadableDirectories = 0;
    const ignored = new Set(this.policy.ignoredDirectoryNames.map((name) => name.toLowerCase()));
    const visit = async (absoluteDirectory: string, relativeDirectory: string): Promise<void> => {
      if (signal.aborted) throw signal.reason ?? new Error("repository inventory cancelled");
      let directory;
      try {
        directory = await opendir(absoluteDirectory);
      } catch {
        unreadableDirectories += 1;
        return;
      }
      for await (const entry of directory) {
        if (signal.aborted) throw signal.reason ?? new Error("repository inventory cancelled");
        const relativeCandidate = relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
        const canonical = canonicalRelativePath(relativeCandidate);
        if (canonical === null) continue;
        if (entry.isSymbolicLink()) {
          linkedEntries += 1;
          continue;
        }
        if (entry.isDirectory()) {
          if (!ignored.has(entry.name.toLowerCase())) {
            await visit(join(absoluteDirectory, entry.name), canonical);
          }
          continue;
        }
        if (entry.isFile()) paths.push(canonical);
      }
    };
    await visit(this.workspaceRealPath, "");
    return Object.freeze({
      gitHeadOid: null,
      gitIndexSha256: null,
      paths: Object.freeze(paths),
      skipped: Object.freeze({
        ...(linkedEntries === 0 ? {} : { linked_entry: linkedEntries }),
        ...(unreadableDirectories === 0 ? {} : { unreadable_directory: unreadableDirectories }),
      }),
      sourceKind: "filesystem" as const,
    });
  }
}
