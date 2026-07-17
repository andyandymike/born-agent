import { describe, expect, it } from "vitest";

import {
  SandboxPathMapper,
  SandboxPathMappingError,
} from "../../src/execution/docker/sandbox-path-mapper.js";
import { createSnapshotManifest } from "../../src/execution/snapshot/snapshot-manifest.js";

const SHA = "a".repeat(64);

function mapper(): SandboxPathMapper {
  return new SandboxPathMapper({
    hostPlatform: "win32",
    hostWorkspaceRoot: "D:\\Work Space\\项目",
    manifest: createSnapshotManifest({
      entries: [
        {
          bytes: 10,
          mode: "regular",
          path: "src/中文 file.ts",
          sha256: SHA,
        },
        {
          bytes: 20,
          mode: "regular",
          path: "tests/unit/a.test.ts",
          sha256: "b".repeat(64),
        },
      ],
    }),
  });
}

describe("Phase 13 sandbox path mapping", () => {
  it("maps normalized Windows cwd and only declared path positions", () => {
    const paths = mapper();
    expect(paths.mapHostCwd("d:\\work space\\项目\\src")).toBe(
      "/workspace/src",
    );
    expect(
      paths.mapArguments({
        args: ["--check", "中文 file.ts", "literal-value"],
        hostCwd: "D:\\Work Space\\项目\\src",
        pathArgumentIndexes: [1],
      }),
    ).toEqual([
      "--check",
      "/workspace/src/中文 file.ts",
      "literal-value",
    ]);
    expect(
      paths.mapArguments({
        args: ["."],
        hostCwd: "D:\\Work Space\\项目\\src",
        pathArgumentIndexes: [0],
      }),
    ).toEqual(["/workspace/src"]);
  });

  it("refuses host absolute, traversal, absent, and undeclared absolute paths", () => {
    const paths = mapper();
    expect(() => paths.mapHostCwd("D:\\outside")).toThrow(
      "outside the approved snapshot",
    );
    for (const argument of [
      "D:\\Users\\host\\secret",
      "\\\\server\\share\\secret",
      "../outside",
      "missing.ts",
    ]) {
      expect(
        () =>
          paths.mapArguments({
            args: [argument],
            hostCwd: "D:\\Work Space\\项目\\src",
            pathArgumentIndexes: [0],
          }),
        argument,
      ).toThrow(SandboxPathMappingError);
    }
    expect(() =>
      paths.mapArguments({
        args: ["/host/home"],
        hostCwd: "D:\\Work Space\\项目",
        pathArgumentIndexes: [],
      }),
    ).toThrow("undeclared argument");
  });

  it("requires path index declarations to be unique and in bounds", () => {
    expect(() =>
      mapper().mapArguments({
        args: ["src"],
        hostCwd: "D:\\Work Space\\项目",
        pathArgumentIndexes: [0, 0],
      }),
    ).toThrow("unique valid argv indexes");
  });
});
