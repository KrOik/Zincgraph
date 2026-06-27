import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { runCodeGraphCli } from '../bridge/codegraphAdapter.js';
import { zincgraphDataDir } from './zvec-adapter.js';

export const MEANINGFUL_NODE_KINDS = ['function', 'class', 'method', 'interface', 'component'] as const;
export const MAX_SOURCE_SNIPPET_LINES = 80;
export const MAX_SOURCE_SNIPPET_CHARS = 6_000;
export const MAX_SOURCE_FILE_READ_BYTES = 1_048_576;

export interface CodeGraphSnapshotNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  language: string;
  startLine?: number;
  endLine?: number;
  docstring?: string;
  signature?: string;
  sourceSnippet?: string;
  calls: string[];
}

export interface CodeGraphSnapshotFile {
  path: string;
  contentHash: string;
  language: string;
}

export interface CodeGraphSnapshot {
  projectPath: string;
  nodes: CodeGraphSnapshotNode[];
  files: CodeGraphSnapshotFile[];
}

interface CodeGraphSnapshotCache extends CodeGraphSnapshot {
  codeGraphFingerprint: string | null;
}

type CodeGraphNodeRow = {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  language: string;
  startLine: number | null;
  endLine: number | null;
  docstring: string | null;
  signature: string | null;
};

type CodeGraphEdgeRow = {
  sourceId: string;
  targetName: string;
};

type CodeGraphFileRow = {
  path: string;
  contentHash: string;
  language: string;
};

export interface ReadCodeGraphSnapshotOptions {
  includeSourceSnippets?: boolean;
  sourceSnippetFiles?: readonly string[];
}

export interface SourceSnippetIo {
  realpath(path: string): string;
  stat(path: string): Pick<Stats, 'isFile' | 'size'>;
  readFilePrefix(path: string, maxBytes: number): string;
}

const FULL_SNAPSHOT_CACHE_FILE = 'codegraph-snapshot.json';
const LITE_SNAPSHOT_CACHE_FILE = 'codegraph-snapshot-lite.json';
const CALL_NAME_BLACKLIST = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'function',
  'return',
  'typeof',
  'new',
  'class',
  'interface'
]);
export function ensureCodeGraphIndex(projectPath: string): void {
  const projectRoot = resolve(projectPath);
  const dbPath = join(projectRoot, '.codegraph', 'codegraph.db');
  if (!existsSync(dbPath)) {
    const init = runCodeGraphCli(['init', projectRoot], projectRoot, { silent: true });
    if (init.status !== 0) {
      throw new Error(init.stderr || init.stdout || 'CodeGraph init failed');
    }
  }
}

export function readCodeGraphSnapshot(
  projectPath: string,
  options: ReadCodeGraphSnapshotOptions = {}
): CodeGraphSnapshot {
  ensureCodeGraphIndex(projectPath);
  const projectRoot = resolve(projectPath);
  const fingerprint = codeGraphDbFingerprint(projectRoot);
  const includeSourceSnippets = options.includeSourceSnippets ?? true;
  const sourceSnippetFiles = normalizeSourceSnippetFiles(options.sourceSnippetFiles);

  if (!includeSourceSnippets) {
    const cachedLite = readCachedCodeGraphSnapshot(projectRoot, fingerprint, { includeSourceSnippets: false });
    if (cachedLite) {
      return cachedLite;
    }
    const snapshot = loadCodeGraphSnapshot(projectRoot);
    writeCodeGraphSnapshotCache(projectRoot, snapshot, { includeSourceSnippets: false });
    return snapshot;
  }

  if (!sourceSnippetFiles) {
    const cachedFull = readCachedCodeGraphSnapshot(projectRoot, fingerprint, { includeSourceSnippets: true });
    if (cachedFull) {
      return cachedFull;
    }
    const cachedLite = readCachedCodeGraphSnapshot(projectRoot, fingerprint, { includeSourceSnippets: false });
    const baseSnapshot = cachedLite ?? loadCodeGraphSnapshot(projectRoot);
    const snapshot = hasSourceSnippets(baseSnapshot)
      ? baseSnapshot
      : attachSourceSnippets(baseSnapshot, projectRoot);
    writeCodeGraphSnapshotCache(projectRoot, snapshot, { includeSourceSnippets: true });
    return snapshot;
  }

  const cachedFull = readCachedCodeGraphSnapshot(projectRoot, fingerprint, { includeSourceSnippets: true });
  if (cachedFull) {
    return cachedFull;
  }
  const cachedLite = readCachedCodeGraphSnapshot(projectRoot, fingerprint, { includeSourceSnippets: false });
  const baseSnapshot = cachedLite ?? loadCodeGraphSnapshot(projectRoot);
  if (!cachedLite) {
    writeCodeGraphSnapshotCache(projectRoot, baseSnapshot, { includeSourceSnippets: false });
  }
  return attachSourceSnippets(baseSnapshot, projectRoot, sourceSnippetFiles);
}

