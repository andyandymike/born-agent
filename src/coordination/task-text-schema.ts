import { z } from "zod";

export interface CanonicalStoredTextOptions {
  readonly maximumBytes: number;
  readonly maximumScalars?: number;
  readonly minimumScalars?: number;
  readonly nonblank?: boolean;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (
        index + 1 >= value.length ||
        next < 0xdc00 ||
        next > 0xdfff
      ) {
        return true;
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return true;
  }
  return false;
}

function containsForbiddenControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint >= 0x00 && codePoint <= 0x08) ||
        (codePoint >= 0x0b && codePoint <= 0x1f) ||
        (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

export function canonicalStoredTextSchema(
  options: CanonicalStoredTextOptions,
) {
  return z.string().superRefine((value, context) => {
    if (hasUnpairedSurrogate(value)) {
      context.addIssue({
        code: "custom",
        message: "must contain valid Unicode scalar values",
      });
    }
    if (value.includes("\r")) {
      context.addIssue({
        code: "custom",
        message: "must already use canonical LF line endings",
      });
    }
    if (containsForbiddenControl(value)) {
      context.addIssue({
        code: "custom",
        message: "contains a forbidden control character",
      });
    }

    const scalarCount = Array.from(value).length;
    if (
      options.minimumScalars !== undefined &&
      scalarCount < options.minimumScalars
    ) {
      context.addIssue({
        code: "custom",
        message: `must contain at least ${options.minimumScalars} Unicode scalar values`,
      });
    }
    if (
      options.maximumScalars !== undefined &&
      scalarCount > options.maximumScalars
    ) {
      context.addIssue({
        code: "custom",
        message: `must contain at most ${options.maximumScalars} Unicode scalar values`,
      });
    }
    if (
      Buffer.byteLength(value, "utf8") > options.maximumBytes
    ) {
      context.addIssue({
        code: "custom",
        message: `must not exceed ${options.maximumBytes} UTF-8 bytes`,
      });
    }
    if (options.nonblank === true && value.trim().length === 0) {
      context.addIssue({
        code: "custom",
        message: "must not be blank",
      });
    }
  });
}

export function isNonblankCanonicalText(value: string): boolean {
  return value.trim().length > 0;
}
