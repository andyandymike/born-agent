import { describe, expect, it, vi } from "vitest";

import { TerminalApprovalPrompt } from "../../src/approvals/terminal-approval-prompt.js";

const preview = {
  actionKind: "apply_patch" as const,
  addedLines: 2,
  paths: [{ kind: "modify" as const, path: "src/math.ts" }],
  planId: "a".repeat(64),
  preview: "@@ -1 +1 @@\n-old\n+new",
  previewTruncated: false,
  removedLines: 1,
};

function prompt(options: {
  readonly answer: string | null;
  readonly interactive: boolean;
}) {
  let output = "";
  const readLine = vi.fn(async () => options.answer);
  return {
    prompt: new TerminalApprovalPrompt({
      interactive: options.interactive,
      output: { write: (value) => void (output += value) },
      readLine,
    }),
    readLine,
    readOutput: () => output,
  };
}

describe("TerminalApprovalPrompt", () => {
  it("approves only an explicit lowercase-insensitive y", async () => {
    const fixture = prompt({ answer: " Y ", interactive: true });
    await expect(
      fixture.prompt.request(preview, new AbortController().signal),
    ).resolves.toBe("approved");
    expect(fixture.readOutput()).toContain("src/math.ts");
    expect(fixture.readOutput()).toContain("[y/N]");
  });

  it.each([null, "", "yes", "n"])(
    "denies EOF and non-y answer %j",
    async (answer) => {
      const fixture = prompt({ answer, interactive: true });
      await expect(
        fixture.prompt.request(preview, new AbortController().signal),
      ).resolves.toBe("denied");
    },
  );

  it("denies non-interactive input without reading it", async () => {
    const fixture = prompt({ answer: "y", interactive: false });
    await expect(
      fixture.prompt.request(preview, new AbortController().signal),
    ).resolves.toBe("denied");
    expect(fixture.readLine).not.toHaveBeenCalled();
    expect(fixture.readOutput()).toContain("interactive stdin/stderr required");
  });

  it("maps an aborted prompt to cancellation", async () => {
    const fixture = prompt({ answer: "y", interactive: true });
    const controller = new AbortController();
    controller.abort();
    await expect(
      fixture.prompt.request(preview, controller.signal),
    ).resolves.toBe("cancelled");
    expect(fixture.readLine).not.toHaveBeenCalled();
  });

  it("renders command argv without inventing a shell command string", async () => {
    const fixture = prompt({ answer: "n", interactive: true });
    await expect(
      fixture.prompt.request(
        {
          actionKind: "run_command",
          actionSha256: "b".repeat(64),
          args: ["scripts/pass.mjs", ";", "not-a-second-command"],
          cwd: "fixtures/phase-06-command-execution",
          executable: "node",
          purpose: "inspect",
          reviewLines: [],
          riskWarning: "repository code may perform additional host side effects",
        },
        new AbortController().signal,
      ),
    ).resolves.toBe("denied");
    expect(fixture.readOutput()).toContain("argv[1]: ;");
    expect(fixture.readOutput()).toContain("repository code may perform");
    expect(fixture.readOutput()).not.toContain("node scripts/pass.mjs ;");
  });
});
