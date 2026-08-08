import { dirname, extname, isAbsolute, relative, resolve } from "node:path";

import ts from "typescript";

import { sha256Canonical } from "../../completion/canonical-json.js";
import type { RepositorySourceSnapshotResult } from "../source-snapshot.js";
import {
  indexedImportSchema,
  indexedReferenceSchema,
  indexedSourceUnitSchema,
  indexedSymbolSchema,
  type IndexedImport,
  type IndexedReference,
  type IndexedSourceUnit,
  type RepositoryIndexRecords,
  type RepositorySymbolKind,
  type SourceRange,
} from "../navigation-types.js";

const TS_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalPath(workspace: string, absolutePath: string): string | null {
  const value = relative(workspace, absolutePath).replaceAll("\\", "/");
  return value === "" || value === ".." || value.startsWith("../") || isAbsolute(value) ? null : value;
}

function sourceRange(source: ts.SourceFile, node: ts.Node): SourceRange {
  const start = node.getStart(source, false);
  const end = node.getEnd();
  const startDisplay = source.getLineAndCharacterOfPosition(start);
  const endDisplay = source.getLineAndCharacterOfPosition(end);
  // PHASE17: TypeScript positions are UTF-16 code-unit offsets. Persistent authority is instead
  // the half-open UTF-8 byte range; display line/columns are derived deterministically.
  return Object.freeze({
    endByte: Buffer.byteLength(source.text.slice(0, end), "utf8"),
    endColumnUtf16: endDisplay.character + 1,
    endLine: endDisplay.line + 1,
    startByte: Buffer.byteLength(source.text.slice(0, start), "utf8"),
    startColumnUtf16: startDisplay.character + 1,
    startLine: startDisplay.line + 1,
  });
}

function declarationKind(node: ts.Node): RepositorySymbolKind | null {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isModuleDeclaration(node)) return "module";
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return "method";
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) return "property";
  if (ts.isVariableDeclaration(node)) {
    const statement = node.parent.parent;
    return ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
      ? "constant"
      : "variable";
  }
  return null;
}

function declarationName(node: ts.Node): ts.Identifier | null {
  if (ts.isConstructorDeclaration(node)) return null;
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isVariableDeclaration(node)
  ) {
    return node.name !== undefined && ts.isIdentifier(node.name) ? node.name : null;
  }
  return null;
}

function isExported(node: ts.Node): boolean {
  const declaration = ts.isVariableDeclaration(node) && ts.isVariableStatement(node.parent.parent)
    ? node.parent.parent
    : node;
  const modifiers = ts.canHaveModifiers(declaration) ? ts.getModifiers(declaration) : undefined;
  if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return true;
  if (
    (ts.isMethodDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertySignature(node)) &&
    (ts.isClassDeclaration(node.parent) || ts.isInterfaceDeclaration(node.parent))
  ) {
    const memberModifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    if (memberModifiers?.some((modifier) =>
      modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword
    )) return false;
    return isExported(node.parent);
  }
  // A local declaration inside an exported function/class method is not itself
  // exported merely because an ancestor carries the export modifier.
  return false;
}

function qualifiedName(name: ts.Identifier): string {
  const names = [name.text];
  let current = name.parent.parent;
  while (current !== undefined && !ts.isSourceFile(current)) {
    const parentName = declarationName(current);
    if (parentName !== null) names.unshift(parentName.text);
    current = current.parent;
  }
  return names.join(".");
}