export function applyCodeGraphSnapshotReadOptions(
  snapshot: CodeGraphSnapshot,
  projectPath: string,
  options: ReadCodeGraphSnapshotOptions = {}
): CodeGraphSnapshot {
  const projectRoot = resolve(projectPath);
  const includeSourceSnippets = options.includeSourceSnippets ?? true;
  const sourceSnippetFiles = normalizeSourceSnippetFiles(options.sourceSnippetFiles);
  if (!includeSourceSnippets) {
    return stripSourceSnippets(snapshot);
  }
  if (!sourceSnippetFiles) {
    return hasSourceSnippets(snapshot) ? snapshot : attachSourceSnippets(snapshot, projectRoot);
  }
  return attachSourceSnippets(snapshot, projectRoot, sourceSnippetFiles);
}

export function updateCodeGraphSnapshotCacheFromFiles(
  projectPath: string,
  files: ReadonlyArray<{ path: string; contentHash: string }>
): CodeGraphSnapshot | null {
  if (files.length === 0) {
    return null;
  }
  const projectRoot = resolve(projectPath);
  const baseSnapshot = readCodeGraphSnapshot(projectRoot, { includeSourceSnippets: false });
  const nextFiles = new Map(baseSnapshot.files.map((file) => [normalizeProjectRelativePath(file.path), { ...file }]));
  const changedPaths = new Set(files.map((file) => normalizeProjectRelativePath(file.path)));
  const updatedNodes: CodeGraphSnapshotNode[] = [];

  for (const file of files) {
    const normalizedPath = normalizeProjectRelativePath(file.path);
    const sourceText = loadSourceText(projectRoot, normalizedPath);
    if (sourceText === undefined) {
      return null;
    }
    const language = nextFiles.get(normalizedPath)?.language ?? inferLanguageFromPath(normalizedPath);
    nextFiles.set(normalizedPath, {
      path: normalizedPath,
      contentHash: file.contentHash,
      language
    });
    updatedNodes.push(...scanMeaningfulNodes(normalizedPath, language, sourceText));
  }

  const snapshot: CodeGraphSnapshot = {
    projectPath: projectRoot,
    files: [...nextFiles.values()].sort((left, right) => left.path.localeCompare(right.path)),
    nodes: [
      ...baseSnapshot.nodes.filter((node) => !changedPaths.has(normalizeProjectRelativePath(node.filePath))),
      ...updatedNodes
    ].sort(compareSnapshotNodes)
  };
  writeCodeGraphSnapshotCache(projectRoot, snapshot, { includeSourceSnippets: false });
  rmSync(snapshotCachePath(projectRoot, true), { force: true });
  return snapshot;
}

