import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("FAL-EM-R1 product isolation", () => {
  it("keeps the runtime, model, and candidate outside production compilation and packing", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      readonly dependencies: Record<string, string>;
      readonly files: readonly string[];
    };
    const buildConfig = JSON.parse(await readFile("tsconfig.build.json", "utf8")) as {
      readonly include: readonly string[];
    };

    expect(packageJson.dependencies).not.toHaveProperty("@huggingface/transformers");
    expect(packageJson.dependencies).not.toHaveProperty("undici");
    expect(packageJson.files.some((entry) => entry.startsWith("labs"))).toBe(false);
    expect(packageJson.files.some((entry) => entry.includes("fal-em-r1"))).toBe(false);
    expect(buildConfig.include).toEqual(["src/**/*.ts"]);
  });
});