function scriptKind(path: string): ts.ScriptKind {
  const extension = extname(path).toLowerCase();
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if ([".js", ".mjs", ".cjs"].includes(extension)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function extensionFor(path: string): ts.Extension {
  const extension = extname(path).toLowerCase();
  if (extension === ".tsx") return ts.Extension.Tsx;
  if (extension === ".jsx") return ts.Extension.Jsx;
  if ([".js", ".mjs", ".cjs"].includes(extension)) return ts.Extension.Js;
  return ts.Extension.Ts;
}

function candidateModulePaths(containingPath: string, specifier: string): readonly string[] {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return [];
  const base = resolve(dirname(containingPath), specifier);
  const withoutRuntimeExtension = base.replace(/\.(?:c|m)?js$/iu, "");
  return Object.freeze([
    base,
    `${withoutRuntimeExtension}.ts`,
    `${withoutRuntimeExtension}.tsx`,
    `${withoutRuntimeExtension}.mts`,
    `${withoutRuntimeExtension}.cts`,
    `${withoutRuntimeExtension}.js`,
    `${withoutRuntimeExtension}.jsx`,
    resolve(withoutRuntimeExtension, "index.ts"),
    resolve(withoutRuntimeExtension, "index.tsx"),
    resolve(withoutRuntimeExtension, "index.js"),
  ]);
}

function relationFor(identifier: ts.Identifier): IndexedReference["relation"] {
  let current: ts.Node = identifier;
  for (let depth = 0; depth < 8 && current.parent !== undefined; depth += 1) {
    const parent = current.parent;
    if (ts.isImportDeclaration(parent) || ts.isImportSpecifier(parent) || ts.isImportClause(parent)) return "import";
    if (ts.isTypeNode(parent) || ts.isTypeAliasDeclaration(parent) || ts.isInterfaceDeclaration(parent)) return "type";
    if (ts.isCallExpression(parent) && parent.expression === current) return "call";
    if (
      ts.isBinaryExpression(parent) &&
      parent.left === current &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) return "write";
    if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && parent.operand === current) return "write";
    if (ts.isStatement(parent) || ts.isSourceFile(parent)) break;
    current = parent;
  }
  return "read";
}

function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return symbol;
  }
}

export interface TypeScriptAnalysisOptions {
  readonly evidenceLevel: "semantic" | "syntactic";
}

export interface TypeScriptAnalysisState {
  readonly program: ts.Program;
  readonly sourceFiles: ReadonlyMap<string, {
    readonly sourceFile: ts.SourceFile;
    readonly sourceSha256: string;
  }>;
  readonly sourceStateSha256: string;
}

export interface TypeScriptAnalysisResult {
  readonly records: RepositoryIndexRecords;
  readonly reparsedUnits: readonly string[];
  readonly reusedUnits: readonly string[];
  readonly state: TypeScriptAnalysisState;
}

