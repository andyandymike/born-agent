import { link, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  encodePluginManifest,
  parseCapabilityComponentBytes,
  parsePluginManifestBytes,
} from "../../src/capabilities/plugin-manifest-schema.js";
import {
  MAX_CAPABILITY_PACKAGE_BYTES,
  StablePackageReader,
} from "../../src/capabilities/stable-package-reader.js";
import { canonicalJson } from "../../src/completion/canonical-json.js";
import { writeTestCapabilityPackage } from "../phase18a-test-helpers.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "bornagent-phase18a-reader-"));
  temporary.push(value);
  return value;
}

describe("Phase 18A strict manifests and stable packages", () => {
  it("round-trips a valid manifest through the canonical encoder", async () => {
    const packageRoot = join(await root(), "package");
    await writeTestCapabilityPackage(packageRoot);
    const bytes = await readFile(join(packageRoot, "bornagent.plugin.json"));
    const parsed = parsePluginManifestBytes(bytes);
    const encoded = encodePluginManifest(parsed);

    expect(parsePluginManifestBytes(encoded)).toEqual(parsed);
    expect(Buffer.from(encoded).toString("utf8")).toBe(`${canonicalJson(parsed)}\n`);
    expect(Buffer.from(encoded).toString("utf8")).toMatch(/^\{"components":/u);
  });

  it.each([
    ["unknown key", '{"schema_version":1,"plugin_id":"acme","plugin_version":"1","display_name":"Acme","description":"Valid description","components":{},"extra":true}'],
    ["duplicate key", '{"schema_version":1,"plugin_id":"acme","plugin_id":"shadow","plugin_version":"1","display_name":"Acme","description":"Valid description","components":{}}'],
    ["non-object", "[]"],
    ["NaN", '{"schema_version":1,"plugin_id":"acme","plugin_version":"1","display_name":"Acme","description":NaN,"components":{}}'],
  ])("rejects %s before catalog projection", (_label, text) => {
    expect(() => parsePluginManifestBytes(Buffer.from(text, "utf8"))).toThrow(
      /manifest/u,
    );
  });

  it("rejects BOM, invalid UTF-8, unknown Skill effects, and non-portable paths", () => {
    expect(() =>
      parsePluginManifestBytes(Buffer.from("\ufeff{}", "utf8")),
    ).toThrow(/manifest/u);
    expect(() => parsePluginManifestBytes(Uint8Array.of(0xff, 0xfe))).toThrow(
      /UTF-8/u,
    );
    expect(() =>
      parseCapabilityComponentBytes(Buffer.from(JSON.stringify({
        component_id: "review",
        context: {
          max_entry_bytes: 1,
          max_resource_bytes: 1,
          max_total_resource_bytes: 1,
        },
        description: "Review a change.",
        display_name: "Review",
        entry: "SKILL.md",
        invocation: "model_allowed",
        kind: "skill",
        requested_effects: ["network"],
        schema_version: 1,
      }), "utf8")),
    ).toThrow(/component/u);
    expect(() =>
      parsePluginManifestBytes(Buffer.from(JSON.stringify({
        components: { skills: ["CON.json"] },
        description: "Valid description.",
        display_name: "Acme",
        plugin_id: "acme",
        plugin_version: "1",
        schema_version: 1,
      }), "utf8")),
    ).toThrow(/manifest/u);
    expect(() =>
      parsePluginManifestBytes(Buffer.from(JSON.stringify({
        components: { skills: ["nested/bad:name.json"] },
        description: "Valid description.",
        display_name: "Acme",
        plugin_id: "acme",
        plugin_version: "1",
        schema_version: 1,
      }), "utf8")),
    ).toThrow(/manifest/u);
    expect(() =>
      parsePluginManifestBytes(Buffer.from(JSON.stringify({
        components: { skills: ["Skill.json", "skill.json"] },
        description: "Valid description.",
        display_name: "Acme",
        plugin_id: "acme",
        plugin_version: "1",
        schema_version: 1,
      }), "utf8")),
    ).toThrow(/manifest/u);
  });

  it("keeps digest independent of root and mtime while binding every path and byte", async () => {
    const base = await root();
    const firstRoot = join(base, "first");
    const secondRoot = join(base, "second");
    const first = await writeTestCapabilityPackage(firstRoot, {
      extraFiles: { "notes.txt": "same bytes\n" },
    });
    const second = await writeTestCapabilityPackage(secondRoot, {
      extraFiles: { "notes.txt": "same bytes\n" },
    });
    expect(second.pluginSha256).toBe(first.pluginSha256);

    await utimes(join(secondRoot, "notes.txt"), new Date(1_000), new Date(2_000));
    expect((await StablePackageReader.read(secondRoot)).pluginSha256).toBe(
      first.pluginSha256,
    );
    await writeFile(join(secondRoot, "notes.txt"), "different bytes\n", "utf8");
    expect((await StablePackageReader.read(secondRoot)).pluginSha256).not.toBe(
      first.pluginSha256,
    );
    await writeFile(join(firstRoot, "unreferenced.ps1"), "exit 99\n", "utf8");
    expect((await StablePackageReader.read(firstRoot)).pluginSha256).not.toBe(
      first.pluginSha256,
    );
  });

  it("rejects hard-link aliases, depth overflow, and package byte overflow", async () => {
    const base = await root();
    const linkedRoot = join(base, "linked");
    await writeTestCapabilityPackage(linkedRoot);
    await link(join(linkedRoot, "SKILL.md"), join(linkedRoot, "alias.md"));
    await expect(StablePackageReader.read(linkedRoot)).rejects.toMatchObject({
      code: "capability_source_untrusted",
    });

    const deepRoot = join(base, "deep");
    await writeTestCapabilityPackage(deepRoot, {
      extraFiles: {
        "a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q.txt": "too deep",
      },
    }).catch(() => undefined);
    await expect(StablePackageReader.read(deepRoot)).rejects.toMatchObject({
      code: "capability_limit_exceeded",
    });

    const largeRoot = join(base, "large");
    await writeTestCapabilityPackage(largeRoot);
    await writeFile(
      join(largeRoot, "oversized.bin"),
      Buffer.alloc(MAX_CAPABILITY_PACKAGE_BYTES + 1),
    );
    await expect(StablePackageReader.read(largeRoot)).rejects.toMatchObject({
      code: "capability_limit_exceeded",
    });

    const countRoot = join(base, "count");
    await writeTestCapabilityPackage(countRoot);
    await Promise.all(
      Array.from({ length: 510 }, (_, index) =>
        writeFile(
          join(countRoot, `extra-${String(index).padStart(3, "0")}.txt`),
          "x",
          "utf8",
        ),
      ),
    );
    await expect(StablePackageReader.read(countRoot)).rejects.toMatchObject({
      code: "capability_limit_exceeded",
    });
  });
});
