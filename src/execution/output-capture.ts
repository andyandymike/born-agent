import { StringDecoder } from "node:string_decoder";

export type OutputStreamName = "stdout" | "stderr";

export interface CapturedOutputChunk {
  readonly stream: OutputStreamName;
  readonly text: string;
  readonly acceptedBytes: number;
  readonly limitExceeded: boolean;
}

function truncateUtf8(
  value: string,
  limitBytes: number,
): { readonly text: string; readonly bytes: number; readonly truncated: boolean } {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= limitBytes) {
    return { bytes: encoded.byteLength, text: value, truncated: false };
  }
  let end = Math.max(0, limitBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try {
      const text = decoder.decode(encoded.subarray(0, end));
      return { bytes: end, text, truncated: true };
    } catch {
      end -= 1;
    }
  }
  return { bytes: 0, text: "", truncated: true };
}

class TerminalControlSanitizer {
  private mode: "normal" | "escape" | "csi" | "osc" | "osc_escape" =
    "normal";

  write(value: string): string {
    let result = "";
    for (const character of value) {
      const code = character.codePointAt(0) ?? 0;
      if (this.mode === "escape") {
        if (character === "[") {
          this.mode = "csi";
        } else if (character === "]") {
          this.mode = "osc";
        } else {
          this.mode = "normal";
        }
        continue;
      }
      if (this.mode === "csi") {
        if (code >= 0x40 && code <= 0x7e) {
          this.mode = "normal";
        }
        continue;
      }
      if (this.mode === "osc") {
        if (character === "\u0007") {
          this.mode = "normal";
        } else if (character === "\u001b") {
          this.mode = "osc_escape";
        }
        continue;
      }
      if (this.mode === "osc_escape") {
        this.mode = character === "\\" ? "normal" : "osc";
        continue;
      }
      if (character === "\u001b") {
        this.mode = "escape";
      } else if (character === "\r") {
        result += "\n";
      } else if (
        character === "\n" ||
        character === "\t" ||
        (code >= 0x20 &&
          !(code >= 0x7f && code <= 0x9f) &&
          !(code >= 0x202a && code <= 0x202e) &&
          !(code >= 0x2066 && code <= 0x2069))
      ) {
        result += character;
      }
    }
    return result;
  }
}

class StreamCapture {
  private readonly decoder = new StringDecoder("utf8");
  private readonly terminalSanitizer = new TerminalControlSanitizer();
  private readonly boundedSanitizedParts: string[] = [];
  private rendered = "";

  constructor(private readonly redact: (value: string) => string) {}

  write(chunk: Uint8Array): string {
    const sanitized = this.terminalSanitizer.write(this.decoder.write(chunk));
    if (sanitized.length > 0) {
      this.boundedSanitizedParts.push(sanitized);
    }
    // Keep the whole bounded channel private until finish so a credential split at
    // any chunk boundary is redacted as one value before an event can observe it.
    return "";
  }

  finish(limitBytes: number): {
    readonly text: string;
    readonly bytes: number;
    readonly truncated: boolean;
  } {
    const remainder = this.terminalSanitizer.write(this.decoder.end());
    if (remainder.length > 0) {
      this.boundedSanitizedParts.push(remainder);
    }
    const bounded = truncateUtf8(
      this.redact(this.boundedSanitizedParts.join("")),
      limitBytes,
    );
    this.rendered = bounded.text;
    this.boundedSanitizedParts.length = 0;
    return bounded;
  }

  get value(): string {
    return this.rendered;
  }
}

export class BoundedOutputCapture {
  private readonly streams: Record<OutputStreamName, StreamCapture>;
  private acceptedTotalBytes = 0;
  private stdoutAcceptedBytes = 0;
  private stderrAcceptedBytes = 0;
  private exceeded = false;

  constructor(
    readonly limitBytes: number,
    options: {
      readonly redact?: (value: string) => string;
    } = {},
  ) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) {
      throw new RangeError("output limit must be a positive safe integer");
    }
    const redact = options.redact ?? ((value: string) => value);
    this.streams = {
      stderr: new StreamCapture(redact),
      stdout: new StreamCapture(redact),
    };
  }

  append(stream: OutputStreamName, chunk: Uint8Array): CapturedOutputChunk {
    const remaining = Math.max(0, this.limitBytes - this.acceptedTotalBytes);
    const acceptedLength = Math.min(remaining, chunk.byteLength);
    const accepted = chunk.subarray(0, acceptedLength);
    this.acceptedTotalBytes += acceptedLength;
    if (stream === "stdout") {
      this.stdoutAcceptedBytes += acceptedLength;
    } else {
      this.stderrAcceptedBytes += acceptedLength;
    }
    if (
      acceptedLength < chunk.byteLength ||
      this.acceptedTotalBytes >= this.limitBytes
    ) {
      this.exceeded = true;
    }

    // PHASE6: Account raw bytes before decoding or rendering. Once the shared cap is
    // reached the executor kills the tree while it continues draining pipes, avoiding
    // the classic "stop reading and deadlock the child" failure mode.
    return {
      acceptedBytes: acceptedLength,
      limitExceeded: this.exceeded,
      stream,
      text: acceptedLength > 0 ? this.streams[stream].write(accepted) : "",
    };
  }

  finish(): readonly CapturedOutputChunk[] {
    const chunks: CapturedOutputChunk[] = [];
    let remainingPersistedBytes = this.limitBytes;
    for (const stream of ["stdout", "stderr"] as const) {
      const rendered = this.streams[stream].finish(remainingPersistedBytes);
      remainingPersistedBytes -= rendered.bytes;
      if (rendered.truncated) {
        this.exceeded = true;
      }
      if (rendered.text.length > 0) {
        chunks.push({
          acceptedBytes: rendered.bytes,
          limitExceeded: this.exceeded,
          stream,
          text: rendered.text,
        });
      }
    }
    return chunks;
  }

  get stdout(): string {
    return this.streams.stdout.value;
  }

  get stderr(): string {
    return this.streams.stderr.value;
  }

  get stdoutBytes(): number {
    return new TextEncoder().encode(this.stdout).byteLength;
  }

  get stderrBytes(): number {
    return new TextEncoder().encode(this.stderr).byteLength;
  }

  get stdoutRawAcceptedBytes(): number {
    return this.stdoutAcceptedBytes;
  }

  get stderrRawAcceptedBytes(): number {
    return this.stderrAcceptedBytes;
  }

  get truncated(): boolean {
    return this.exceeded;
  }
}
