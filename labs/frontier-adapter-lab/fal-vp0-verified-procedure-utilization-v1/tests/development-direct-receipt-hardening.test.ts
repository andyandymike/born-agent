import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isExactProductionDevelopmentDirectExecutor,
  ProductionDevelopmentDirectExecutor,
} from "../src/development-direct-executor.js";
import { captureDevelopmentDirectRepositoryProvenance } from
  "../src/development-direct-runner.js";

const repositoryRoot = process.cwd();

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("development direct paid receipt hardening", () => {
  it("accepts only the module-branded exact production class, never a subclass", () => {
    class ProductionSubclass extends ProductionDevelopmentDirectExecutor {}

    const exact = new ProductionDevelopmentDirectExecutor();
    const subclass = new ProductionSubclass();

    expect(Object.isFrozen(exact)).toBe(true);
    expect(isExactProductionDevelopmentDirectExecutor(exact)).toBe(true);
    expect(isExactProductionDevelopmentDirectExecutor(subclass)).toBe(false);
  });

  it("binds git state and the raw bytes of every critical direct-lane implementation", async () => {
    const provenance = await captureDevelopmentDirectRepositoryProvenance(repositoryRoot);
    const refs = {
      developmentDirectExecutor:
        "labs/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/src/development-direct-executor.ts",
      developmentDirectFixture:
        "labs/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/src/development-direct-fixture.ts",
      developmentDirectRunner:
        "labs/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/src/development-direct-runner.ts",
      developmentPilotFixture:
        "labs/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/src/development-pilot-fixture.ts",
      developmentPilotWorkspace:
        "labs/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/src/development-pilot-workspace.ts",
      piModelBackend: "src/providers/pi/pi-model-backend.ts",
      productionPiRuntimePort: "src/providers/pi/production-pi-runtime-port.ts",
      runDevelopmentDirectPilotCli:
        "labs/frontier-adapter-lab/fal-vp0-verified-procedure-utilization-v1/tools/run-development-direct-pilot.ts",
    } as const;

    expect(provenance.gitHead).toMatch(/^[0-9a-f]{40,64}$/u);
    expect(typeof provenance.gitDirty).toBe("boolean");
    expect(provenance.gitStatusPorcelainSha256).toMatch(/^[0-9a-f]{64}$/u);
    for (const [key, ref] of Object.entries(refs)) {
      const expected = sha256(await readFile(resolve(repositoryRoot, ...ref.split("/"))));
      expect(provenance.implementationRawSha256[
        key as keyof typeof provenance.implementationRawSha256
      ]).toBe(expected);
    }
    expect(JSON.stringify(provenance)).not.toContain(repositoryRoot);
  });
});