export function analyzeTypeScriptSnapshotWithState(
  workspace: string,
  snapshot: RepositorySourceSnapshotResult,
  options: TypeScriptAnalysisOptions,
  previousState?: TypeScriptAnalysisState,
): TypeScriptAnalysisResult {
  const absoluteBytes = new Map<string, Uint8Array>();
  const sourceEntryByAbsolute = new Map<string, (typeof snapshot.snapshot.entries)[number]>();
  for (const entry of snapshot.snapshot.entries) {
    if (!TS_EXTENSIONS.has(extname(entry.relativePath).toLowerCase()) || entry.textEncoding !== "utf8") continue;
    const bytes = snapshot.sourceBytes.get(entry.relativePath);
    if (bytes === undefined) continue;
    const absolute = resolve(workspace, entry.relativePath);
    absoluteBytes.set(absolute, bytes);
    sourceEntryByAbsolute.set(absolute, entry);
  }

  const sourceCache = new Map<string, ts.SourceFile>();
  const host: ts.CompilerHost = {
    fileExists: (path) => absoluteBytes.has(resolve(path)),
    getCanonicalFileName: (path) => resolve(path).toLowerCase(),
    getCurrentDirectory: () => workspace,
    getDefaultLibFileName: () => "__bornagent_no_lib__.d.ts",
    getNewLine: () => "\n",
    getSourceFile: (path, languageVersion) => {
      const absolute = resolve(path);
      const cached = sourceCache.get(absolute);
      if (cached !== undefined) return cached;
      const bytes = absoluteBytes.get(absolute);
      if (bytes === undefined) return undefined;
      const entry = sourceEntryByAbsolute.get(absolute);
      const previous = previousState?.sourceFiles.get(absolute);
      if (entry !== undefined && previous?.sourceSha256 === entry.contentSha256) {
        sourceCache.set(absolute, previous.sourceFile);
        return previous.sourceFile;
      }
      const source = ts.createSourceFile(absolute, Buffer.from(bytes).toString("utf8"), languageVersion, true, scriptKind(absolute));
      sourceCache.set(absolute, source);
      return source;
    },
    readFile: (path) => {
      const bytes = absoluteBytes.get(resolve(path));
      return bytes === undefined ? undefined : Buffer.from(bytes).toString("utf8");
    },
    resolveModuleNames: (moduleNames, containingFile) =>
      moduleNames.map((specifier) => {
        const resolved = candidateModulePaths(containingFile, specifier).find((candidate) => absoluteBytes.has(resolve(candidate)));
        return resolved === undefined
          ? undefined
          : { extension: extensionFor(resolved), isExternalLibraryImport: false, resolvedFileName: resolve(resolved) };
      }),
    useCaseSensitiveFileNames: () => false,
    writeFile: () => undefined,
  };
  const program = ts.createProgram({
    host,
    ...(previousState === undefined ? {} : { oldProgram: previousState.program }),
    options: {
      allowJs: true,
      checkJs: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      noLib: true,
      noResolve: false,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2023,
    },
    rootNames: [...absoluteBytes.keys()].sort(ordinal),
  });
  const checker = program.getTypeChecker();
  const units: IndexedSourceUnit[] = [];
  const symbols: ReturnType<typeof indexedSymbolSchema.parse>[] = [];
  const imports: IndexedImport[] = [];
  const declarationNames = new Set<ts.Node>();
  const symbolToRecord = new Map<ts.Symbol, string>();

  for (const entry of snapshot.snapshot.entries) {
    const eligible = TS_EXTENSIONS.has(extname(entry.relativePath).toLowerCase()) && entry.textEncoding === "utf8";
    const source = eligible ? program.getSourceFile(resolve(workspace, entry.relativePath)) : undefined;
    const diagnostics = source === undefined ? [] : program.getSyntacticDiagnostics(source);
    const parseStatus = !eligible ? "unsupported" : source === undefined ? "failed" : diagnostics.length > 0 ? "failed" : "indexed";
    const unsignedUnit = {
      bytes: entry.byteLength,
      diagnosticCode: diagnostics.length > 0 ? `typescript_syntax_${diagnostics[0]!.code}` : source === undefined && eligible ? "typescript_source_missing" : null,
      language: entry.languageHint,
      parseStatus,
      relativePath: entry.relativePath,
      sourceSha256: entry.contentSha256,
    };
    units.push(indexedSourceUnitSchema.parse({ ...unsignedUnit, unitSha256: sha256Canonical(unsignedUnit) }));
    if (source === undefined || parseStatus !== "indexed") continue;

    const visitDeclarations = (node: ts.Node): void => {
      const name = declarationName(node);
      const kind = declarationKind(node);
      if (name !== null && kind !== null && name.text.length <= 256) {
        declarationNames.add(name);
        const range = sourceRange(source, name);
        const qname = qualifiedName(name).slice(0, 1024);
        const unsigned = {
          evidenceLevel: options.evidenceLevel,
          exported: isExported(node),
          kind,
          name: name.text,
          qualifiedName: qname,
          range,
          relativePath: entry.relativePath,
          sourceSha256: entry.contentSha256,
        };
        const recordId = sha256Canonical(unsigned);
        symbols.push(indexedSymbolSchema.parse({ ...unsigned, recordId }));
        const symbol = checker.getSymbolAtLocation(name);
        if (symbol !== undefined && !symbolToRecord.has(resolveAlias(checker, symbol))) {
          symbolToRecord.set(resolveAlias(checker, symbol), recordId);
        }
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const resolvedPath = candidateModulePaths(source.fileName, node.moduleSpecifier.text)
          .map((candidate) => canonicalPath(workspace, candidate))
          .find((candidate) => candidate !== null && snapshot.snapshot.entries.some((item) => item.relativePath === candidate)) ?? null;
        imports.push(indexedImportSchema.parse({
          evidenceLevel: options.evidenceLevel,
          range: sourceRange(source, node.moduleSpecifier),
          resolvedPath,
          sourcePath: entry.relativePath,
          sourceSha256: entry.contentSha256,
          specifier: node.moduleSpecifier.text,
        }));
      }
      ts.forEachChild(node, visitDeclarations);
    };
    visitDeclarations(source);
  }

  const references: IndexedReference[] = [];
  for (const source of [...program.getSourceFiles()].sort((left, right) => ordinal(left.fileName, right.fileName))) {
    const relativePath = canonicalPath(workspace, source.fileName);
    if (relativePath === null) continue;
    const entry = snapshot.snapshot.entries.find((candidate) => candidate.relativePath === relativePath);
    if (entry === undefined) continue;
    const visitReferences = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && !declarationNames.has(node)) {
        const symbol = checker.getSymbolAtLocation(node);
        const resolved = symbol === undefined ? undefined : resolveAlias(checker, symbol);
        const target = resolved === undefined ? undefined : symbolToRecord.get(resolved);
        if (target !== undefined) {
          references.push(indexedReferenceSchema.parse({
            evidenceLevel: options.evidenceLevel,
            range: sourceRange(source, node),
            relation: relationFor(node),
            sourcePath: relativePath,
            sourceSha256: entry.contentSha256,
            targetSymbolRecordId: target,
            unresolvedName: null,
          }));
        }
      }
      ts.forEachChild(node, visitReferences);
    };
    visitReferences(source);
  }

  const records = Object.freeze({
    imports: Object.freeze(imports.sort((left, right) => ordinal(`${left.sourcePath}:${left.range.startByte}`, `${right.sourcePath}:${right.range.startByte}`))),
    references: Object.freeze(references.sort((left, right) => ordinal(`${left.sourcePath}:${left.range.startByte}:${left.relation}`, `${right.sourcePath}:${right.range.startByte}:${right.relation}`))),
    symbols: Object.freeze(symbols.sort((left, right) => ordinal(`${left.relativePath}:${left.range.startByte}:${left.recordId}`, `${right.relativePath}:${right.range.startByte}:${right.recordId}`))),
    units: Object.freeze(units.sort((left, right) => ordinal(left.relativePath, right.relativePath))),
  });
  const sourceFiles = new Map<string, { readonly sourceFile: ts.SourceFile; readonly sourceSha256: string }>();
  const reparsedUnits: string[] = [];
  const reusedUnits: string[] = [];
  for (const [absolute, entry] of sourceEntryByAbsolute) {
    const sourceFile = program.getSourceFile(absolute);
    if (sourceFile === undefined) continue;
    sourceFiles.set(absolute, Object.freeze({ sourceFile, sourceSha256: entry.contentSha256 }));
    const previous = previousState?.sourceFiles.get(absolute);
    (previous?.sourceSha256 === entry.contentSha256 && previous.sourceFile === sourceFile ? reusedUnits : reparsedUnits)
      .push(entry.relativePath);
  }
  return Object.freeze({
    records,
    reparsedUnits: Object.freeze(reparsedUnits.sort(ordinal)),
    reusedUnits: Object.freeze(reusedUnits.sort(ordinal)),
    state: Object.freeze({
      program,
      sourceFiles,
      sourceStateSha256: snapshot.snapshot.sourceStateSha256,
    }),
  });
}

export function analyzeTypeScriptSnapshot(
  workspace: string,
  snapshot: RepositorySourceSnapshotResult,
  options: TypeScriptAnalysisOptions,
): RepositoryIndexRecords {
  return analyzeTypeScriptSnapshotWithState(workspace, snapshot, options).records;
}
