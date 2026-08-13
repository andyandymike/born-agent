import { describe, expect, it, vi } from "vitest";

import { requestTuiHumanCancel } from "../../src/tui/tui-human-cancel-authority.js";

describe("Phase 21A TUI human cancel authority", () => {
  it("fails closed without an exact durable target", () => {
    const legacyAbort = vi.fn();
    const report = vi.fn();
    const request = vi.fn();
    requestTuiHumanCancel({
      applicationControlEnabled: true,
      exactTarget: null,
      legacyAbort,
      report,
      request,
    });
    expect(request).not.toHaveBeenCalled();
    expect(legacyAbort).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(expect.stringContaining("no raw abort"));
  });

  it("does not downgrade a rejected or failed application request to raw abort", async () => {
    for (const outcome of ["rejected", "failed"] as const) {
      const legacyAbort = vi.fn();
      const report = vi.fn();
      requestTuiHumanCancel({
        applicationControlEnabled: true,
        exactTarget: { runId: "run", sessionId: "session" },
        legacyAbort,
        report,
        request: outcome === "rejected"
          ? async () => ({ diagnostic: "durable journal rejected", exitCode: 8 })
          : async () => { throw new Error("secret sentinel"); },
      });
      await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
      expect(legacyAbort).not.toHaveBeenCalled();
      expect(JSON.stringify(report.mock.calls)).not.toContain("secret sentinel");
    }
  });

  it("retains raw abort only for an explicit legacy runtime", () => {
    const legacyAbort = vi.fn();
    requestTuiHumanCancel({
      applicationControlEnabled: false,
      exactTarget: null,
      legacyAbort,
      report: vi.fn(),
      request: vi.fn(),
    });
    expect(legacyAbort).toHaveBeenCalledOnce();
  });
});
