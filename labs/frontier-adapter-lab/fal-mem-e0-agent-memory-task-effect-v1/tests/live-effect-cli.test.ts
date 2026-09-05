import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { phase8NetworkActivityReport } from "../../../../tests/setup-network-tripwire.js";
import { MEM_E0_LIVE_UPPER_BOUND_USD_MICROS } from "../src/live-preflight.js";
import { runMemE0LiveEffectCli } from "../tools/run-live-effect.js";

const CACHE = ".cache/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1";

describe("MEM-E0 effect CLI zero-call gates", () => {
  it("requires exact authorization flags and rejects unknown, repeated and escaping paths", async () => {
    const live = ["live", "--plan", `${CACHE}/effect/plans/test.json`, "--output", `${CACHE}/effect/receipts/test.json`,
      "--confirm-plan-sha256", "a".repeat(64), "--confirm-cost-usd-micros", String(MEM_E0_LIVE_UPPER_BOUND_USD_MICROS)];
    for (const args of [live, [...live, "--authorize-remote", "--unknown"],
      [...live, "--authorize-remote", "--authorize-remote"],
      live.map((item) => item === String(MEM_E0_LIVE_UPPER_BOUND_USD_MICROS) ? "54814" : item),
      [...live.map((item) => item === `${CACHE}/effect/receipts/test.json` ? "../escaped.json" : item), "--authorize-remote"]]) {
      await expect(runMemE0LiveEffectCli(args)).rejects.toThrow();
    }
    expect(phase8NetworkActivityReport().remoteProviderRequestCount).toBe(0);
  });

  it("never overwrites an existing receipt, even before reading its input plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "mem-e0-effect-cli-offline-"));
    const path = `${CACHE}/effect/receipts/existing.json`;
    try {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), "retained receipt bytes\n", { flag: "wx" });
      await expect(runMemE0LiveEffectCli(["live", "--plan", `${CACHE}/effect/plans/missing.json`, "--output", path,
        "--authorize-remote", "--confirm-plan-sha256", "a".repeat(64), "--confirm-cost-usd-micros", String(MEM_E0_LIVE_UPPER_BOUND_USD_MICROS)], root)).rejects.toThrow();
      expect(await readFile(join(root, path), "utf8")).toBe("retained receipt bytes\n");
      expect(phase8NetworkActivityReport().remoteProviderRequestCount).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("writes hash-only failure evidence for malformed input without exposing raw data", async () => {
    const root = await mkdtemp(join(tmpdir(), "mem-e0-effect-cli-offline-"));
    const plan = `${CACHE}/effect/plans/invalid.json`;
    const receipt = `${CACHE}/effect/receipts/invalid.json`;
    try {
      await mkdir(dirname(join(root, plan)), { recursive: true });
      await writeFile(join(root, plan), '{"privateSentinel":"never-in-error","privateSentinel":2}', { flag: "wx" });
      await expect(runMemE0LiveEffectCli(["live", "--plan", plan, "--output", receipt, "--authorize-remote",
        "--confirm-plan-sha256", "a".repeat(64), "--confirm-cost-usd-micros", String(MEM_E0_LIVE_UPPER_BOUND_USD_MICROS)], root)).rejects.toThrow();
      const raw = await readFile(join(root, receipt), "utf8");
      expect(raw).not.toContain("privateSentinel");
      expect(raw).not.toContain(root);
      expect(JSON.parse(raw)).toEqual({ code: "mem_e0_effect_command_failed", effectClaimAllowed: false,
        failureSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      expect(phase8NetworkActivityReport().remoteProviderRequestCount).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