export function writeCodeGraphSnapshotCache(
  projectPath: string,
  snapshot: CodeGraphSnapshot,
  options: ReadCodeGraphSnapshotOptions = {}
): void {
  const projectRoot = resolve(projectPath);
  mkdirSync(zincgraphDataDir(projectRoot), { recursive: true });
  const fingerprint = codeGraphDbFingerprint(projectRoot);
  const includeSourceSnippets = options.includeSourceSnippets ?? true;
  const fullSnapshot = includeSourceSnippets ? snapshot : undefined;
  const liteSnapshot = includeSourceSnippets ? stripSourceSnippets(snapshot) : snapshot;

  if (fullSnapshot) {
    writeCachedCodeGraphSnapshot(snapshotCachePath(projectRoot, true), projectRoot, fingerprint, fullSnapshot);
  }
  writeCachedCodeGraphSnapshot(snapshotCachePath(projectRoot, false), projectRoot, fingerprint, liteSnapshot);
}

export function safeSourceSnippet(
  projectPath: string,
  filePath: string,
  startLine: number | undefined,
  endLine: number | undefined,
  io: SourceSnippetIo = defaultSourceSnippetIo
): string | undefined {
  const projectRoot = resolve(projectPath);
  const sourceText = loadSourceText(projectRoot, filePath, io);
  return sourceText ? sliceSourceSnippet(sourceText, startLine, endLine) : undefined;
}

function snapshotCachePath(projectRoot: string, includeSourceSnippets: boolean): string {
  return join(
    zincgraphDataDir(projectRoot),
    includeSourceSnippets ? FULL_SNAPSHOT_CACHE_FILE : LITE_SNAPSHOT_CACHE_FILE
  );
}

function codeGraphDbFingerprint(projectRoot: string): string | null {
  const dbPath = join(projectRoot, '.codegraph', 'codegraph.db');
  if (!existsSync(dbPath)) {
    return null;
  }
  const stats = statSync(dbPath);
  return `${stats.size}:${stats.mtimeMs}`;
}

function fingerprintMatches(
  projectRoot: string,
  cachedProjectPath: unknown,
  cachedFingerprint: unknown,
  expectedFingerprint: string | null
): boolean {
  if (cachedFingerprint === expectedFingerprint) {
    return true;
  }
  if (typeof cachedProjectPath !== 'string' || cachedProjectPath === projectRoot) {
    return false;
  }
  return fingerprintSize(cachedFingerprint) !== null && fingerprintSize(cachedFingerprint) === fingerprintSize(expectedFingerprint);
}

function fingerprintSize(fingerprint: unknown): string | null {
  if (typeof fingerprint !== 'string') {
    return null;
  }
  const [size] = fingerprint.split(':', 1);
  return size && /^\d+$/.test(size) ? size : null;
}

function readCachedCodeGraphSnapshot(
  projectRoot: string,
  expectedFingerprint: string | null,
  options: { includeSourceSnippets: boolean }
): CodeGraphSnapshot | null {
  const cacheModes = options.includeSourceSnippets ? [true] : [false, true];
  for (const includeSourceSnippets of cacheModes) {
    const cachePath = snapshotCachePath(projectRoot, includeSourceSnippets);
    if (!existsSync(cachePath)) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as Partial<CodeGraphSnapshotCache>;
      if (
        !fingerprintMatches(projectRoot, parsed.projectPath, parsed.codeGraphFingerprint, expectedFingerprint) ||
        !Array.isArray(parsed.nodes) ||
        !Array.isArray(parsed.files)
      ) {
        continue;
      }
      const snapshot = {
        projectPath: projectRoot,
        nodes: parsed.nodes.filter(isSnapshotNode),
        files: parsed.files.filter(isSnapshotFile)
      } satisfies CodeGraphSnapshot;
      return options.includeSourceSnippets || !includeSourceSnippets
        ? snapshot
        : stripSourceSnippets(snapshot);
    } catch {
      continue;
    }
  }
  return null;
}

