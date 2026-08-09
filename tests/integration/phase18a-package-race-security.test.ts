import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StablePackageReader } from "../../src/capabilities/stable-package-reader.js";
import { writeTestCapabilityPackage } from "../phase18a-test-helpers.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("Phase 18A cross-process package stability", () => {
  it("fails closed when another process replaces component bytes during freeze", async () => {
    const base = await mkdtemp(join(tmpdir(), "bornagent-phase18a-race-"));
    temporary.push(base);
    const packageRoot = join(base, "package");
    const filler = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `filler/${String(index).padStart(3, "0")}.txt`,
        `inventory ${String(index)}\n`,
      ]),
    );
    await writeTestCapabilityPackage(packageRoot, { extraFiles: filler });
    const script = String.raw`
      const fs = require("node:fs");
      const target = process.argv[1];
      let revision = 0;
      const write = () => {
        revision += 1;
        const bytes = Buffer.from(JSON.stringify({
          component_id: "review",
          context: { max_entry_bytes: 4096, max_resource_bytes: 4096, max_total_resource_bytes: 8192 },
          description: revision % 2 === 0 ? "Review one bounded change A." : "Review one bounded change B.",
          display_name: "Review change",
          entry: "SKILL.md",
          invocation: "model_allowed",
          kind: "skill",
          schema_version: 1
        }) + "\n");
        const handle = fs.openSync(target, "r+");
        try {
          const written = fs.writeSync(handle, bytes, 0, bytes.byteLength, 0);
          if (written !== bytes.byteLength) throw new Error("short race fixture write");
          fs.ftruncateSync(handle, bytes.byteLength);
          fs.fsyncSync(handle);
        } finally {
          fs.closeSync(handle);
        }
        if (revision === 1) process.stdout.write("READY\n");
      };
      write();
      const timer = setInterval(write, 1);
      setTimeout(() => { clearInterval(timer); process.exit(0); }, 1500);
    `;
    const child = spawn(
      process.execPath,
      ["--input-type=commonjs", "-e", script, join(packageRoot, "skill.json")],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await new Promise<void>((resolve, reject) => {
      let output = "";
      let errorOutput = "";
      child.once("error", reject);
      child.stderr.on("data", (chunk: Buffer) => {
        errorOutput += chunk.toString("utf8");
      });
      child.once("exit", (code) => {
        if (!output.includes("READY\n")) {
          reject(new Error(`race helper exited ${String(code)}: ${errorOutput}`));
        }
      });
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.includes("READY\n")) resolve();
      });
    });

    try {
      await expect(StablePackageReader.read(packageRoot)).rejects.toMatchObject({
        code: "capability_source_unstable",
      });
    } finally {
      if (child.exitCode === null) child.kill();
      await exited;
    }
  });
});
