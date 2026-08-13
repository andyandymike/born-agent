import { sanitizeTerminalText } from "../presentation/terminal-sanitizer.js";
import { SensitivePathPolicy } from "../tools/sensitive-path-policy.js";
import { WorkspacePathPolicy } from "../tools/workspace-path-policy.js";
import type { SourceRange } from "./navigation-types.js";
import { RepositoryIntelligenceError } from "./repository-intelligence-error.js";
import { StableSourceReader, type StableSourceRead } from "./stable-source-reader.js";

export interface NavigationSnippet {
  readonly bytes: number;
  readonly endLine: number;
  readonly sourceSha256: string;
  readonly startLine: number;
  readonly text: string;
  readonly trust: "untrusted_repository_content";
}

export interface NavigationSnippetRequest {
  readonly byteLength: number;
  readonly path: string;
  readonly range: SourceRange;
  readonly sourceSha256: string;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    output += character;
    bytes += size;
  }
  return output;
}

function verifyRange(bytes: Uint8Array, range: SourceRange): void {
  if (range.startByte > range.endByte || range.endByte > bytes.byteLength) throw new Error("snippet range exceeds source bytes");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  decoder.decode(bytes.slice(0, range.startByte));
  decoder.decode(bytes.slice(range.startByte, range.endByte));
  decoder.decode(bytes.slice(range.endByte));
}

export class RepositoryNavigationSnippetReader {
  private readonly cache = new Map<string, Promise<StableSourceRead>>();

  private constructor(
    private readonly reader: StableSourceReader,
    private readonly secrets: readonly string[],
  ) {}

  static async create(workspace: string, secrets: readonly string[] = []): Promise<RepositoryNavigationSnippetReader> {
    const paths = await WorkspacePathPolicy.create(workspace, { sensitive: new SensitivePathPolicy() });
    return new RepositoryNavigationSnippetReader(new StableSourceReader(paths), secrets);
  }

  async read(
    request: NavigationSnippetRequest,
    options: { readonly maxBytes: 4096 | 8192; readonly maxLines: 5 | 12; readonly signal: AbortSignal },
  ): Promise<NavigationSnippet> {
    try {
      const cacheKey = `${request.path}:${request.sourceSha256}:${request.byteLength}`;
      let pending = this.cache.get(cacheKey);
      if (pending === undefined) {
        pending = this.reader.read(request.path, { maxBytes: Math.max(1, request.byteLength), signal: options.signal });
        this.cache.set(cacheKey, pending);
      }
      const stable = await pending;
      if (stable.contentSha256 !== request.sourceSha256 || stable.byteLength !== request.byteLength || stable.textEncoding !== "utf8") {
        throw new Error("snippet source identity changed");
      }
      verifyRange(stable.bytes, request.range);
      const lines = Buffer.from(stable.bytes).toString("utf8").split(/\r?\n/u);
      const declarationLine = request.range.startLine - 1;
      if (declarationLine < 0 || declarationLine >= lines.length) throw new Error("snippet display range exceeds source lines");
      const before = Math.floor((options.maxLines - 1) / 2);
      const start = Math.max(0, Math.min(declarationLine - before, Math.max(0, lines.length - options.maxLines)));
      const selected = lines.slice(start, Math.min(lines.length, start + options.maxLines));
      const safe = truncateUtf8(sanitizeTerminalText(selected.join("\n"), { secrets: this.secrets }), options.maxBytes);
      return Object.freeze({
        bytes: Buffer.byteLength(safe, "utf8"),
        endLine: start + selected.length,
        sourceSha256: stable.contentSha256,
        startLine: start + 1,
        text: safe,
        trust: "untrusted_repository_content" as const,
      });
    } catch (error) {
      if (error instanceof RepositoryIntelligenceError && error.exitCode === 130) throw error;
      throw new RepositoryIntelligenceError("repository_index_stale", "repository snippet is not current", 8, { cause: error });
    }
  }
}
