import { redactSensitiveText } from "../security/redact.js";

export interface TerminalSanitizerOptions {
  readonly replacement?: string;
  readonly secrets?: readonly (string | undefined)[];
  readonly tabWidth?: number;
}

const ESC = 0x1b;
const DELETE = 0x7f;
const C1_CSI = 0x9b;
const C1_ST = 0x9c;
const C1_OSC = 0x9d;
const CONTROL_STRING_C1 = new Set([0x90, 0x98, 0x9e, 0x9f]);
const CONTROL_STRING_ESC_FINAL = new Set([0x50, 0x58, 0x5e, 0x5f]);

function consumeCsi(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    index += 1;
    if (code >= 0x40 && code <= 0x7e) return index;
  }
  return value.length;
}

function consumeControlString(
  value: string,
  start: number,
  bellTerminates: boolean,
): number {
  let index = start;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (bellTerminates && code === 0x07) return index + 1;
    if (code === C1_ST) return index + 1;
    if (
      code === ESC &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) === 0x5c
    ) {
      return index + 2;
    }
    index += 1;
  }
  return value.length;
}

function consumeEscSequence(value: string, start: number): number {
  if (start >= value.length) return start;
  const final = value.charCodeAt(start);
  if (final === 0x5b) return consumeCsi(value, start + 1);
  if (final === 0x5d) return consumeControlString(value, start + 1, true);
  if (CONTROL_STRING_ESC_FINAL.has(final)) {
    return consumeControlString(value, start + 1, false);
  }

  if (final >= 0x20 && final <= 0x2f) {
    let index = start + 1;
    while (
      index < value.length &&
      value.charCodeAt(index) >= 0x20 &&
      value.charCodeAt(index) <= 0x2f
    ) {
      index += 1;
    }
    if (
      index < value.length &&
      value.charCodeAt(index) >= 0x30 &&
      value.charCodeAt(index) <= 0x7e
    ) {
      return index + 1;
    }
    return index;
  }

  return final >= 0x30 && final <= 0x7e ? start + 1 : start;
}

function stripTerminalControls(
  value: string,
  replacement: string,
  tabWidth: number,
): string {
  let output = "";
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === ESC) {
      index = consumeEscSequence(value, index + 1);
      continue;
    }
    if (code === C1_CSI) {
      index = consumeCsi(value, index + 1);
      continue;
    }
    if (code === C1_OSC) {
      index = consumeControlString(value, index + 1, true);
      continue;
    }
    if (CONTROL_STRING_C1.has(code)) {
      index = consumeControlString(value, index + 1, false);
      continue;
    }
    if (code === C1_ST) {
      index += 1;
      continue;
    }
    if (code === 0x0d) {
      output += "\n";
      index += value.charCodeAt(index + 1) === 0x0a ? 2 : 1;
      continue;
    }
    if (code === 0x0a) {
      output += "\n";
      index += 1;
      continue;
    }
    if (code === 0x09) {
      output += " ".repeat(tabWidth);
      index += 1;
      continue;
    }
    if (code < 0x20 || code === DELETE || (code >= 0x80 && code <= 0x9f)) {
      output += replacement;
      index += 1;
      continue;
    }

    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    output += String.fromCodePoint(codePoint);
    index += codePoint > 0xffff ? 2 : 1;
  }
  return output;
}

export function sanitizeTerminalText(
  value: string,
  options: TerminalSanitizerOptions = {},
): string {
  const replacement = options.replacement ?? "�";
  const tabWidth = options.tabWidth ?? 4;
  if (tabWidth < 0 || !Number.isInteger(tabWidth) || replacement.length === 0) {
    throw new Error("terminal sanitizer options are invalid");
  }

  // PHASE11: external ANSI/OSC must disappear before width calculation or
  // rendering; otherwise untrusted content can rewrite title, clipboard, or rows.
  const redactedBefore = redactSensitiveText(value, options.secrets);
  const sanitized = stripTerminalControls(redactedBefore, replacement, tabWidth);
  return redactSensitiveText(sanitized, options.secrets);
}