function loadCodeGraphSnapshot(projectRoot: string): CodeGraphSnapshot {
  const dbPath = join(projectRoot, '.codegraph', 'codegraph.db');
  if (!existsSync(dbPath)) {
    throw new Error(`CodeGraph database not found: ${dbPath}`);
  }

  const db = new DatabaseSync(dbPath);
  try {
    const kinds = [...MEANINGFUL_NODE_KINDS];
    const placeholders = kinds.map(() => '?').join(',');
    const nodeRows = db.prepare(
      `SELECT id, kind, name, qualified_name AS qualifiedName, file_path AS filePath, language,
              start_line AS startLine, end_line AS endLine, docstring, signature
       FROM nodes
       WHERE kind IN (${placeholders})
       ORDER BY file_path, start_line, name`
    ).all(...kinds) as CodeGraphNodeRow[];
    const edgeRows = db.prepare(
      `SELECT e.source AS sourceId, t.name AS targetName
       FROM edges e
       JOIN nodes t ON t.id = e.target
       WHERE e.kind = 'calls'
       ORDER BY e.source, t.name`
    ).all() as CodeGraphEdgeRow[];
    const files = db.prepare(
      'SELECT path, content_hash AS contentHash, language FROM files ORDER BY path'
    ).all() as CodeGraphFileRow[];

    const callsByNodeId = new Map<string, string[]>();
    for (const edge of edgeRows) {
      const calls = callsByNodeId.get(edge.sourceId) ?? [];
      calls.push(edge.targetName);
      callsByNodeId.set(edge.sourceId, calls);
    }

    return {
      projectPath: projectRoot,
      nodes: nodeRows.map((row) => buildSnapshotNode(row, callsByNodeId.get(row.id) ?? [])),
      files: files.filter(isSnapshotFile)
    };
  } finally {
    db.close();
  }
}

function buildSnapshotNode(row: CodeGraphNodeRow, calls: readonly string[]): CodeGraphSnapshotNode {
  const node: CodeGraphSnapshotNode = {
    id: row.id,
    kind: row.kind,
    name: row.name,
    qualifiedName: row.qualifiedName,
    filePath: row.filePath,
    language: row.language,
    calls: [...calls]
  };
  if (typeof row.startLine === 'number') {
    node.startLine = row.startLine;
  }
  if (typeof row.endLine === 'number') {
    node.endLine = row.endLine;
  }
  if (typeof row.docstring === 'string' && row.docstring.length > 0) {
    node.docstring = row.docstring;
  }
  if (typeof row.signature === 'string' && row.signature.length > 0) {
    node.signature = row.signature;
  }
  return node;
}

function compareSnapshotNodes(left: CodeGraphSnapshotNode, right: CodeGraphSnapshotNode): number {
  return left.filePath.localeCompare(right.filePath) ||
    (left.startLine ?? 0) - (right.startLine ?? 0) ||
    left.name.localeCompare(right.name);
}

function isSnapshotNode(value: unknown): value is CodeGraphSnapshotNode {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const node = value as Partial<CodeGraphSnapshotNode>;
  return (
    typeof node.id === 'string' &&
    typeof node.kind === 'string' &&
    typeof node.name === 'string' &&
    typeof node.qualifiedName === 'string' &&
    typeof node.filePath === 'string' &&
    typeof node.language === 'string' &&
    Array.isArray(node.calls)
  );
}

function isSnapshotFile(value: unknown): value is CodeGraphSnapshotFile {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const file = value as Partial<CodeGraphSnapshotFile>;
  return typeof file.path === 'string' && typeof file.contentHash === 'string' && typeof file.language === 'string';
}

function attachSourceSnippets(
  snapshot: CodeGraphSnapshot,
  projectRoot: string,
  sourceSnippetFiles?: ReadonlySet<string>
): CodeGraphSnapshot {
  const sourceTextByFile = new Map<string, string | undefined>();
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => {
      if (sourceSnippetFiles && !sourceSnippetFiles.has(normalizeProjectRelativePath(node.filePath))) {
        return stripNodeSourceSnippet(node);
      }
      let sourceText = sourceTextByFile.get(node.filePath);
      if (sourceText === undefined && !sourceTextByFile.has(node.filePath)) {
        sourceText = loadSourceText(projectRoot, node.filePath);
        sourceTextByFile.set(node.filePath, sourceText);
      }
      const sourceSnippet = sourceText ? sliceSourceSnippet(sourceText, node.startLine, node.endLine) : undefined;
      return sourceSnippet ? { ...node, sourceSnippet } : node;
    })
  };
}

