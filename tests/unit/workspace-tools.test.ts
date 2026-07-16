import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createReadonlyToolRegistry } from "../../src/tools/create-readonly-tool-registry.js";
import type { ToolRegistry } from "../../src/tools/tool-registry.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

async function invoke(
  registry: ToolRegistry,
  name: string,
  args: unknown,
) {
  const result = await registry.execute(
    {
      argumentsJson: JSON.stringify(args),
      callId: "call_test",
      name,
    },
    new AbortController().signal,
  );
  return { parsed: JSON.parse(result.output) as Record<string, unknown>, result };
}

describe("read-only workspace tools", () => {
  it("reads UTF-8 files with line numbers and a bounded continuation", async () => {
    const root = await temporaryDirectory("born-tools-");
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src", "many.txt"),
      Array.from({ length: 450 }, (_, index) => `line ${index + 1}`).join("\n"),
      "utf8",
    );
    const registry = await createReadonlyToolRegistry(root);
    const { parsed, result } = await invoke(registry, "read_file", {
      end_line: null,
      path: "src/many.txt",
      start_line: null,
    });

    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(parsed).toMatchObject({
      end_line: 400,
      next_start_line: 401,
      path: "src/many.txt",
      start_line: 1,
      truncated: true,
    });
    expect(parsed.content).toContain("1: line 1");
    expect(parsed.content).toContain("400: line 400");
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(64 * 1024);
  });

  it("rejects binary, oversized, sensitive, absolute, and parent paths", async () => {
    const root = await temporaryDirectory("born-tools-");
    const outside = await temporaryDirectory("born-outside-");
    await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2]));
    await writeFile(join(root, "large.txt"), Buffer.alloc(1024 * 1024 + 1, 65));
    await writeFile(join(root, ".env"), "TOKEN=secret", "utf8");
    await writeFile(join(root, ".env.example"), "TOKEN=example", "utf8");
    await writeFile(join(outside, "secret.txt"), "outside secret", "utf8");
    const registry = await createReadonlyToolRegistry(root);

    for (const path of [
      "binary.bin",
      "large.txt",
      ".env",
      "../secret.txt",
      join(outside, "secret.txt"),
    ]) {
      const { result } = await invoke(registry, "read_file", {
        end_line: null,
        path,
        start_line: null,
      });
      expect(result.ok, path).toBe(false);
      expect(result.output).not.toContain("outside secret");
      expect(result.output).not.toContain("TOKEN=secret");
    }

    const example = await invoke(registry, "read_file", {
      end_line: null,
      path: ".env.example",
      start_line: null,
    });
    expect(example.result.ok).toBe(true);
    expect(example.parsed.content).toContain("TOKEN=example");
  });

  it("rejects a directory junction that resolves outside the workspace", async () => {
    const root = await temporaryDirectory("born-tools-");
    const outside = await temporaryDirectory("born-outside-");
    await writeFile(join(outside, "secret.txt"), "outside secret", "utf8");
    await symlink(outside, join(root, "escape"), "junction");
    const registry = await createReadonlyToolRegistry(root);
    const { result } = await invoke(registry, "read_file", {
      end_line: null,
      path: "escape/secret.txt",
      start_line: null,
    });
    expect(result).toMatchObject({
      error: { code: "path_outside_workspace" },
      ok: false,
    });
    expect(result.output).not.toContain("outside secret");
  });

  it("searches and lists through real ripgrep while excluding sensitive paths", async () => {
    const root = await temporaryDirectory("born-tools-");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "alpha.ts"), "export const CODE = 'BORN';\n", "utf8");
    await writeFile(join(root, "src", "beta.ts"), "export const OTHER = 2;\n", "utf8");
    await writeFile(join(root, "private.key"), "BORN_PRIVATE", "utf8");
    const registry = await createReadonlyToolRegistry(root);

    const search = await invoke(registry, "search", {
      glob: "*.ts",
      mode: "literal",
      path: "src",
      query: "BORN",
    });
    expect(search.result.ok).toBe(true);
    expect(search.parsed.matches).toEqual([
      expect.objectContaining({ line: 1, path: "src/alpha.ts" }),
    ]);

    const list = await invoke(registry, "list_files", {
      glob: "*.ts",
      path: null,
    });
    expect(list.result.ok).toBe(true);
    expect(list.parsed.files).toEqual(["src/alpha.ts", "src/beta.ts"]);
    expect(list.result.output).not.toContain("private.key");

    const none = await invoke(registry, "search", {
      glob: null,
      mode: "literal",
      path: null,
      query: "NO_SUCH_TEXT",
    });
    expect(none).toMatchObject({ parsed: { matches: [], ok: true } });
  });
});
