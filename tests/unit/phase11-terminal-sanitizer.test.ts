import { describe, expect, it } from "vitest";

import { sanitizeTerminalText } from "../../src/tui/terminal-sanitizer.js";

describe("Phase 11 terminal sanitizer", () => {
  it("removes CSI, OSC, DCS, APC, PM, SOS, C1, and naked escapes", () => {
    const attack = [
      "before",
      "\u001b[2J",
      "\u001b]0;owned-title\u0007",
      "\u001b]52;c;Y2xpcGJvYXJk\u001b\\",
      "\u001b]8;;https://evil.invalid\u001b\\link\u001b]8;;\u001b\\",
      "\u001bPpayload\u001b\\",
      "\u001b_apc\u001b\\",
      "\u001b^pm\u001b\\",
      "\u001bXsos\u001b\\",
      "\u009b31mred\u009b0m",
      "\u009d0;c1-title\u009c",
      "after",
      "\u001b",
    ].join("");

    const result = sanitizeTerminalText(attack);

    expect(result).toBe("beforelinkredafter");
    expect(
      [...result].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code === 0x1b || (code >= 0x90 && code <= 0x9f);
      }),
    ).toBe(false);
    expect(result).not.toContain("clipboard");
    expect(result).not.toContain("evil.invalid");
    expect(result).not.toContain("owned-title");
  });

  it("normalizes carriage returns, expands tabs, and exposes other controls", () => {
    expect(sanitizeTerminalText("a\rb\r\nc\td\u0000e\u007f")).toBe(
      "a\nb\nc    d�e�",
    );
  });

  it("preserves Unicode and redacts secrets both before and after stripping", () => {
    const value = "中文🙂 e\u0301 super\u001b[31msecret sk-abcdefgh";
    expect(
      sanitizeTerminalText(value, { secrets: ["supersecret"] }),
    ).toBe("中文🙂 é [redacted] [redacted]");
  });

  it("rejects invalid sanitizer options", () => {
    expect(() => sanitizeTerminalText("x", { tabWidth: -1 })).toThrow(
      "terminal sanitizer options are invalid",
    );
  });
});
