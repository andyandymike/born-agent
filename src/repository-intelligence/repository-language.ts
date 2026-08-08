export type RepositoryLanguageHint =
  | "c"
  | "cpp"
  | "csharp"
  | "css"
  | "go"
  | "html"
  | "java"
  | "javascript"
  | "json"
  | "kotlin"
  | "markdown"
  | "python"
  | "ruby"
  | "rust"
  | "shell"
  | "sql"
  | "swift"
  | "toml"
  | "typescript"
  | "unknown"
  | "xml"
  | "yaml";

const LANGUAGE_BY_EXTENSION = Object.freeze(
  new Map<string, RepositoryLanguageHint>([
    [".c", "c"],
    [".h", "c"],
    [".cc", "cpp"],
    [".cpp", "cpp"],
    [".cxx", "cpp"],
    [".hpp", "cpp"],
    [".cs", "csharp"],
    [".css", "css"],
    [".go", "go"],
    [".htm", "html"],
    [".html", "html"],
    [".java", "java"],
    [".js", "javascript"],
    [".jsx", "javascript"],
    [".mjs", "javascript"],
    [".cjs", "javascript"],
    [".json", "json"],
    [".jsonc", "json"],
    [".kt", "kotlin"],
    [".kts", "kotlin"],
    [".md", "markdown"],
    [".mdx", "markdown"],
    [".py", "python"],
    [".pyi", "python"],
    [".rb", "ruby"],
    [".rs", "rust"],
    [".sh", "shell"],
    [".bash", "shell"],
    [".ps1", "shell"],
    [".sql", "sql"],
    [".swift", "swift"],
    [".toml", "toml"],
    [".ts", "typescript"],
    [".tsx", "typescript"],
    [".mts", "typescript"],
    [".cts", "typescript"],
    [".xml", "xml"],
    [".svg", "xml"],
    [".yaml", "yaml"],
    [".yml", "yaml"],
  ]),
);

const BASENAME_HINTS = Object.freeze(
  new Map<string, RepositoryLanguageHint>([
    ["dockerfile", "shell"],
    ["makefile", "shell"],
  ]),
);

function extension(path: string): string {
  const name = path.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

export function repositoryLanguageHint(path: string): RepositoryLanguageHint {
  const basename = path.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  return BASENAME_HINTS.get(basename) ?? LANGUAGE_BY_EXTENSION.get(extension(path)) ?? "unknown";
}

export function isParseEligibleLanguage(hint: RepositoryLanguageHint): boolean {
  return !["unknown", "markdown"].includes(hint);
}
