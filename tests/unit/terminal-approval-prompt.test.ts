import { describe, expect, it, vi } from "vitest";

import { TerminalApprovalPrompt } from "../../src/approvals/terminal-approval-prompt.js";

const preview = {
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
});
