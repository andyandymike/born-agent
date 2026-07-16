import { describe, expect, it } from "vitest";

import { BudgetTracker } from "../../src/agent/budget-tracker.js";
import {
  RepetitionDetector,
  toolCallFingerprint,
} from "../../src/agent/repetition-detector.js";

const config = {
  maxDurationMs: 1000,
  maxSteps: 2,
  maxTokens: 10,
  maxToolOutputBytes: 65_536,
  requestTimeoutMs: 1000,
};

describe("BudgetTracker", () => {
  it("uses reported tokens and UTF-8 bytes without estimates", () => {
    let now = 100;
    const budget = new BudgetTracker(config, { now: () => now }, 100);
    expect(budget.beginStep()).toBe(1);
    budget.recordUsage({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
    budget.recordToolOutput("中🙂");
    now = 250;
    expect(budget.snapshot()).toEqual({
      elapsedMs: 150,
      steps: 1,
      toolOutputBytes: 7,
      totalTokens: 5,
    });
    expect(budget.remaining()).toEqual({
      durationMs: 850,
      tokens: 5,
      toolOutputBytes: 65_529,
    });
  });

  it("treats equality as exhausted and keeps fixed pre-step priority", () => {
    const budget = new BudgetTracker(config, { now: () => 0 }, 0);
    budget.beginStep();
    budget.beginStep();
    budget.recordUsage({ inputTokens: 5, outputTokens: 5, totalTokens: 10 });
    expect(budget.checkBeforeStep()).toEqual({
      limit: 2,
      observed: 2,
      reason: "max_steps",
    });
    expect(budget.checkAfterModelForMoreWork()).toEqual({
      limit: 10,
      observed: 10,
      reason: "max_tokens",
    });
  });
});

describe("RepetitionDetector", () => {
  it("canonicalizes recursively sorted JSON keys", () => {
    expect(
      toolCallFingerprint("read_file", '{"b":2,"a":{"z":1,"y":0}}'),
    ).toBe(
      toolCallFingerprint("read_file", '{ "a": {"y":0,"z":1}, "b":2 }'),
    );
  });

  it("allows two consecutive calls, blocks the third, and resets on change", () => {
    const detector = new RepetitionDetector();
    expect(detector.observe("search", '{"query":"x"}')).toMatchObject({
      blocked: false,
      count: 1,
    });
    expect(detector.observe("search", '{"query":"x"}')).toMatchObject({
      blocked: false,
      count: 2,
    });
    expect(detector.observe("search", '{"query":"x"}')).toMatchObject({
      blocked: true,
      count: 3,
    });
    expect(detector.observe("search", '{"query":"y"}')).toMatchObject({
      blocked: false,
      count: 1,
    });
  });

  it("hashes invalid JSON without storing the original text", () => {
    const raw = "not-json-secret";
    const fingerprint = toolCallFingerprint("search", raw);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(fingerprint).not.toContain(raw);
  });
});