function writeCachedCodeGraphSnapshot(
  cachePath: string,
  projectRoot: string,
  fingerprint: string | null,
  snapshot: CodeGraphSnapshot
): void {
  writeFileSync(cachePath, JSON.stringify({
    ...snapshot,
    projectPath: projectRoot,
    codeGraphFingerprint: fingerprint
  }));
}

function stripSourceSnippets(snapshot: CodeGraphSnapshot): CodeGraphSnapshot {
  return {
    ...snapshot,
    nodes: snapshot.nodes.map(stripNodeSourceSnippet)
  };
}

function stripNodeSourceSnippet(node: CodeGraphSnapshotNode): CodeGraphSnapshotNode {
  if (node.sourceSnippet === undefined) {
    return node;
  }
  const { sourceSnippet: _sourceSnippet, ...rest } = node;
  return rest;
}

function hasSourceSnippets(snapshot: CodeGraphSnapshot): boolean {
  return snapshot.nodes.some((node) => typeof node.sourceSnippet === 'string' && node.sourceSnippet.length > 0);
}

function normalizeSourceSnippetFiles(sourceSnippetFiles: readonly string[] | undefined): ReadonlySet<string> | undefined {
  if (!sourceSnippetFiles || sourceSnippetFiles.length === 0) {
    return undefined;
  }
  return new Set(sourceSnippetFiles.map(normalizeProjectRelativePath));
}

function normalizeProjectRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function loadSourceText(projectRoot: string, filePath: string, io: SourceSnippetIo = defaultSourceSnippetIo): string | undefined {
  return loadSourceTextForFile(projectRoot, filePath, io);
}

function scanMeaningfulNodes(filePath: string, language: string, sourceText: string): CodeGraphSnapshotNode[] {
  const nodes: CodeGraphSnapshotNode[] = [];
  const lines = sourceText.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }
    const declaration = parseLineDeclaration(line);
    if (!declaration) {
      continue;
    }
    const startLine = index + 1;
    const endLine = findDeclarationEndLine(lines, index);
    const blockText = lines.slice(index, endLine).join('\n');
    nodes.push({
      id: scannedNodeId(filePath, declaration.kind, declaration.name, startLine),
      kind: declaration.kind,
      name: declaration.name,
      qualifiedName: `${filePath}::${declaration.name}`,
      filePath,
      language,
      startLine,
      endLine,
      ...(declaration.signature ? { signature: declaration.signature } : {}),
      calls: extractCallNames(blockText, declaration.name)
    });
  }
  return nodes;
}

function parseLineDeclaration(line: string): { kind: CodeGraphSnapshotNode['kind']; name: string; signature?: string } | null {
  const functionMatch = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*([^ {;]+(?:\s*[^ {;]+)*))?/.exec(line);
  if (functionMatch?.[1]) {
    const returnType = functionMatch[3]?.trim();
    return {
      kind: 'function',
      name: functionMatch[1],
      signature: `function ${functionMatch[1]}(${normalizeSpaces(functionMatch[2] ?? '')})${returnType ? `: ${returnType}` : ''}`
    };
  }
  const arrowMatch = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*(?::\s*([^=]+?))?\s*=>/.exec(line);
  if (arrowMatch?.[1]) {
    const params = normalizeSpaces(arrowMatch[2] ?? arrowMatch[3] ?? '');
    const returnType = arrowMatch[4]?.trim();
    return {
      kind: 'function',
      name: arrowMatch[1],
      signature: `function ${arrowMatch[1]}(${params})${returnType ? `: ${returnType}` : ''}`
    };
  }
  const classMatch = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line);
  if (classMatch?.[1]) {
    return { kind: 'class', name: classMatch[1], signature: `class ${classMatch[1]}` };
  }
  const interfaceMatch = /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/.exec(line);
  if (interfaceMatch?.[1]) {
    return { kind: 'interface', name: interfaceMatch[1], signature: `interface ${interfaceMatch[1]}` };
  }
  return null;
}

