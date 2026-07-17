import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  McpConfigLoader,
} from "../../src/mcp/mcp-config-loader.js";
import type { McpConfigFileSystem } from "../../src/mcp/mcp-config-loader.js";
import { parseMcpConfig } from "../../src/mcp/mcp-config-schema.js";
import { McpCoreError } from "../../src/mcp/mcp-errors.js";
import {
  MCP_EMPTY_INTEGRITY_MARKER,
  McpIntegrityManifestBuilder,
} from "../../src/mcp/mcp-integrity-manifest.js";
import type { McpIntegrityFileSystem } from "../../src/mcp/mcp-integrity-manifest.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

function validConfig() {
  return {
    servers: {
      fixture: {
        args: ["fixtures/mcp/server.mjs"],
        call_timeout_ms: 60_000,
        cwd: ".",
        env: [
          { source: "BORN_MCP_FIXTURE_TOKEN", target: "FIXTURE_TOKEN" },
        ],
        integrity_files: ["fixtures/mcp/server.mjs", "package.json"],
        executable: "node",
        startup_timeout_ms: 10_000,
        transport: "stdio",
      },
    },
    version: 1,
  };
}

function expectMcpCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error("expected MCP error");
  } catch (error) {
    expect(error).toBeInstanceOf(McpCoreError);
    expect((error as McpCoreError).code).toBe(code);
  }
}

describe("Phase 12 MCP config", () => {
  it("parses the strict versioned local config", () => {
    expect(parseMcpConfig(validConfig())).toMatchObject({
      servers: { fixture: { executable: "node", transport: "stdio" } },
      version: 1,
    });
  });

  it("rejects literal env values, unsafe ids, path escape, and duplicate mappings", () => {
    expectMcpCode(
      () =>
        parseMcpConfig({
          ...validConfig(),
          servers: {
            Fixture: validConfig().servers.fixture,
          },
        }),
      "mcp_config_invalid",
    );
    expectMcpCode(
      () =>
        parseMcpConfig({
          ...validConfig(),
          servers: {
            fixture: {
              ...validConfig().servers.fixture,
              args: ["safe/../../outside.mjs"],
            },
          },
        }),
      "mcp_config_invalid",
    );
    expectMcpCode(
      () =>
        parseMcpConfig({
          ...validConfig(),
          servers: {
            fixture: { ...validConfig().servers.fixture, cwd: "../outside" },
          },
        }),
      "mcp_config_invalid",
    );
    expectMcpCode(
      () =>
        parseMcpConfig({
          ...validConfig(),
          servers: {
            fixture: {
              ...validConfig().servers.fixture,
              env: [
                {
                  source: "BORN_MCP_FIXTURE_TOKEN",
                  target: "TOKEN",
                  value: "literal-secret",
                },
              ],
            },
          },
        }),
      "mcp_config_invalid",
    );
    expectMcpCode(
      () =>
        parseMcpConfig({
          ...validConfig(),
          servers: {
            fixture: {
              ...validConfig().servers.fixture,
              env: [
                { source: "BORN_MCP_A", target: "TOKEN" },
                { source: "BORN_MCP_B", target: "token" },
              ],
            },
          },
        }),
      "mcp_config_invalid",
    );
  });

  it("rejects prototype keys, accessors, excessive argv bytes, and too many servers", () => {
    expectMcpCode(
      () => parseMcpConfig(JSON.parse('{"version":1,"servers":{"__proto__":{}}}') as unknown),
      "mcp_config_invalid",
    );
    const accessor = validConfig() as Record<string, unknown>;
    Object.defineProperty(accessor, "evil", { enumerable: true, get: () => 1 });
    expectMcpCode(() => parseMcpConfig(accessor), "mcp_config_invalid");
    expectMcpCode(
      () =>
        parseMcpConfig({
          ...validConfig(),
          servers: {
            fixture: {
              ...validConfig().servers.fixture,
              args: ["x".repeat(16 * 1024 + 1)],
            },
          },
        }),
      "mcp_config_invalid",
    );
    expectMcpCode(
      () =>
        parseMcpConfig({
          servers: Object.fromEntries(
            Array.from({ length: 9 }, (_, index) => [
              `s${index}`,
              { ...validConfig().servers.fixture, integrity_files: [] },
            ]),
          ),
          version: 1,
        }),
      "mcp_config_invalid",
    );
  });

  it("loads a real local config without spawning and returns stable per-server hashes", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "bornagent-mcp-config-"));
    temporaryDirectories.push(workspace);
    await mkdir(path.join(workspace, ".bornagent"));
    await mkdir(path.join(workspace, "fixtures", "mcp"), { recursive: true });
    await writeFile(
      path.join(workspace, ".bornagent", "mcp.json"),
      JSON.stringify(validConfig()),
      "utf8",
    );

    const first = await new McpConfigLoader({ workspace }).load();
    const second = await new McpConfigLoader({ workspace }).load();

    expect(first.status).toBe("loaded");
    expect(second).toEqual(first);
    if (first.status === "loaded") {
      expect(first.servers.fixture).toMatchObject({
        canonicalCwd: ".",
        serverId: "fixture",
        transport: "stdio",
      });
      expect(first.servers.fixture?.configSha256).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it("reports a missing config without creating directories or processes", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "bornagent-mcp-missing-"));
    temporaryDirectories.push(workspace);
    await expect(new McpConfigLoader({ workspace }).load()).resolves.toEqual({
      status: "missing",
    });
  });

  it("rejects a config reached through a symlink or junction component", async () => {
    const workspace = path.resolve("workspace");
    const configPath = path.join(workspace, ".bornagent", "mcp.json");
    const fileSystem: McpConfigFileSystem = {
      lstat: async (filePath) => ({
        isDirectory: () => filePath !== configPath,
        isFile: () => filePath === configPath,
        isSymbolicLink: () => filePath === configPath,
        size: 10,
      }),
      readFile: async () => Buffer.from("{}"),
      realpath: async (filePath) => filePath,
      stat: async () => ({
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false,
        size: 0,
      }),
    };

    await expect(
      new McpConfigLoader({ fileSystem, workspace }).load(),
    ).rejects.toMatchObject({ code: "mcp_config_path_unsafe" });
  });
});

