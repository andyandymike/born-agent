import { describe, expect, it } from "vitest";

import { BoundedOutputCapture } from "../../src/execution/output-capture.js";

describe("Phase 6 bounded output capture", () => {
  it("redacts across chunks before exposing output and strips split terminal controls", () => {
    const secret = "paid-provider-secret";
    const capture = new BoundedOutputCapture(1024, {
      redact: (value) => value.replaceAll(secret, "[redacted]"),
    });

    const first = capture.append(
      "stdout",
      Buffer.from(`before:${secret.slice(0, 8)}`),
    );
    const second = capture.append(
      "stdout",
      Buffer.from(`${secret.slice(8)}\u001b[`),
    );
    const third = capture.append(
      "stdout",
      Buffer.from("31m:after\u001b[0m\n"),
    );

    expect(first.text).toBe("");
    expect(second.text).toBe("");
    expect(third.text).toBe("");
    const completedChunks = capture.finish();
    expect(completedChunks).toHaveLength(1);
    expect(completedChunks[0]?.text).toBe("before:[redacted]:after\n");
    expect(capture.stdout).not.toContain(secret);
    expect(capture.stdout).not.toContain("\u001b");
    expect(capture.stdoutBytes).toBe(
      new TextEncoder().encode(capture.stdout).byteLength,
    );
  });

  it("uses deterministic UTF-8 replacement for invalid bytes", () => {
    const capture = new BoundedOutputCapture(64);
    capture.append("stderr", Uint8Array.from([0xc3]));
    capture.append("stderr", Uint8Array.from([0x28]));
    capture.finish();

    expect(capture.stderr).toBe("�(");
    expect(capture.stderrBytes).toBe(4);
  });

  it("removes C1 and bidi terminal control characters", () => {
    const capture = new BoundedOutputCapture(64);
    capture.append("stdout", Buffer.from("left\u0085\u202eright"));
    capture.finish();
    expect(capture.stdout).toBe("leftright");
  });

  it("triggers at the exact shared raw-byte boundary", () => {
    const capture = new BoundedOutputCapture(5);
    const first = capture.append("stdout", Buffer.from("abc"));
    const boundary = capture.append("stderr", Buffer.from("de"));
    const afterBoundary = capture.append("stdout", Buffer.from("ignored"));
    capture.finish();

    expect(first.limitExceeded).toBe(false);
    expect(boundary.limitExceeded).toBe(true);
    expect(afterBoundary.acceptedBytes).toBe(0);
    expect(capture.truncated).toBe(true);
    expect(capture.stdout).toBe("abc");
    expect(capture.stderr).toBe("de");
    expect(capture.stdoutRawAcceptedBytes + capture.stderrRawAcceptedBytes).toBe(5);
  });

  it("also bounds UTF-8 replacement or redaction expansion", () => {
    const invalid = new BoundedOutputCapture(1);
    invalid.append("stdout", Uint8Array.from([0xff]));
    invalid.finish();
    expect(invalid.stdoutBytes).toBeLessThanOrEqual(1);

    const expanded = new BoundedOutputCapture(3, {
      redact: (value) => value.replaceAll("x", "replacement"),
    });
    expanded.append("stdout", Buffer.from("xxx"));
    expanded.finish();
    expect(expanded.stdoutBytes).toBeLessThanOrEqual(3);
    expect(expanded.truncated).toBe(true);
  });
});
