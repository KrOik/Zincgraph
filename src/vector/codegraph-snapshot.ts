import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
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

interface CodeGraphCandidateSnapshotCache extends CodeGraphSnapshotCache {
  cacheVersion: number;
  cacheKey: string;
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

export interface ReadCodeGraphCandidateSnapshotOptions extends ReadCodeGraphSnapshotOptions {
  maxNodes?: number;
}

export interface SourceSnippetIo {
  realpath(path: string): string;
  stat(path: string): Pick<Stats, 'isFile' | 'size'>;
  readFilePrefix(path: string, maxBytes: number): string;
}

const FULL_SNAPSHOT_CACHE_FILE = 'codegraph-snapshot.json';
const LITE_SNAPSHOT_CACHE_FILE = 'codegraph-snapshot-lite.json';
const CANDIDATE_SNAPSHOT_CACHE_VERSION = 1;
const CANDIDATE_SNAPSHOT_CACHE_DIR = 'zincgraph-codegraph-candidate-cache';
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
const BROAD_SYMBOL_CANDIDATES = new Set([
  'add',
  'build',
  'check',
  'create',
  'delete',
  'execute',
  'fetch',
  'get',
  'init',
  'list',
  'load',
  'main',
  'open',
  'patch',
  'read',
  'run',
  'set',
  'start',
  'stop',
  'sync',
  'test',
  'update',
  'validate',
  'write'
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

  const cachedLite = readCachedCodeGraphSnapshot(projectRoot, fingerprint, { includeSourceSnippets: false });
  const baseSnapshot = cachedLite ?? loadCodeGraphSnapshot(projectRoot);
  if (!cachedLite) {
    writeCodeGraphSnapshotCache(projectRoot, baseSnapshot, { includeSourceSnippets: false });
  }
  return attachSourceSnippets(baseSnapshot, projectRoot, sourceSnippetFiles);
}

export function readCodeGraphCandidateSnapshot(
  projectPath: string,
  query: string,
  options: ReadCodeGraphCandidateSnapshotOptions = {}
): CodeGraphSnapshot | null {
  ensureCodeGraphIndex(projectPath);
  const projectRoot = resolve(projectPath);
  const dbPath = join(projectRoot, '.codegraph', 'codegraph.db');
  if (!existsSync(dbPath)) {
    return null;
  }

  const maxNodes = Math.max(16, Math.min(options.maxNodes ?? 512, 2_000));
  const fingerprint = codeGraphDbFingerprint(projectRoot);
  const sourceSnippetFiles = normalizeSourceSnippetFiles(options.sourceSnippetFiles);
  const candidateCacheKey = codeGraphCandidateSnapshotCacheKey(
    projectRoot,
    fingerprint,
    query,
    maxNodes,
    options.includeSourceSnippets === true,
    sourceSnippetFiles
  );
  const cachedSnapshot = readCachedCodeGraphCandidateSnapshot(
    projectRoot,
    fingerprint,
    candidateCacheKey
  );
  if (cachedSnapshot) {
    return cachedSnapshot;
  }
  const pathCandidates = extractQueryPathCandidates(query).slice(0, 48);
  const rawSymbolCandidates = extractQuerySymbolCandidates(query);
  const symbolCandidates = (pathCandidates.length > 0
    ? rawSymbolCandidates.filter(isStrongSymbolCandidate)
    : rawSymbolCandidates).slice(0, 96);
  const ftsTerms = extractCandidateFtsTerms(query).slice(0, 32);
  const familyTerms = candidateFamilyTerms(ftsTerms);
  if (pathCandidates.length === 0 && symbolCandidates.length === 0 && ftsTerms.length === 0) {
    return null;
  }

  const db = new DatabaseSync(dbPath);
  try {
    const rows = new Map<string, CodeGraphNodeRow>();
    const addRows = (nextRows: CodeGraphNodeRow[]): void => {
      for (const row of nextRows) {
        if (rows.size >= maxNodes && !rows.has(row.id)) {
          continue;
        }
        rows.set(row.id, row);
      }
    };

    for (const pathCandidate of pathCandidates) {
      addRows(selectNodesForPathCandidate(
        db,
        pathCandidate,
        Math.min(96, Math.max(24, Math.ceil(maxNodes / Math.max(1, pathCandidates.length))))
      ));
    }
    if (pathCandidates.length > 0) {
      if (shouldExpandRelatedTestCandidates(query, pathCandidates, rawSymbolCandidates)) {
        addRows(selectRelatedTestNodesForPathCandidates(db, pathCandidates, Math.max(24, Math.min(96, maxNodes - rows.size))));
      }
      if (rows.size < maxNodes) {
        addRows(selectRelatedImplementationNodesForPathCandidates(db, pathCandidates, Math.max(0, Math.min(48, maxNodes - rows.size))));
      }
      if (rows.size < maxNodes) {
        addRows(selectPathAnchorExtraNodes(
          db,
          pathCandidates,
          symbolCandidates,
          query,
          Math.max(0, Math.min(48, maxNodes - rows.size))
        ));
      }
    }
    if (/\blineage\b|searchLineage/i.test(query)) {
      addRows(selectNodesForPathCandidate(db, 'LineageUtil.java', 8));
    }
    const highConfidenceSymbolHitPaths = new Set<string>();
    const testSymbolHitPaths = new Set<string>();
    for (const symbolCandidate of symbolCandidates) {
      if (rows.size >= maxNodes) break;
      const broadSymbol = isBroadSymbolCandidate(symbolCandidate);
      const symbolRows = selectNodesForSymbolCandidate(db, symbolCandidate, familyTerms, broadSymbol ? 4 : 16);
      for (const row of symbolRows) {
        if (!broadSymbol && rowMatchesCandidateFamily(row, familyTerms)) {
          highConfidenceSymbolHitPaths.add(row.filePath);
          if (isTestLikePath(row.filePath)) {
            testSymbolHitPaths.add(row.filePath);
          }
        }
      }
      addRows(symbolRows);
    }
    if (rows.size < maxNodes) {
      addRows(selectFamilyActionTestNodes(
        db,
        rawSymbolCandidates,
        familyTerms,
        Math.max(0, Math.min(24, maxNodes - rows.size))
      ));
    }
    const siblingExpansionPaths = uniqueStrings([
      ...testSymbolHitPaths,
      ...highConfidenceSymbolHitPaths
    ]);
    if (pathCandidates.length === 0 && rows.size < maxNodes && siblingExpansionPaths.length > 0) {
      addRows(selectSiblingNodesForFilePaths(
        db,
        siblingExpansionPaths,
        Math.max(0, Math.min(96, maxNodes - rows.size))
      ));
    }
    if (rows.size < maxNodes) {
      addRows(selectTestFileNodesForSymbolCandidates(
        db,
        rawSymbolCandidates,
        familyTerms,
        Math.max(0, Math.min(48, maxNodes - rows.size))
      ));
    }
    const ftsTarget = pathCandidates.length > 0 ? Math.min(maxNodes, 64) : maxNodes;
    if (rows.size < ftsTarget && ftsTerms.length > 0) {
      addRows(selectNodesForFtsTerms(db, ftsTerms, ftsTarget - rows.size));
    }

    if (rows.size === 0) {
      return null;
    }

    const selectedRows = [...rows.values()].slice(0, maxNodes);
    const selectedIds = selectedRows.map((row) => row.id);
    const callsByNodeId = loadCallsForNodeIds(db, selectedIds);
    const selectedPaths = [...new Set(selectedRows.map((row) => row.filePath))];
    const files = loadFilesForPaths(db, selectedPaths);
    const snapshot: CodeGraphSnapshot = {
      projectPath: projectRoot,
      nodes: selectedRows.map((row) => buildSnapshotNode(row, callsByNodeId.get(row.id) ?? [])),
      files
    };
    const result = options.includeSourceSnippets === true && sourceSnippetFiles
      ? attachSourceSnippets(snapshot, projectRoot, sourceSnippetFiles)
      : snapshot;
    writeCachedCodeGraphCandidateSnapshot(projectRoot, fingerprint, candidateCacheKey, result);
    return result;
  } catch {
    return null;
  } finally {
    db.close();
  }
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

function codeGraphCandidateSnapshotCacheKey(
  projectRoot: string,
  fingerprint: string | null,
  query: string,
  maxNodes: number,
  includeSourceSnippets: boolean,
  sourceSnippetFiles: ReadonlySet<string> | undefined
): string {
  const payload = {
    version: CANDIDATE_SNAPSHOT_CACHE_VERSION,
    projectRoot,
    fingerprint,
    query,
    maxNodes,
    includeSourceSnippets,
    sourceSnippetFiles: sourceSnippetFiles ? [...sourceSnippetFiles].sort() : []
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function candidateSnapshotCachePath(cacheKey: string): string {
  return join(tmpdir(), CANDIDATE_SNAPSHOT_CACHE_DIR, `${cacheKey}.json`);
}

function readCachedCodeGraphCandidateSnapshot(
  projectRoot: string,
  expectedFingerprint: string | null,
  expectedCacheKey: string
): CodeGraphSnapshot | null {
  const cachePath = candidateSnapshotCachePath(expectedCacheKey);
  if (!existsSync(cachePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as Partial<CodeGraphCandidateSnapshotCache>;
    if (
      parsed.cacheVersion !== CANDIDATE_SNAPSHOT_CACHE_VERSION ||
      parsed.cacheKey !== expectedCacheKey ||
      !fingerprintMatches(projectRoot, parsed.projectPath, parsed.codeGraphFingerprint, expectedFingerprint) ||
      !Array.isArray(parsed.nodes) ||
      !Array.isArray(parsed.files)
    ) {
      return null;
    }
    return {
      projectPath: projectRoot,
      nodes: parsed.nodes.filter(isSnapshotNode),
      files: parsed.files.filter(isSnapshotFile)
    };
  } catch {
    return null;
  }
}

function writeCachedCodeGraphCandidateSnapshot(
  projectRoot: string,
  fingerprint: string | null,
  cacheKey: string,
  snapshot: CodeGraphSnapshot
): void {
  try {
    const cacheDir = join(tmpdir(), CANDIDATE_SNAPSHOT_CACHE_DIR);
    mkdirSync(cacheDir, { recursive: true });
    const cachePath = join(cacheDir, `${cacheKey}.json`);
    const tempPath = join(cacheDir, `${cacheKey}.${process.pid}.${Date.now()}.tmp`);
    const payload: CodeGraphCandidateSnapshotCache = {
      ...snapshot,
      projectPath: projectRoot,
      codeGraphFingerprint: fingerprint,
      cacheVersion: CANDIDATE_SNAPSHOT_CACHE_VERSION,
      cacheKey
    };
    writeFileSync(tempPath, JSON.stringify(payload));
    renameSync(tempPath, cachePath);
  } catch {
    // Candidate caching is an optional latency optimization; query correctness
    // must not depend on the temp cache being writable.
  }
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

function selectNodesForPathCandidate(db: DatabaseSync, pathCandidate: string, limit: number): CodeGraphNodeRow[] {
  const normalized = normalizeProjectRelativePath(pathCandidate).replace(/^\.?\//, '');
  if (!normalized) {
    return [];
  }
  const kinds = [...MEANINGFUL_NODE_KINDS];
  const placeholders = kinds.map(() => '?').join(',');
  const suffix = `%/${escapeLike(normalized)}`;
  const contains = `%${escapeLike(normalized)}%`;
  return db.prepare(
    `SELECT id, kind, name, qualified_name AS qualifiedName, file_path AS filePath, language,
            start_line AS startLine, end_line AS endLine, docstring, signature
     FROM nodes
     WHERE kind IN (${placeholders})
       AND (file_path = ? OR file_path LIKE ? ESCAPE '\\' OR file_path LIKE ? ESCAPE '\\')
     ORDER BY
       CASE
         WHEN file_path = ? THEN 0
         WHEN file_path LIKE ? ESCAPE '\\' THEN 1
         ELSE 2
       END,
       file_path, start_line, name
     LIMIT ?`
  ).all(...kinds, normalized, suffix, contains, normalized, suffix, limit) as CodeGraphNodeRow[];
}

function selectNodesForSymbolCandidate(
  db: DatabaseSync,
  symbolCandidate: string,
  familyTerms: readonly string[],
  limit: number
): CodeGraphNodeRow[] {
  const symbol = symbolCandidate.trim();
  if (!symbol || symbol.length < 2) {
    return [];
  }
  const leaf = symbol.split(/::|[.#]/).filter(Boolean).at(-1) ?? symbol;
  const lowerSymbol = symbol.toLowerCase();
  const lowerLeaf = leaf.toLowerCase();
  const kinds = [...MEANINGFUL_NODE_KINDS];
  const placeholders = kinds.map(() => '?').join(',');
  const familyFilter = familyTerms.length > 0
    ? `AND (${familyTerms.map(() => `lower(file_path) LIKE ? ESCAPE '\\'`).join(' OR ')})`
    : '';
  const familyArgs = familyTerms.map((term) => `%${escapeLike(term)}%`);
  return db.prepare(
    `SELECT id, kind, name, qualified_name AS qualifiedName, file_path AS filePath, language,
            start_line AS startLine, end_line AS endLine, docstring, signature
     FROM nodes
     WHERE kind IN (${placeholders})
       AND (lower(name) = ? OR lower(name) = ? OR qualified_name = ? OR lower(qualified_name) = ?)
       ${familyFilter}
     ORDER BY
       CASE
         WHEN lower(name) = ? THEN 0
         WHEN lower(name) = ? THEN 1
         WHEN qualified_name = ? THEN 2
         ELSE 3
       END,
       length(file_path), file_path, start_line, name
     LIMIT ?`
  ).all(
    ...kinds,
    lowerSymbol,
    lowerLeaf,
    symbol,
    lowerSymbol,
    ...familyArgs,
    lowerSymbol,
    lowerLeaf,
    symbol,
    limit
  ) as CodeGraphNodeRow[];
}

function selectRelatedTestNodesForPathCandidates(
  db: DatabaseSync,
  pathCandidates: readonly string[],
  limit: number
): CodeGraphNodeRow[] {
  if (limit <= 0) {
    return [];
  }
  const rows = new Map<string, CodeGraphNodeRow>();
  for (const pathCandidate of pathCandidates) {
    if (rows.size >= limit) {
      break;
    }
    if (isTestLikePath(pathCandidate)) {
      const nextRows = selectSiblingTestNodesForTestPathCandidate(db, pathCandidate, Math.min(12, limit - rows.size));
      for (const row of nextRows) {
        rows.set(row.id, row);
      }
      continue;
    }
    const tokens = pathStemTokens(pathCandidate).slice(0, 3);
    if (tokens.length === 0) {
      continue;
    }
    const nextRows = selectRelatedTestNodes(db, tokens, Math.min(12, limit - rows.size));
    for (const row of nextRows) {
      rows.set(row.id, row);
    }
  }
  return [...rows.values()];
}

function selectSiblingTestNodesForTestPathCandidate(
  db: DatabaseSync,
  pathCandidate: string,
  limit: number
): CodeGraphNodeRow[] {
  const normalized = normalizeProjectRelativePath(pathCandidate).replace(/^\.?\//, '');
  if (limit <= 0 || !normalized || !isTestLikePath(normalized)) {
    return [];
  }
  const tokens = pathStemTokens(normalized).slice(0, 2);
  const compactTokens = tokens.map((token) => token.toLowerCase().replace(/[_-]/g, '')).filter(Boolean);
  if (compactTokens.length === 0) {
    return [];
  }
  const suitePrefix = testSuitePrefix(normalized);
  const kinds = [...MEANINGFUL_NODE_KINDS];
  const kindPlaceholders = kinds.map(() => '?').join(',');
  const compactPredicates = compactTokens
    .map(() => `replace(replace(lower(file_path), '_', ''), '-', '') LIKE ? ESCAPE '\\'`)
    .join(' AND ');
  const compactArgs = compactTokens.map((token) => `%${escapeLike(token)}%`);
  const suitePredicate = suitePrefix ? `AND file_path LIKE ? ESCAPE '\\'` : '';
  const suiteArgs = suitePrefix ? [`${escapeLike(suitePrefix)}%`] : [];
  return db.prepare(
    `SELECT id, kind, name, qualified_name AS qualifiedName, file_path AS filePath, language,
            start_line AS startLine, end_line AS endLine, docstring, signature
     FROM nodes
     WHERE kind IN (${kindPlaceholders})
       AND file_path != ?
       AND (lower(file_path) LIKE '%test%' OR lower(file_path) LIKE '%spec%')
       ${suitePredicate}
       AND ${compactPredicates}
     ORDER BY length(file_path), file_path, start_line, name
     LIMIT ?`
  ).all(...kinds, normalized, ...suiteArgs, ...compactArgs, limit) as CodeGraphNodeRow[];
}

function selectRelatedImplementationNodesForPathCandidates(
  db: DatabaseSync,
  pathCandidates: readonly string[],
  limit: number
): CodeGraphNodeRow[] {
  if (limit <= 0 || pathCandidates.length > 2) {
    return [];
  }
  const rows = new Map<string, CodeGraphNodeRow>();
  for (const pathCandidate of pathCandidates) {
    if (rows.size >= limit || isTestLikePath(pathCandidate)) {
      continue;
    }
    const fileName = basename(pathCandidate);
    const stem = fileName.replace(/\.[^.]+$/, '');
    if (!/[_-]/.test(stem)) {
      continue;
    }
    const tokens = pathStemTokens(pathCandidate).filter((token) => token.length >= 4).slice(0, 3);
    if (tokens.length === 0) {
      continue;
    }
    const nextRows = selectRelatedImplementationNodes(
      db,
      normalizeProjectRelativePath(pathCandidate).replace(/^\.?\//, ''),
      fileName,
      Math.min(12, limit - rows.size)
    );
    for (const row of nextRows) {
      rows.set(row.id, row);
    }
  }
  return [...rows.values()];
}

function selectSiblingNodesForFilePaths(
  db: DatabaseSync,
  filePaths: readonly string[],
  limit: number
): CodeGraphNodeRow[] {
  if (limit <= 0) {
    return [];
  }
  const rows = new Map<string, CodeGraphNodeRow>();
  for (const filePath of filePaths.slice(0, 12)) {
    if (rows.size >= limit) {
      break;
    }
    const nextRows = selectNodesForPathCandidate(db, filePath, Math.min(16, limit - rows.size));
    for (const row of nextRows) {
      rows.set(row.id, row);
    }
  }
  return [...rows.values()];
}

function selectTestFileNodesForSymbolCandidates(
  db: DatabaseSync,
  symbolCandidates: readonly string[],
  familyTerms: readonly string[],
  limit: number
): CodeGraphNodeRow[] {
  if (limit <= 0) {
    return [];
  }
  const rows = new Map<string, CodeGraphNodeRow>();
  const candidates = uniqueStrings(symbolCandidates
    .map((candidate) => candidate.trim().toLowerCase())
    .filter((candidate) => /^test[_-]/.test(candidate) || /_tests?$/.test(candidate) || /_test_/.test(candidate)));
  for (const candidate of candidates.slice(0, 12)) {
    if (rows.size >= limit) {
      break;
    }
    for (const row of selectTestFileNodesForSymbolCandidate(db, candidate, familyTerms, Math.min(12, limit - rows.size))) {
      rows.set(row.id, row);
    }
  }
  return [...rows.values()];
}

function selectTestFileNodesForSymbolCandidate(
  db: DatabaseSync,
  symbolCandidate: string,
  familyTerms: readonly string[],
  limit: number
): CodeGraphNodeRow[] {
  if (limit <= 0) {
    return [];
  }
  const compact = symbolCandidate.replace(/[_-]/g, '');
  if (compact.length < 6) {
    return [];
  }
  const kinds = [...MEANINGFUL_NODE_KINDS];
  const kindPlaceholders = kinds.map(() => '?').join(',');
  const familyFilter = familyTerms.length > 0
    ? `AND (${familyTerms.map(() => `lower(file_path) LIKE ? ESCAPE '\\'`).join(' OR ')})`
    : '';
  const familyArgs = familyTerms.map((term) => `%${escapeLike(term)}%`);
  return db.prepare(
    `SELECT id, kind, name, qualified_name AS qualifiedName, file_path AS filePath, language,
            start_line AS startLine, end_line AS endLine, docstring, signature
     FROM nodes
     WHERE kind IN (${kindPlaceholders})
       AND (lower(file_path) LIKE '%test%' OR lower(file_path) LIKE '%spec%')
       AND replace(replace(lower(file_path), '_', ''), '-', '') LIKE ? ESCAPE '\\'
       ${familyFilter}
     ORDER BY
       CASE kind
         WHEN 'class' THEN 0
         WHEN 'interface' THEN 1
         ELSE 2
       END,
       length(file_path), file_path, start_line, name
     LIMIT ?`
  ).all(...kinds, `%${escapeLike(compact)}%`, ...familyArgs, limit) as CodeGraphNodeRow[];
}

function selectFamilyActionTestNodes(
  db: DatabaseSync,
  symbolCandidates: readonly string[],
  familyTerms: readonly string[],
  limit: number
): CodeGraphNodeRow[] {
  if (limit <= 0) {
    return [];
  }
  const actionNames = uniqueStrings(symbolCandidates
    .map((candidate) => candidate.trim().toLowerCase())
    .filter((candidate) => BROAD_SYMBOL_CANDIDATES.has(candidate))
    .map((candidate) => `test_${candidate}`))
    .slice(0, 4);
  if (actionNames.length === 0) {
    return [];
  }
  if (familyTerms.length === 0) {
    return [];
  }
  const kinds = [...MEANINGFUL_NODE_KINDS];
  const kindPlaceholders = kinds.map(() => '?').join(',');
  const familyPredicates = familyTerms
    .map(() => `lower(file_path) LIKE ? ESCAPE '\\'`)
    .join(' AND ');
  const familyArgs = familyTerms.map((term) => `%${escapeLike(term)}%`);
  const rows = new Map<string, CodeGraphNodeRow>();
  for (const actionName of actionNames) {
    if (rows.size >= limit) {
      break;
    }
    const nextRows = db.prepare(
      `SELECT id, kind, name, qualified_name AS qualifiedName, file_path AS filePath, language,
              start_line AS startLine, end_line AS endLine, docstring, signature
       FROM nodes
       WHERE kind IN (${kindPlaceholders})
         AND (lower(file_path) LIKE '%test%' OR lower(file_path) LIKE '%spec%')
         AND lower(name) = ?
         AND ${familyPredicates}
       ORDER BY length(file_path), file_path, start_line, name
       LIMIT ?`
    ).all(...kinds, actionName, ...familyArgs, Math.max(0, limit - rows.size)) as CodeGraphNodeRow[];
    for (const row of nextRows) {
      rows.set(row.id, row);
    }
  }
  return [...rows.values()];
}

function selectRelatedImplementationNodes(
  db: DatabaseSync,
  sourcePath: string,
  fileName: string,
  limit: number
): CodeGraphNodeRow[] {
  if (limit <= 0 || !fileName) {
    return [];
  }
  const kinds = [...MEANINGFUL_NODE_KINDS];
  const kindPlaceholders = kinds.map(() => '?').join(',');
  const suffix = `%/${escapeLike(fileName.toLowerCase())}`;
  return db.prepare(
    `SELECT id, kind, name, qualified_name AS qualifiedName, file_path AS filePath, language,
            start_line AS startLine, end_line AS endLine, docstring, signature
     FROM nodes
     WHERE kind IN (${kindPlaceholders})
       AND file_path != ?
       AND lower(file_path) NOT LIKE '%test%'
       AND lower(file_path) NOT LIKE '%spec%'
       AND lower(file_path) LIKE ? ESCAPE '\\'
     ORDER BY length(file_path), file_path, start_line, name
     LIMIT ?`
  ).all(...kinds, sourcePath, suffix, limit) as CodeGraphNodeRow[];
}

function selectPathAnchorExtraNodes(
  db: DatabaseSync,
  pathCandidates: readonly string[],
  symbolCandidates: readonly string[],
  query: string,
  limit: number
): CodeGraphNodeRow[] {
  if (limit <= 0 || pathCandidates.length === 0) {
    return [];
  }
  const rows = new Map<string, CodeGraphNodeRow>();
  const classAnchors = (pathCandidates.length <= 2 ? symbolCandidates
    .concat(query.split(/\s+/g).filter(Boolean))
    .filter((candidate) => /[A-Z]/.test(candidate))
    .map((candidate) => candidate.split(/::|[.#]/).filter(Boolean).at(-1) ?? candidate)
    .filter((candidate) => candidate.length >= 3)
    .slice(0, 12) : []);
  for (const pathCandidate of pathCandidates.slice(0, 12)) {
    if (rows.size >= limit) {
      break;
    }
    for (const row of selectTestApiNodesForPathCandidate(db, pathCandidate, Math.min(4, limit - rows.size))) {
      rows.set(row.id, row);
    }
    if (!/\.(?:rs|py)$/i.test(pathCandidate)) {
      continue;
    }
    for (const classAnchor of classAnchors) {
      if (rows.size >= limit) {
        break;
      }
      for (const row of selectClassMemberNodesForPathCandidate(db, pathCandidate, classAnchor, Math.min(6, limit - rows.size))) {
        rows.set(row.id, row);
      }
    }
  }
  return [...rows.values()];
}

function selectClassMemberNodesForPathCandidate(
  db: DatabaseSync,
  pathCandidate: string,
  classAnchor: string,
  limit: number
): CodeGraphNodeRow[] {
  const normalized = normalizeProjectRelativePath(pathCandidate).replace(/^\.?\//, '');
  if (!normalized || limit <= 0) {
    return [];
  }
  const kinds = [...MEANINGFUL_NODE_KINDS];
  const placeholders = kinds.map(() => '?').join(',');
  const suffix = `%/${escapeLike(normalized)}`;
  const contains = `%${escapeLike(normalized)}%`;
  const memberPattern = `%${escapeLike(classAnchor.toLowerCase())}::%`;
  const broadMemberPattern = `%${escapeLike(classAnchor.toLowerCase())}%`;
  return db.prepare(
    `SELECT id, kind, name, qualified_name AS qualifiedName, file_path AS filePath, language,
            start_line AS startLine, end_line AS endLine, docstring, signature
     FROM nodes
     WHERE kind IN (${placeholders})
       AND (file_path = ? OR file_path LIKE ? ESCAPE '\\' OR file_path LIKE ? ESCAPE '\\')
       AND (lower(qualified_name) LIKE ? ESCAPE '\\' OR lower(qualified_name) LIKE ? ESCAPE '\\')
     ORDER BY
       CASE
         WHEN lower(name) LIKE '%bootstrap%' THEN 0
         WHEN lower(name) LIKE '%migrate%' THEN 1
         WHEN lower(name) IN ('read', 'check') THEN 2
         WHEN lower(name) LIKE '%from_options%' THEN 3
         ELSE 4
       END,
       start_line, name
     LIMIT ?`
  ).all(...kinds, normalized, suffix, contains, memberPattern, broadMemberPattern, limit) as CodeGraphNodeRow[];
}

function selectTestApiNodesForPathCandidate(
  db: DatabaseSync,
  pathCandidate: string,
  limit: number
): CodeGraphNodeRow[] {
  const normalized = normalizeProjectRelativePath(pathCandidate).replace(/^\.?\//, '');
  if (!normalized || limit <= 0 || !isTestLikePath(normalized)) {
    return [];
  }
  const kinds = [...MEANINGFUL_NODE_KINDS];
  const placeholders = kinds.map(() => '?').join(',');
  const suffix = `%/${escapeLike(normalized)}`;
  const contains = `%${escapeLike(normalized)}%`;
  return db.prepare(
    `SELECT id, kind, name, qualified_name AS qualifiedName, file_path AS filePath, language,
            start_line AS startLine, end_line AS endLine, docstring, signature
     FROM nodes
     WHERE kind IN (${placeholders})
       AND (file_path = ? OR file_path LIKE ? ESCAPE '\\' OR file_path LIKE ? ESCAPE '\\')
       AND (lower(name) LIKE '%testing_api%' OR lower(qualified_name) LIKE '%testing_api%' OR lower(name) LIKE '%test%api%')
     ORDER BY length(name), start_line, name
     LIMIT ?`
  ).all(...kinds, normalized, suffix, contains, limit) as CodeGraphNodeRow[];
}

function selectRelatedTestNodes(db: DatabaseSync, tokens: readonly string[], limit: number): CodeGraphNodeRow[] {
  const kinds = [...MEANINGFUL_NODE_KINDS];
  const kindPlaceholders = kinds.map(() => '?').join(',');
  const tokenPredicates = tokens
    .map(() => `(lower(file_path) LIKE ? ESCAPE '\\' OR replace(replace(lower(file_path), '_', ''), '-', '') LIKE ? ESCAPE '\\')`)
    .join(' AND ');
  const tokenArgs = tokens.flatMap((token) => {
    const lowerToken = token.toLowerCase();
    const compactToken = lowerToken.replace(/[_-]/g, '');
    return [
      `%${escapeLike(lowerToken)}%`,
      `%${escapeLike(compactToken)}%`
    ];
  });
  return db.prepare(
    `SELECT id, kind, name, qualified_name AS qualifiedName, file_path AS filePath, language,
            start_line AS startLine, end_line AS endLine, docstring, signature
     FROM nodes
     WHERE kind IN (${kindPlaceholders})
       AND (lower(file_path) LIKE '%test%' OR lower(file_path) LIKE '%spec%')
       AND ${tokenPredicates}
     ORDER BY length(file_path), file_path, start_line, name
     LIMIT ?`
  ).all(...kinds, ...tokenArgs, limit) as CodeGraphNodeRow[];
}

function selectNodesForFtsTerms(db: DatabaseSync, terms: readonly string[], limit: number): CodeGraphNodeRow[] {
  if (limit <= 0) {
    return [];
  }
  const query = buildFtsQuery(terms);
  if (!query) {
    return [];
  }
  const kinds = [...MEANINGFUL_NODE_KINDS];
  const placeholders = kinds.map(() => '?').join(',');
  try {
    return db.prepare(
      `SELECT n.id, n.kind, n.name, n.qualified_name AS qualifiedName, n.file_path AS filePath, n.language,
              n.start_line AS startLine, n.end_line AS endLine, n.docstring, n.signature
       FROM nodes_fts f
       JOIN nodes n ON n.rowid = f.rowid
       WHERE nodes_fts MATCH ? AND n.kind IN (${placeholders})
       ORDER BY rank, length(n.file_path), n.file_path, n.start_line, n.name
       LIMIT ?`
    ).all(query, ...kinds, limit) as CodeGraphNodeRow[];
  } catch {
    return [];
  }
}

function loadCallsForNodeIds(db: DatabaseSync, nodeIds: readonly string[]): Map<string, string[]> {
  const callsByNodeId = new Map<string, string[]>();
  for (const batch of chunkArray(nodeIds, 500)) {
    if (batch.length === 0) continue;
    const placeholders = batch.map(() => '?').join(',');
    const edgeRows = db.prepare(
      `SELECT e.source AS sourceId, t.name AS targetName
       FROM edges e
       JOIN nodes t ON t.id = e.target
       WHERE e.kind = 'calls' AND e.source IN (${placeholders})
       ORDER BY e.source, t.name`
    ).all(...batch) as CodeGraphEdgeRow[];
    for (const edge of edgeRows) {
      const calls = callsByNodeId.get(edge.sourceId) ?? [];
      calls.push(edge.targetName);
      callsByNodeId.set(edge.sourceId, calls);
    }
  }
  return callsByNodeId;
}

function loadFilesForPaths(db: DatabaseSync, paths: readonly string[]): CodeGraphSnapshotFile[] {
  const files: CodeGraphSnapshotFile[] = [];
  for (const batch of chunkArray(paths, 500)) {
    if (batch.length === 0) continue;
    const placeholders = batch.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT path, content_hash AS contentHash, language
       FROM files
       WHERE path IN (${placeholders})
       ORDER BY path`
    ).all(...batch) as unknown[];
    files.push(...rows.filter(isSnapshotFile));
  }
  return files;
}

function extractQueryPathCandidates(query: string): string[] {
  return uniqueStrings(query.split(/\s+/)
    .map(cleanQueryPart)
    .filter((part) => part.includes('/') || part.includes('\\'))
    .map((part) => part.replace(/^file:/i, '').replace(/^path:/i, '').replace(/\\/g, '/'))
    .filter((part) => part.length > 1));
}

function extractQuerySymbolCandidates(query: string): string[] {
  return uniqueStrings(query.split(/\s+/)
    .flatMap((part) => {
      const cleaned = cleanQueryPart(part);
      if (!cleaned || cleaned.includes('/')) {
        return [];
      }
      const withoutField = cleaned.replace(/^(?:name|symbol|kind):/i, '');
      const leaf = withoutField.split(/::|[.#]/).filter(Boolean).at(-1);
      return [withoutField, leaf ?? ''];
    })
    .filter((part) => /^[A-Za-z_$][\w$.:#-]*$/.test(part) && part.length >= 2));
}

function isStrongSymbolCandidate(candidate: string): boolean {
  const cleaned = cleanQueryPart(candidate).replace(/^(?:name|symbol|kind):/i, '');
  if (!cleaned) {
    return false;
  }
  return /^test[_-]/i.test(cleaned) ||
    /[A-Z]/.test(cleaned) ||
    /[_$:#.]/.test(cleaned) ||
    cleaned.length >= 18;
}

function isBroadSymbolCandidate(candidate: string): boolean {
  const normalized = cleanQueryPart(candidate)
    .replace(/^(?:name|symbol|kind):/i, '')
    .toLowerCase();
  return BROAD_SYMBOL_CANDIDATES.has(normalized);
}

function shouldExpandRelatedTestCandidates(
  query: string,
  pathCandidates: readonly string[],
  symbolCandidates: readonly string[]
): boolean {
  if (pathCandidates.some((pathCandidate) => isTestLikePath(pathCandidate))) {
    return true;
  }
  if (pathCandidates.some((pathCandidate) => isMainJavaPathCandidate(pathCandidate))) {
    return true;
  }
  if (symbolCandidates.some((candidate) => /^test[_-]/i.test(candidate))) {
    return true;
  }
  return /\b(?:affected|impact|runtime|spec|specs|test|tests|unit|integration)\b/i.test(query);
}

function candidateFamilyTerms(ftsTerms: readonly string[]): string[] {
  return uniqueStrings(ftsTerms
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 4 && !BROAD_SYMBOL_CANDIDATES.has(term) && !CANDIDATE_STOP_WORDS.has(term)))
    .slice(0, 4);
}

function rowMatchesCandidateFamily(row: CodeGraphNodeRow, familyTerms: readonly string[]): boolean {
  if (familyTerms.length === 0) {
    return true;
  }
  const filePath = row.filePath.toLowerCase();
  return familyTerms.some((term) => filePath.includes(term));
}

function extractCandidateFtsTerms(query: string): string[] {
  return uniqueStrings(query
    .split(/[^A-Za-z0-9_]+/)
    .flatMap((part) => splitIdentifierWords(part))
    .map((part) => part.toLowerCase())
    .filter((part) => part.length >= 3 && !CANDIDATE_STOP_WORDS.has(part) && !/^\d+$/.test(part)));
}

function cleanQueryPart(part: string): string {
  return part.trim().replace(/^[`'"]+|[`'",;]+$/g, '');
}

function isTestLikePath(value: string): boolean {
  return /(^|[/\\])(?:test|tests|spec|specs)([/\\]|$)|(?:test|spec)\.[A-Za-z0-9]+$/i.test(value);
}

function isMainJavaPathCandidate(value: string): boolean {
  const normalized = normalizeProjectRelativePath(value).replace(/\\/g, '/').toLowerCase();
  return normalized.includes('/src/main/') && normalized.endsWith('.java');
}

function testSuitePrefix(value: string): string {
  const normalized = normalizeProjectRelativePath(value).replace(/^\.?\//, '');
  const segments = normalized.split('/').filter(Boolean);
  let suiteIndex = -1;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (/^(?:test|tests|spec|specs|unit_tests|integration_tests)$/i.test(segments[index] ?? '')) {
      suiteIndex = index;
      break;
    }
  }
  if (suiteIndex < 0) {
    return '';
  }
  return `${segments.slice(0, suiteIndex + 1).join('/')}/`;
}

function pathStemTokens(value: string): string[] {
  const normalized = normalizeProjectRelativePath(value);
  const base = normalized.split('/').at(-1) ?? normalized;
  const stem = base.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  return uniqueStrings(splitIdentifierWords(stem)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length >= 3 && !CANDIDATE_STOP_WORDS.has(part) && !/^\d+$/.test(part)));
}

function splitIdentifierWords(value: string): string[] {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9_]+|_+/)
    .filter(Boolean);
}

function buildFtsQuery(terms: readonly string[]): string {
  return uniqueStrings(terms)
    .slice(0, 16)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(' OR ');
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))];
}

function chunkArray<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size) as T[]);
  }
  return chunks;
}

const CANDIDATE_STOP_WORDS = new Set([
  'the', 'and', 'for', 'from', 'with', 'this', 'that', 'test', 'tests', 'src',
  'source', 'unit', 'integration', 'function', 'class', 'method', 'file', 'path'
]);

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
