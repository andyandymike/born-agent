export class StrictJsonError extends Error {
  override readonly name = "StrictJsonError";
}

class StrictJsonParser {
  #index = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    if (this.source.charCodeAt(0) === 0xfeff) {
      this.fail("UTF-8 BOM is not allowed");
    }
    const value = this.value(0);
    this.whitespace();
    if (this.#index !== this.source.length) {
      this.fail("trailing bytes after JSON value");
    }
    return value;
  }

  private value(depth: number): unknown {
    if (depth > 64) this.fail("JSON nesting exceeds 64 levels");
    this.whitespace();
    const token = this.source[this.#index];
    if (token === "{") return this.object(depth + 1);
    if (token === "[") return this.array(depth + 1);
    if (token === '"') return this.string();
    if (token === "t") return this.literal("true", true);
    if (token === "f") return this.literal("false", false);
    if (token === "n") return this.literal("null", null);
    if (
      token === "-" ||
      (token !== undefined && /[0-9]/u.test(token))
    ) {
      return this.number();
    }
    this.fail("expected a JSON value");
  }

  private object(depth: number): Record<string, unknown> {
    this.#index += 1;
    const result: Record<string, unknown> = {};
    const keys = new Set<string>();
    this.whitespace();
    if (this.source[this.#index] === "}") {
      this.#index += 1;
      return result;
    }
    for (;;) {
      this.whitespace();
      if (this.source[this.#index] !== '"') {
        this.fail("object key must be a string");
      }
      const key = this.string();
      if (keys.has(key)) {
        this.fail(`duplicate object key ${JSON.stringify(key)}`);
      }
      keys.add(key);
      this.whitespace();
      if (this.source[this.#index] !== ":") {
        this.fail("expected ':' after object key");
      }
      this.#index += 1;
      result[key] = this.value(depth);
      this.whitespace();
      const separator = this.source[this.#index];
      if (separator === "}") {
        this.#index += 1;
        return result;
      }
      if (separator !== ",") this.fail("expected ',' or '}' in object");
      this.#index += 1;
    }
  }

  private array(depth: number): unknown[] {
    this.#index += 1;
    const result: unknown[] = [];
    this.whitespace();
    if (this.source[this.#index] === "]") {
      this.#index += 1;
      return result;
    }
    for (;;) {
      result.push(this.value(depth));
      this.whitespace();
      const separator = this.source[this.#index];
      if (separator === "]") {
        this.#index += 1;
        return result;
      }
      if (separator !== ",") this.fail("expected ',' or ']' in array");
      this.#index += 1;
    }
  }

  private string(): string {
    const start = this.#index;
    this.#index += 1;
    let escaped = false;
    while (this.#index < this.source.length) {
      const character = this.source[this.#index];
      if (!escaped && character === '"') {
        this.#index += 1;
        try {
          return JSON.parse(this.source.slice(start, this.#index)) as string;
        } catch {
          this.fail("invalid JSON string");
        }
      }
      if (
        !escaped &&
        character !== undefined &&
        character.charCodeAt(0) < 0x20
      ) {
        this.fail("unescaped control character in string");
      }
      escaped = !escaped && character === "\\";
      if (character !== "\\") escaped = false;
      this.#index += 1;
    }
    this.fail("unterminated JSON string");
  }

  private number(): number {
    const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/uy;
    match.lastIndex = this.#index;
    const found = match.exec(this.source)?.[0];
    if (found === undefined) this.fail("invalid JSON number");
    this.#index += found.length;
    const value = Number(found);
    if (!Number.isFinite(value)) this.fail("JSON number must be finite");
    return value;
  }

  private literal<T>(source: string, value: T): T {
    if (!this.source.startsWith(source, this.#index)) {
      this.fail(`expected ${source}`);
    }
    this.#index += source.length;
    return value;
  }

  private whitespace(): void {
    while (/[ \t\r\n]/u.test(this.source[this.#index] ?? "")) {
      this.#index += 1;
    }
  }

  private fail(message: string): never {
    throw new StrictJsonError(
      `${message} at byte-like character offset ${String(this.#index)}`,
    );
  }
}

export function parseStrictJson(source: string): unknown {
  return new StrictJsonParser(source).parse();
}
