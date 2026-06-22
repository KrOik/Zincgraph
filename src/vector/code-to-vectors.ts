import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { runCodeGraphCli } from '../bridge/codegraphAdapter.js';
import { FusionStore } from '../freshness/fusion-store.js';
import { VectorManifestStore } from '../freshness/manifest.js';
import { SemanticStatus } from '../freshness/semantic-status.js';
import { openCollection } from './collection-manager.js';
import { getAdapter, type EmbeddingAdapter } from './embedding/index.js';
import type { VectorDocumentInput } from './zvec-adapter.js';
import { DEFAULT_CHUNKER_VERSION } from './chunker.js';

export const MEANINGFUL_NODE_KINDS = ['function', 'class', 'method', 'interface', 'component'] as const;
export const DEFAULT_EMBEDDING_PROVIDER = 'local';

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

export interface VectorDocument {
  id: string;
  nodeId: string;
  filePath: string;
  language: string;
  kind: string;
  qualifiedName: string;
  content: string;
  contentHash: string;
  chunkerVersion: string;
  tokens: string[];
  contentSparse: Record<number, number>;
  embedding: number[];
}

export interface VectorizeResult {
  projectPath: string;
  collectionPath: string;
  fusionDbPath: string;
  filesFresh: number;
  documentsWritten: number;
  manifestWarnings: string[];
}

const SNAPSHOT_SCRIPT = String.raw`
import json
import os
import sqlite3
import sys

project = os.path.abspath(json.loads(sys.stdin.read())["projectPath"])
db_path = os.path.join(project, ".codegraph", "codegraph.db")
if not os.path.exists(db_path):
    raise SystemExit(f"CodeGraph database not found: {db_path}")
con = sqlite3.connect(db_path)
con.row_factory = sqlite3.Row
kinds = ("function", "class", "method", "interface", "component")
placeholders = ",".join("?" for _ in kinds)
nodes = []
for row in con.execute(f"SELECT * FROM nodes WHERE kind IN ({placeholders}) ORDER BY file_path,start_line,name", kinds):
    calls = [r["name"] for r in con.execute(
        "SELECT t.name FROM edges e JOIN nodes t ON t.id=e.target WHERE e.source=? AND e.kind='calls' ORDER BY t.name",
        (row["id"],),
    )]
    nodes.append({
        "id": row["id"],
        "kind": row["kind"],
        "name": row["name"],
        "qualifiedName": row["qualified_name"],
        "filePath": row["file_path"],
        "language": row["language"],
        "startLine": row["start_line"],
        "endLine": row["end_line"],
        "docstring": row["docstring"],
        "signature": row["signature"],
        "calls": calls,
    })
files = [{"path": row["path"], "contentHash": row["content_hash"], "language": row["language"]}
         for row in con.execute("SELECT path,content_hash,language FROM files ORDER BY path")]
con.close()
print(json.dumps({"projectPath": project, "nodes": nodes, "files": files}, sort_keys=True))
`;

export const MAX_SOURCE_SNIPPET_LINES = 80;
export const MAX_SOURCE_SNIPPET_CHARS = 6_000;
export const MAX_SOURCE_FILE_READ_BYTES = 1_048_576;

export interface SourceSnippetIo {
  realpath(path: string): string;
  stat(path: string): Pick<Stats, 'isFile' | 'size'>;
  readFilePrefix(path: string, maxBytes: number): string;
}

export function ensureCodeGraphIndex(projectPath: string): void {
  const projectRoot = resolve(projectPath);
  const dbPath = join(projectRoot, '.codegraph', 'codegraph.db');
  if (!existsSync(dbPath)) {
    const init = runCodeGraphCli(['init', projectRoot]);
    if (init.status !== 0) {
      throw new Error(init.stderr || init.stdout || 'CodeGraph init failed');
    }
  }
}

