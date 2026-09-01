import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  sha256Canonical,
} from "../../../../src/completion/canonical-json.js";
import {
  runMemE0ActorQualificationCli,
  type MemE0ActorQualificationCliDependencies,
} from "../tools/run-actor-qualification.js";

const REPOSITORY_ROOT = resolve(".");
const DS0_OBSERVATION =
  ".cache/frontier-adapter-lab/fal-ds0-deepseek-tool-actor-v1/runs/ds0-00000000-0000-0000-0000-000000000000/observation.json";
const PLAN_OUTPUT =
  ".cache/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/qualification/plans/plan-v1.json";
const RECEIPT_OUTPUT =
  ".cache/frontier-adapter-lab/fal-mem-e0-agent-memory-task-effect-v1/qualification/receipts/receipt-v1.json";
const HASHES = Object.freeze({
  ds0Observation: "1".repeat(64),
  ds0Record: "2".repeat(64),
  ds0Reference: "3".repeat(64),
  freeze: "4".repeat(64),
  tree: "5".repeat(64),
});
const SOURCE_COMMIT = "6".repeat(40);

class BufferWriter {
  value = "";

  write(chunk: string): void {
    this.value += chunk;
  }
}

function selfHashed(
  content: Readonly<Record<string, unknown>>,
  field: "planSha256" | "receiptSha256",
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...content,
    [field]: sha256Canonical(content),
  });
}

function plannedResult(): Readonly<{
  readonly plan: Readonly<Record<string, unknown>>;
  readonly receipt: Readonly<Record<string, unknown>>;
}> {
  const freeze = Object.freeze({ actorFreezeSha256: HASHES.freeze });
  const source = Object.freeze({
    commit: SOURCE_COMMIT,
    protectedTreeSha256: HASHES.tree,
  });
  const task = Object.freeze({ taskSha256: "7".repeat(64) });
  const plan = selfHashed({
    cost: Object.freeze({ maximumAuthorizedCostUsdMicros: 33_609 }),
    ds0: Object.freeze({
      observationReferenceSha256: HASHES.ds0Reference,
      observationSha256: HASHES.ds0Observation,
      recordSha256: HASHES.ds0Record,
    }),
    freeze,
    source,
    task,
  }, "planSha256");
  const receipt = selfHashed({
    effectClaimAllowed: false,
    freeze,
    providerCalls: 0,
    result: Object.freeze({ status: "not_run" }),
    source,
    task,
  }, "receiptSha256");
  return Object.freeze({ plan, receipt });
}

function liveReceipt(
  providerCalls = 4,
  status: "failed" | "passed" = "passed",
): Readonly<Record<string, unknown>> {
  return selfHashed({
    effectClaimAllowed: false,
    providerCalls,
    result: Object.freeze({ status }),
  }, "receiptSha256");
}

function counters() {
  return {
    close: 0,
    createDirectory: 0,
    open: 0,
    plan: 0,
    read: 0,
    run: 0,
    sync: 0,
    write: 0,
    written: "",
  };
}

function dependencies(
  values: ReturnType<typeof counters>,
  overrides: Partial<MemE0ActorQualificationCliDependencies> = {},
): Partial<MemE0ActorQualificationCliDependencies> & Readonly<{
  readonly stderr: BufferWriter;
  readonly stdout: BufferWriter;
}> {
  const stdout = new BufferWriter();
  const stderr = new BufferWriter();
  return {
    createDirectory: async () => {
      values.createDirectory += 1;
    },
    openExclusive: async () => {
      values.open += 1;
      return {
        close: async () => {
          values.close += 1;
        },
        sync: async () => {
          values.sync += 1;
        },
        write: async (value: string) => {
          values.write += 1;
          values.written += value;
        },
      };
    },
    plan: async () => {
      values.plan += 1;
      return plannedResult();
    },
    readText: async () => {
      values.read += 1;
      throw new Error("unexpected plan read");
    },
    repositoryRoot: REPOSITORY_ROOT,
    run: async () => {
      values.run += 1;
      return liveReceipt();
    },
    writeExclusive: async (_path: string, value: string) => {
      values.write += 1;
      values.written += value;
    },
    ...overrides,
    stderr,
    stdout,
  };
}

function liveArguments(plan: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.freeze([
    "live",
    "--plan",
    PLAN_OUTPUT,
    "--ds0-observation",
    DS0_OBSERVATION,
    "--output",
    RECEIPT_OUTPUT,
    "--authorize-remote",
    "--confirm-plan-sha256",
    String(plan.planSha256),
    "--confirm-freeze-sha256",
    HASHES.freeze,
    "--confirm-source-commit",
    SOURCE_COMMIT,
    "--confirm-protected-tree-sha256",
    HASHES.tree,
    "--confirm-ds0-reference-sha256",
    HASHES.ds0Reference,
    "--confirm-ds0-observation-sha256",
    HASHES.ds0Observation,
    "--confirm-ds0-record-sha256",
    HASHES.ds0Record,
    "--confirm-cost-usd-micros",
    "33609",
  ]);
}