class FakeIntegrityFileSystem implements McpIntegrityFileSystem {
  readonly files = new Map<string, Uint8Array>();
  readonly symlinks = new Set<string>();

  async lstat(filePath: string) {
    const bytes = this.files.get(filePath);
    return {
      isFile: () => bytes !== undefined,
      isSymbolicLink: () => this.symlinks.has(filePath),
      size: bytes?.byteLength ?? 0,
    };
  }

  async readFile(filePath: string): Promise<Uint8Array> {
    const bytes = this.files.get(filePath);
    if (bytes === undefined) throw new Error("missing fake file");
    return bytes;
  }

  async realpath(filePath: string): Promise<string> {
    return filePath;
  }

  async stat(filePath: string) {
    return this.lstat(filePath);
  }
}

describe("Phase 12 explicit integrity manifest", () => {
  it("uses an explicit not-bound marker and never guesses files from argv", async () => {
    const manifest = await new McpIntegrityManifestBuilder({
      fileSystem: new FakeIntegrityFileSystem(),
      workspaceRealPath: path.resolve("workspace"),
    }).build([]);

    expect(manifest).toMatchObject({ binding: "not_bound", entries: [], totalBytes: 0 });
    expect(MCP_EMPTY_INTEGRITY_MARKER).toBe("mcp-integrity:not-bound:v1");
    expect(manifest.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("sorts explicit files and detects byte changes during pre-spawn recheck", async () => {
    const workspace = path.resolve("workspace");
    const fileSystem = new FakeIntegrityFileSystem();
    const firstPath = path.resolve(workspace, "a.txt");
    const secondPath = path.resolve(workspace, "dir", "b.txt");
    fileSystem.files.set(firstPath, Buffer.from("a"));
    fileSystem.files.set(secondPath, Buffer.from("b"));
    const builder = new McpIntegrityManifestBuilder({ fileSystem, workspaceRealPath: workspace });

    const manifest = await builder.build(["dir/b.txt", "a.txt"]);
    expect(manifest.entries.map((entry) => entry.path)).toEqual(["a.txt", "dir/b.txt"]);
    await expect(builder.recheck(manifest)).resolves.toBeUndefined();

    fileSystem.files.set(secondPath, Buffer.from("c"));
    await expect(builder.recheck(manifest)).rejects.toMatchObject({
      code: "mcp_integrity_changed",
    });
  });

  it("rejects symlink components, duplicate paths, per-file and total limits", async () => {
    const workspace = path.resolve("workspace");
    const fileSystem = new FakeIntegrityFileSystem();
    const linked = path.resolve(workspace, "linked.txt");
    fileSystem.files.set(linked, Buffer.from("x"));
    fileSystem.symlinks.add(linked);
    const builder = new McpIntegrityManifestBuilder({ fileSystem, workspaceRealPath: workspace });

    await expect(builder.build(["linked.txt"])).rejects.toMatchObject({
      code: "mcp_integrity_invalid",
    });
    await expect(builder.build(["a.txt", "a.txt"])).rejects.toMatchObject({
      code: "mcp_integrity_invalid",
    });

    const huge = path.resolve(workspace, "huge.bin");
    fileSystem.files.set(huge, new Uint8Array(1024 * 1024 + 1));
    await expect(builder.build(["huge.bin"])).rejects.toMatchObject({
      code: "mcp_integrity_limit",
    });

    for (let index = 0; index < 5; index += 1) {
      fileSystem.files.set(
        path.resolve(workspace, `${index}.bin`),
        new Uint8Array(1024 * 1024),
      );
    }
    await expect(
      builder.build(Array.from({ length: 5 }, (_, index) => `${index}.bin`)),
    ).rejects.toMatchObject({ code: "mcp_integrity_limit" });
  });
});