export function readCodeGraphSnapshot(projectPath: string): CodeGraphSnapshot {
  ensureCodeGraphIndex(projectPath);
  const projectRoot = resolve(projectPath);
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const child = spawnSync(py, ['-c', SNAPSHOT_SCRIPT], {
    input: JSON.stringify({ projectPath: projectRoot }),
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  if (child.status !== 0) {
    throw new Error(child.stderr || `Failed to read CodeGraph snapshot for ${projectRoot}`);
  }
  return attachSourceSnippets(JSON.parse(child.stdout) as CodeGraphSnapshot, projectRoot);
}

export function buildNodeText(node: CodeGraphSnapshotNode): string {
  return [
    `path ${node.filePath}`,
    node.signature || node.qualifiedName || node.name,
    node.docstring ?? '',
    node.sourceSnippet ? `source\n${node.sourceSnippet}` : '',
    node.calls.length > 0 ? `calls ${node.calls.join(' ')}` : ''
  ]
    .filter((part) => part.trim().length > 0)
    .join('\n');
}

export async function createVectorDocuments(
  snapshot: CodeGraphSnapshot,
  adapter: EmbeddingAdapter = getAdapter(DEFAULT_EMBEDDING_PROVIDER)
): Promise<VectorDocument[]> {
  const contents = snapshot.nodes.map(buildNodeText);
  const embeddings = await adapter.embed(contents);
  return snapshot.nodes.map((node, index) => {
    const embedding = embeddings[index];
    if (!embedding) {
      throw new Error(`Missing embedding result for ${node.id}`);
    }
    const content = contents[index] ?? node.qualifiedName;
    const fileHash = snapshot.files.find((file) => file.path === node.filePath)?.contentHash ?? hashText(content);
    return {
      id: node.id,
      nodeId: node.id,
      filePath: node.filePath,
      language: node.language,
      kind: node.kind,
      qualifiedName: node.qualifiedName,
      content,
      contentHash: fileHash,
      chunkerVersion: DEFAULT_CHUNKER_VERSION,
      tokens: embedding.tokens,
      contentSparse: embedding.sparse,
      embedding: embedding.dense
    };
  });
}

export async function vectorizeProject(projectPath: string): Promise<VectorizeResult> {
  const projectRoot = resolve(projectPath);
  const snapshot = readCodeGraphSnapshot(projectRoot);
  const adapter = getAdapter(DEFAULT_EMBEDDING_PROVIDER);
  const documents = await createVectorDocuments(snapshot, adapter);
  const collection = openCollection(projectRoot);
  const fusionStore = new FusionStore(projectRoot);
  const manifest = new VectorManifestStore(fusionStore, adapter.profile);

  try {
    const vectorInputs: VectorDocumentInput[] = documents.map((document) => ({
      id: document.id,
      nodeId: document.nodeId,
      filePath: document.filePath,
      language: document.language,
      kind: document.kind,
      qualifiedName: document.qualifiedName,
        contentHash: document.contentHash,
        chunkerVersion: document.chunkerVersion,
        contentSparse: document.contentSparse,
        embedding: document.embedding
      }));

    for (const file of snapshot.files) {
      manifest.markPending(file.path, file.contentHash);
    }

    collection.insertDocuments(vectorInputs);
    collection.flush();

    fusionStore.upsertVectorDocuments(
      documents.map((document) => ({
        id: document.id,
        nodeId: document.nodeId,
        filePath: document.filePath,
        embeddingProfile: adapter.profile,
        chunkerVersion: document.chunkerVersion,
        json: document
      }))
    );

    const docIdsByFile = new Map<string, string[]>();
    for (const document of documents) {
      const docIds = docIdsByFile.get(document.filePath) ?? [];
      docIds.push(document.id);
      docIdsByFile.set(document.filePath, docIds);
    }

    for (const file of snapshot.files) {
      manifest.markFresh(file.path, file.contentHash, docIdsByFile.get(file.path) ?? []);
    }

    const semanticStatus = new SemanticStatus(manifest.entries());
    return {
      projectPath: projectRoot,
      collectionPath: collection.path,
      fusionDbPath: fusionStore.dbPath,
      filesFresh: manifest.summary().fresh,
      documentsWritten: documents.length,
      manifestWarnings: semanticStatus.getWarnings()
    };
  } catch (error) {
    for (const file of snapshot.files) {
      manifest.markFailed(file.path, file.contentHash, error instanceof Error ? error.message : String(error));
    }
    throw error;
  } finally {
    collection.destroy();
    fusionStore.close();
  }
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function attachSourceSnippets(snapshot: CodeGraphSnapshot, projectRoot: string): CodeGraphSnapshot {
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => {
      const sourceSnippet = safeSourceSnippet(projectRoot, node.filePath, node.startLine, node.endLine);
      return sourceSnippet ? { ...node, sourceSnippet } : node;
    })
  };
}

export function safeSourceSnippet(
  projectPath: string,
  filePath: string,
  startLine: number | undefined,
  endLine: number | undefined,
  io: SourceSnippetIo = defaultSourceSnippetIo
): string | undefined {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine! <= 0 || endLine! < startLine!) {
    return undefined;
  }
  if (!filePath || isAbsolute(filePath)) {
    return undefined;
  }
  const projectRoot = resolve(projectPath);
  const candidatePath = resolve(projectRoot, filePath);
  if (!isPathInside(projectRoot, candidatePath)) {
    return undefined;
  }
  try {
    const realProjectRoot = io.realpath(projectRoot);
    const realCandidate = io.realpath(candidatePath);
    if (!isPathInside(realProjectRoot, realCandidate)) {
      return undefined;
    }
    const stat = io.stat(realCandidate);
    if (!stat.isFile()) {
      return undefined;
    }
    const source = io.readFilePrefix(realCandidate, Math.min(stat.size, MAX_SOURCE_FILE_READ_BYTES));
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
  } catch {
    return undefined;
  }
}

const defaultSourceSnippetIo: SourceSnippetIo = {
  realpath: (path) => realpathSync.native(path),
  stat: (path) => statSync(path),
  readFilePrefix: readFilePrefix
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