async function createPlanEnvelope(): Promise<Readonly<{
  readonly plan: Readonly<Record<string, unknown>>;
  readonly raw: string;
}>> {
  const values = counters();
  const deps = dependencies(values);
  const code = await runMemE0ActorQualificationCli([
    "plan",
    "--ds0-observation",
    DS0_OBSERVATION,
  ], deps);
  expect(code).toBe(0);
  const decoded = JSON.parse(deps.stdout.value) as Readonly<{
    readonly envelopeSha256: string;
    readonly plan: Readonly<Record<string, unknown>>;
  }>;
  return Object.freeze({ plan: decoded.plan, raw: deps.stdout.value });
}

describe("MEM-E0 actor qualification CLI", () => {
  it("prints help without calling plan, run, file reads, or output creation", async () => {
    const values = counters();
    const deps = dependencies(values);
    const code = await runMemE0ActorQualificationCli([
      "--help",
      "--unknown-option",
    ], deps);

    expect(code).toBe(0);
    expect(deps.stdout.value).toContain("Plan only (always zero remote calls)");
    expect(deps.stderr.value).toBe("");
    expect(values).toMatchObject({
      createDirectory: 0,
      open: 0,
      plan: 0,
      read: 0,
      run: 0,
      write: 0,
    });
  });

  it("creates a self-hashed plan plus not-run receipt without invoking live run", async () => {
    const values = counters();
    const deps = dependencies(values);
    const code = await runMemE0ActorQualificationCli([
      "plan",
      "--ds0-observation",
      DS0_OBSERVATION,
    ], deps);

    expect(code).toBe(0);
    expect(values.plan).toBe(1);
    expect(values.run).toBe(0);
    expect(values.read).toBe(0);
    expect(values.open).toBe(0);
    const envelope = JSON.parse(deps.stdout.value) as Readonly<
      Record<string, unknown>
    >;
    const { envelopeSha256, ...content } = envelope;
    expect(envelopeSha256).toBe(sha256Canonical(content));
    expect(envelope).toMatchObject({
      envelopeType:
        "mem-e0-deepseek-tool-actor-qualification-plan-envelope-v1",
      receipt: {
        effectClaimAllowed: false,
        providerCalls: 0,
        result: { status: "not_run" },
      },
      schemaVersion: 1,
    });
  });

  it("optionally writes the plan envelope once through the exclusive cache seam", async () => {
    const values = counters();
    const deps = dependencies(values);
    const code = await runMemE0ActorQualificationCli([
      "plan",
      "--ds0-observation",
      DS0_OBSERVATION,
      "--output",
      PLAN_OUTPUT,
    ], deps);

    expect(code).toBe(0);
    expect(values).toMatchObject({
      createDirectory: 1,
      plan: 1,
      run: 0,
      write: 1,
    });
    expect(values.written).toBe(deps.stdout.value);
  });

  it("rejects missing live authorization before plan reads, output creation, or run", async () => {
    const values = counters();
    const deps = dependencies(values);
    const code = await runMemE0ActorQualificationCli([
      "live",
      "--ds0-observation",
      DS0_OBSERVATION,
    ], deps);

    expect(code).toBe(1);
    expect(deps.stderr.value).toBe(
      "MEM-E0 actor qualification command failed.\n",
    );
    expect(deps.stderr.value).not.toContain(REPOSITORY_ROOT);
    expect(values).toMatchObject({
      createDirectory: 0,
      open: 0,
      plan: 0,
      read: 0,
      run: 0,
      write: 0,
    });
  });

  it("rejects an out-of-scope DS0 path before either runner entrypoint", async () => {
    const values = counters();
    const deps = dependencies(values);
    const code = await runMemE0ActorQualificationCli([
      "plan",
      "--ds0-observation",
      ".cache/frontier-adapter-lab/other/runs/x/observation.json",
    ], deps);

    expect(code).toBe(1);
    expect(values.plan).toBe(0);
    expect(values.run).toBe(0);
  });

  it("passes an exact self-hashed authorization to run and wx-syncs the receipt", async () => {
    const saved = await createPlanEnvelope();
    const values = counters();
    let observedRunInput: Readonly<Record<string, unknown>> | null = null;
    const deps = dependencies(values, {
      readText: async () => {
        values.read += 1;
        return saved.raw;
      },
      run: async (input) => {
        values.run += 1;
        observedRunInput = input;
        return liveReceipt();
      },
    });
    const code = await runMemE0ActorQualificationCli(
      liveArguments(saved.plan),
      deps,
    );

    expect(code).toBe(0);
    expect(values).toMatchObject({
      close: 1,
      createDirectory: 1,
      open: 1,
      read: 1,
      run: 1,
      sync: 1,
      write: 1,
    });
    expect(observedRunInput).toMatchObject({
      authorization: {
        actorFreezeSha256Confirmation: HASHES.freeze,
        authorizeRemote: true,
        ds0ObservationReferenceSha256Confirmation: HASHES.ds0Reference,
        ds0ObservationSha256Confirmation: HASHES.ds0Observation,
        maximumAuthorizedCostUsdMicros: 33_609,
        modelQualificationRecordSha256Confirmation: HASHES.ds0Record,
        planSha256Confirmation: saved.plan.planSha256,
        protectedTreeSha256Confirmation: HASHES.tree,
        sourceCommitConfirmation: SOURCE_COMMIT,
      },
      plan: saved.plan,
      repositoryRoot: REPOSITORY_ROOT,
    });
    const written = JSON.parse(values.written) as Readonly<
      Record<string, unknown>
    >;
    const { receiptSha256, ...content } = written;
    expect(receiptSha256).toBe(sha256Canonical(content));
    expect(deps.stdout.value).toContain("qualification_receipt_written");
  });

  it("does not call run or create a receipt when an exact confirmation mismatches", async () => {
    const saved = await createPlanEnvelope();
    const values = counters();
    const deps = dependencies(values, {
      readText: async () => {
        values.read += 1;
        return saved.raw;
      },
    });
    const args = [...liveArguments(saved.plan)];
    const confirmationIndex = args.indexOf("--confirm-plan-sha256") + 1;
    args[confirmationIndex] = "f".repeat(64);
    const code = await runMemE0ActorQualificationCli(args, deps);

    expect(code).toBe(1);
    expect(values).toMatchObject({ open: 0, read: 1, run: 0, write: 0 });
  });

  it("retains a scorer-derived failed receipt with an exact zero provider-call count", async () => {
    const saved = await createPlanEnvelope();
    const values = counters();
    const deps = dependencies(values, {
      readText: async () => saved.raw,
      run: async () => {
        values.run += 1;
        return liveReceipt(0, "failed");
      },
    });
    const code = await runMemE0ActorQualificationCli(
      liveArguments(saved.plan),
      deps,
    );

    expect(code).toBe(0);
    expect(JSON.parse(values.written)).toMatchObject({
      providerCalls: 0,
      result: { status: "failed" },
    });
    expect(values.run).toBe(1);
  });

  it("writes only a fixed self-hashed hygiene envelope when authorized run throws", async () => {
    const saved = await createPlanEnvelope();
    const values = counters();
    const deps = dependencies(values, {
      readText: async () => {
        values.read += 1;
        return saved.raw;
      },
      run: async () => {
        values.run += 1;
        throw new Error(
          `RAW_SECRET at ${REPOSITORY_ROOT} provider response leaked`,
        );
      },
    });
    const code = await runMemE0ActorQualificationCli(
      liveArguments(saved.plan),
      deps,
    );

    expect(code).toBe(1);
    expect(values).toMatchObject({
      close: 1,
      open: 1,
      run: 1,
      sync: 1,
      write: 1,
    });
    const envelope = JSON.parse(values.written) as Readonly<
      Record<string, unknown>
    >;
    const { failureEnvelopeSha256, ...content } = envelope;
    expect(failureEnvelopeSha256).toBe(sha256Canonical(content));
    expect(envelope).toMatchObject({
      accountedMaximumCostUsdMicros: 33_609,
      hygiene: {
        absolutePathsPersisted: false,
        rawErrorsPersisted: false,
        rawProviderDataPersisted: false,
        rawToolOutputPersisted: false,
        secretsPersisted: false,
      },
      providerCalls: "unknown_after_authorized_attempt",
      status: "qualification_failed_without_receipt",
    });
    expect(values.written).not.toContain("RAW_SECRET");
    expect(values.written).not.toContain(REPOSITORY_ROOT);
    expect(deps.stderr.value).toBe(
      "MEM-E0 actor qualification command failed.\n",
    );
  });

  it("rejects default and unknown arguments with one fixed sanitized message", async () => {
    for (const argv of [[], ["unknown"], ["plan", "--unknown"]] as const) {
      const values = counters();
      const deps = dependencies(values);
      expect(await runMemE0ActorQualificationCli(argv, deps)).toBe(1);
      expect(deps.stderr.value).toBe(
        "MEM-E0 actor qualification command failed.\n",
      );
      expect(values.plan).toBe(0);
      expect(values.run).toBe(0);
    }
  });
});
