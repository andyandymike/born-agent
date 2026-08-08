import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadAcceptedRepositoryEngineDecision } from "../../src/repository-intelligence/engine-decision-loader.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Phase 17C accepted engine decision", () => {
  it("loads the exact checked-in decision, runtime version, and asset lock", async () => {
    const loaded = await loadAcceptedRepositoryEngineDecision(resolve("."));
    expect(loaded.decision.status).toBe("accepted");
    expect(loaded.identity).toMatchObject({ engineKind: "language_service", engineVersion: "6.0.3" });
    expect(loaded.identity.languageCapabilities.find((entry) => entry.language === "typescript")).toMatchObject({
      definitions: "semantic",
      references: "semantic",
    });
  });

  it("rejects a tampered decision instead of trusting repository or server claims", async () => {
    const root = await mkdtemp(join(tmpdir(), "bornagent-phase17c-decision-"));
    temporary.push(root);
    const target = join(root, "policies", "repository-intelligence");
    await cp(resolve("policies/repository-intelligence"), target, { recursive: true });
    const path = join(target, "engine-v1.json");
    const decision = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    decision.securityGatePassed = false;
    await writeFile(path, JSON.stringify(decision), "utf8");
    await expect(loadAcceptedRepositoryEngineDecision(root)).rejects.toMatchObject({ code: "repository_engine_decision_invalid" });
  });
});