function findDeclarationEndLine(lines: readonly string[], startIndex: number): number {
  let seenOpenBrace = false;
  let depth = 0;
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    for (const char of line) {
      if (char === '{') {
        seenOpenBrace = true;
        depth += 1;
      } else if (char === '}') {
        depth = Math.max(0, depth - 1);
        if (seenOpenBrace && depth === 0) {
          return index + 1;
        }
      }
    }
    if (!seenOpenBrace && /=>\s*[^{]+$/.test(line.trim())) {
      return index + 1;
    }
  }
  return Math.min(lines.length, startIndex + 1);
}

function extractCallNames(sourceText: string, currentName: string): string[] {
  const names = new Set<string>();
  const matcher = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of sourceText.matchAll(matcher)) {
    const candidate = match[1];
    if (!candidate || candidate === currentName || CALL_NAME_BLACKLIST.has(candidate)) {
      continue;
    }
    names.add(candidate);
  }
  return [...names];
}

function scannedNodeId(filePath: string, kind: string, name: string, startLine: number): string {
  return `${kind}:${createStableHash(`${filePath}\0${kind}\0${name}\0${startLine}`)}`;
}

function createStableHash(value: string): string {
  return value.split('').reduce((hash, char) => ((hash * 31) + char.charCodeAt(0)) >>> 0, 2166136261).toString(16);
}

function normalizeSpaces(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function inferLanguageFromPath(filePath: string): string {
  if (/\.(tsx?|mts|cts)$/i.test(filePath)) {
    return 'typescript';
  }
  if (/\.(jsx?|mjs|cjs)$/i.test(filePath)) {
    return 'javascript';
  }
  return 'text';
}

function loadSourceTextForFile(projectRoot: string, filePath: string, io: SourceSnippetIo = defaultSourceSnippetIo): string | undefined {
  if (!filePath || isAbsolute(filePath)) {
    return undefined;
  }
  try {
    const realProjectRoot = io.realpath(projectRoot);
    const candidatePath = resolve(projectRoot, filePath);
    if (!isPathInside(realProjectRoot, candidatePath)) {
      return undefined;
    }
    const realCandidate = io.realpath(candidatePath);
    if (!isPathInside(realProjectRoot, realCandidate)) {
      return undefined;
    }
    const stat = io.stat(realCandidate);
    if (!stat.isFile()) {
      return undefined;
    }
    return io.readFilePrefix(realCandidate, Math.min(stat.size, MAX_SOURCE_FILE_READ_BYTES));
  } catch {
    return undefined;
  }
}

function sliceSourceSnippet(source: string, startLine: number | undefined, endLine: number | undefined): string | undefined {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine! <= 0 || endLine! < startLine!) {
    return undefined;
  }
  if (!source) {
    return undefined;
  }
  const lines = source.split(/\r?\n/);
  if (startLine! > lines.length) {
    return undefined;
  }
  const lastLine = Math.min(endLine!, startLine! + MAX_SOURCE_SNIPPET_LINES - 1, lines.length);
  const snippet = lines
    .slice(startLine! - 1, lastLine)
    .join('\n')
    .slice(0, MAX_SOURCE_SNIPPET_CHARS)
    .trimEnd();
  return snippet.length > 0 ? snippet : undefined;
}

const defaultSourceSnippetIo: SourceSnippetIo = {
  realpath: (path) => realpathSync.native(path),
  stat: (path) => statSync(path),
  readFilePrefix
};

function readFilePrefix(path: string, maxBytes: number): string {
  const byteCount = Math.max(0, Math.min(maxBytes, MAX_SOURCE_FILE_READ_BYTES));
  const buffer = Buffer.alloc(byteCount);
  const fd = openSync(path, 'r');
  try {
    const bytesRead = readSync(fd, buffer, 0, byteCount, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (fromRoot.length > 0 && !fromRoot.startsWith('..') && !isAbsolute(fromRoot));
}
