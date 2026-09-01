import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { CliIO } from "../../../../src/cli/types.js";
import type {
  ModelBackend,
  ModelTurnRequest,
} from "../../../../src/model/model-backend.js";
import type { ModelEvent } from "../../../../src/model/model-events.js";

import {
  DS0_LIVE_CONFIRMATION_USD,
  readDs0Contract,
} from "../src/ds0-contract.js";
import {
  ds0ActorCostSnapshot,
  ds0CodingSystemInstructionSha256,
  ds0UnreportedRequestCount,
  extractDs0TerminalRunFailure,
  runDs0Cli,
} from "../src/live-runner.js";
import {
  aggregateDs0Usage,
  Ds0ProviderMeter,
  estimateDs0Cost,
} from "../src/provider-meter.js";

function output(): Readonly<{
  readonly io: CliIO;
  readonly stderr: () => string;
  readonly stdout: () => string;
}> {
  let stderr = "";
  let stdout = "";
  return {
    io: {
      stderr: { write: (value) => { stderr += value; } },
      stdout: { write: (value) => { stdout += value; } },
    },
    stderr: () => stderr,
    stdout: () => stdout,
  };
}

const repositoryRoot = resolve(".");

describe("FAL DS0 live runner authorization and accounting", () => {
  it("verifies the frozen Chat Completions contract and pricing hashes offline", async () => {
    const contract = await readDs0Contract(repositoryRoot);

    expect(contract.protocolSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(contract.pricingSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(contract.actorConservativePeakUpperBoundUsdMicros).toBeLessThanOrEqual(
      contract.actorMaximumEstimatedCostUsdMicros,
    );
    expect(ds0CodingSystemInstructionSha256()).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("extracts only whitelisted terminal failure facts and drops raw fields", () => {
    const failure = extractDs0TerminalRunFailure([{
      data: {
        category: "protocol",
        code: "multiple_tool_calls",
        message: "raw-provider-message-sentinel",
        provider_request_id: "provider-request-sentinel",
        retryable: false,
        steps: 1,
        tool_calls: 0,
      },
      scope: "run",
      type: "run.failed",
    }]);

    expect(failure).toEqual({
      category: "protocol",
      code: "multiple_tool_calls",
      steps: 1,
      tool_calls: 0,
    });
    expect(JSON.stringify(failure)).not.toContain("sentinel");
  });

  it("defaults to a zero-request dry run even when an ambient key exists", async () => {
    const memory = output();
    const authorizedExecutor = vi.fn(async () => 0 as const);

    await expect(runDs0Cli([], {
      authorizedExecutor,
      env: { DEEPSEEK_API_KEY: "sentinel-must-never-be-rendered" },
      io: memory.io,
      repositoryRoot,
    })).resolves.toBe(0);

    expect(authorizedExecutor).not.toHaveBeenCalled();
    expect(JSON.parse(memory.stdout())).toMatchObject({
      event: "ds0_dry_run_ready",
      providerRequests: 0,
      remoteCallsAuthorized: false,
    });
    expect(`${memory.stdout()}${memory.stderr()}`).not.toContain("sentinel");
  });

  it("requires all exact run-local confirmations before invoking the authorized executor", async () => {
    const contract = await readDs0Contract(repositoryRoot);
    const incomplete = output();
    const authorizedExecutor = vi.fn(async () => 0 as const);
    await expect(runDs0Cli([
      "--authorize-remote",
      "--confirm-max-usd",
      DS0_LIVE_CONFIRMATION_USD,
    ], {
      authorizedExecutor,
      env: {},
      io: incomplete.io,
      repositoryRoot,
    })).resolves.toBe(2);
    expect(authorizedExecutor).not.toHaveBeenCalled();
    expect(incomplete.stderr()).toMatch(/exact remote, USD-cap, and pricing/u);

    const exact = output();
    await expect(runDs0Cli([
      "--authorize-remote",
      "--confirm-max-usd",
      DS0_LIVE_CONFIRMATION_USD,
      "--confirm-pricing-sha256",
      contract.pricingSha256,
    ], {
      authorizedExecutor,
      env: {},
      io: exact.io,
      repositoryRoot,
    })).resolves.toBe(0);
    expect(authorizedExecutor).toHaveBeenCalledTimes(1);
  });

  it("meters requests before dispatch and prices normalized pi-ai usage", async () => {
    const backend: ModelBackend = {
      capabilities: {
        cancellation: "abort_signal",
        reasoning: "none",
        streaming: true,
        tools: "strict",
        usage: "complete",
      },
      identity: {
        adapter: "pi-ai",
        adapterVersion: "test",
        configFingerprint: "a".repeat(64),
        model: "deepseek-v4-flash",
        provider: "deepseek",
      },
      prepareTurnRequest: (request) => ({
        adapterEncodingVersion: "test",
        request,
      }),
      resume: {
        capability: "canonical_only",
        supportsCanonicalDegradedResume: true,
      },
      async *runTurn() {
        yield {
          type: "usage",
          usage: {
            cacheReadTokens: 500,
            cacheWriteTokens: 0,
            completeness: "complete",
            inputTokens: 1_000,
            outputTokens: 100,
            totalTokens: 1_600,
          },
        } as const;
      },
    };
    const request: ModelTurnRequest = {
      input: { kind: "user_prompt", text: "public smoke" },
      instructions: "bounded",
      timeoutMs: 1_000,
      tools: [],
    };
    const meter = new Ds0ProviderMeter("actor", 1, 60_000);
    const wrapped = meter.wrap(backend);
    for await (const event of wrapped.runTurn(
      request,
      new AbortController().signal,
    )) {
      // Consume the bounded fake stream.
      void event;
    }
    const requestCapEvents: ModelEvent[] = [];
    for await (const event of wrapped.runTurn(
      request,
      new AbortController().signal,
    )) {
      requestCapEvents.push(event);
    }
    expect(requestCapEvents).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({
          code: "ds0_provider_request_ceiling_exceeded",
        }),
        type: "failed",
      }),
    ]);

    const tokenMeter = new Ds0ProviderMeter("actor", 2, 1_000);
    const tokenWrapped = tokenMeter.wrap(backend);
    for await (const event of tokenWrapped.runTurn(
      request,
      new AbortController().signal,
    )) {
      // The billed usage remains visible even though it crosses the lab cap.
      void event;
    }
    expect(tokenMeter.reportedTokenCeilingExceeded).toBe(true);
    const tokenCapEvents: ModelEvent[] = [];
    for await (const event of tokenWrapped.runTurn(
      request,
      new AbortController().signal,
    )) {
      tokenCapEvents.push(event);
    }
    expect(tokenCapEvents).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({
          code: "ds0_reported_token_ceiling_exceeded",
        }),
        type: "failed",
      }),
    ]);

    const usage = aggregateDs0Usage(meter.usageEvents);
    expect(usage).toMatchObject({
      cacheReadTokens: 500,
      completeUsageEvents: 1,
      inputTokens: 1_000,
      outputTokens: 100,
      totalTokens: 1_600,
    });
    expect(estimateDs0Cost(usage, {
      cachedInput: 0.014,
      output: 1.32,
      uncachedInput: 0.44,
    }).costUsdMicros).toBe(579);

    expect(() => aggregateDs0Usage([{
      cacheReadTokens: 500,
      cacheWriteTokens: 0,
      completeness: "complete",
      inputTokens: 1_000,
      outputTokens: 100,
      totalTokens: 1_599,
    }])).toThrow(/does not equal normalized pi-ai token components/u);

    const contract = await readDs0Contract(repositoryRoot);
    expect(ds0ActorCostSnapshot(
      contract,
      aggregateDs0Usage([]),
      1,
      contract.offPeak,
    )).toMatchObject({
      applicableEstimatedUsdMicros: 74_427,
      peakEstimatedUsdMicros: 74_427,
      reserveUsdMicros: 74_427,
      unreportedRequestCount: 1,
    });
    expect(ds0UnreportedRequestCount(1, aggregateDs0Usage([{
      cacheReadTokens: null,
      cacheWriteTokens: null,
      completeness: "partial",
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    }]))).toBe(1);
  });
});
