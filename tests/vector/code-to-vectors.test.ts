import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, test } from 'vitest';

import { FusionStore } from '../../src/freshness/fusion-store.js';
import { VectorManifestStore } from '../../src/freshness/manifest.js';
import { openCollection } from '../../src/vector/collection-manager.js';
import {
  buildNodeText,
  createVectorDocuments,
  MAX_SOURCE_FILE_READ_BYTES,
  MAX_SOURCE_SNIPPET_CHARS,
  readCodeGraphSnapshot,
  safeSourceSnippet,
  vectorizeProject,
  type CodeGraphSnapshot
} from '../../src/vector/code-to-vectors.js';
import { DEFAULT_CHUNKER_VERSION } from '../../src/vector/chunker.js';

const tempProjects: string[] = [];
const VECTORIZE_TEST_TIMEOUT_MS = 30_000;

function tempProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'zincgraph-vectorize-test-'));
  tempProjects.push(project);
  return project;
}

afterEach(() => {
  for (const project of tempProjects.splice(0)) {
    rmSync(project, { force: true, recursive: true });
  }
});

function createFakeCodeGraph(project: string, nodeCount = 50): void {
  const script = String.raw`
import os
import sqlite3
import sys
project = sys.argv[1]
node_count = int(sys.argv[2])
os.makedirs(os.path.join(project, '.codegraph'), exist_ok=True)
con = sqlite3.connect(os.path.join(project, '.codegraph', 'codegraph.db'))
con.execute('CREATE TABLE nodes(id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, qualified_name TEXT NOT NULL, file_path TEXT NOT NULL, language TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, start_column INTEGER NOT NULL, end_column INTEGER NOT NULL, docstring TEXT, signature TEXT, visibility TEXT, is_exported INTEGER DEFAULT 0, is_async INTEGER DEFAULT 0, is_static INTEGER DEFAULT 0, is_abstract INTEGER DEFAULT 0, decorators TEXT, type_parameters TEXT, return_type TEXT, updated_at INTEGER NOT NULL)')
con.execute('CREATE TABLE edges(id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, metadata TEXT, line INTEGER, col INTEGER, provenance TEXT)')
con.execute('CREATE TABLE files(path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, language TEXT NOT NULL, size INTEGER NOT NULL, modified_at INTEGER NOT NULL, indexed_at INTEGER NOT NULL, node_count INTEGER DEFAULT 0, errors TEXT)')
os.makedirs(os.path.join(project, 'src'), exist_ok=True)
for file_index in range(5):
    source_path = os.path.join(project, 'src', f'file{file_index}.ts')
    with open(source_path, 'w', encoding='utf8') as f:
        for line_index in range(90):
            f.write(f'export function bodyLiteral{file_index}_{line_index}() {{ return "zincgraph_semantic_search"; }}\\n')
    con.execute('INSERT INTO files VALUES(?,?,?,?,?,?,?,?)', (f'src/file{file_index}.ts', f'hash-{file_index}', 'typescript', 100, 1, 1, 10, None))
for i in range(node_count):
    kind = 'function' if i % 2 == 0 else 'interface'
    name = 'validateToken' if i == 0 else f'symbol{i}'
    file_path = f'src/file{i % 5}.ts'
    con.execute('INSERT INTO nodes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (
        f'node-{i}', kind, name, f'{file_path}::{name}', file_path, 'typescript', i + 1, i + 2, 0, 0,
        'Validates bearer token' if i == 0 else None,
        f'function {name}(): boolean' if kind == 'function' else f'interface {name}',
        None, 1, 0, 0, 0, None, None, 'boolean' if kind == 'function' else None, 1
    ))
con.execute('INSERT INTO edges(source,target,kind,metadata,line,col,provenance) VALUES(?,?,?,?,?,?,?)', ('node-0','node-2','calls',None,1,1,None))
con.commit()
con.close()
`;
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const result = spawnSync(py, ['-c', script, project, String(nodeCount)], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
}

function sampleSnapshot(): CodeGraphSnapshot {
  return {
    projectPath: '/tmp/project',
    files: [{ path: 'src/auth.ts', contentHash: 'file-hash', language: 'typescript' }],
    nodes: [
      {
        id: 'node-1',
        kind: 'function',
        name: 'validateToken',
        qualifiedName: 'src/auth.ts::validateToken',
        filePath: 'src/auth.ts',
        language: 'typescript',
        signature: 'function validateToken(token: string): boolean',
        docstring: 'Validates bearer tokens',
        startLine: 1,
        endLine: 3,
        sourceSnippet: 'export function validateToken(token: string) {\n  return decodeJwt(token);\n}',
        calls: ['decodeJwt']
      }
    ]
  };
}

describe('Phase 1 code-to-vector pipeline', () => {
  test('builds text from signature, docstring, and outgoing calls', () => {
    expect(buildNodeText(sampleSnapshot().nodes[0]!)).toContain('decodeJwt');
    expect(buildNodeText(sampleSnapshot().nodes[0]!)).toContain('Validates bearer tokens');
    expect(buildNodeText(sampleSnapshot().nodes[0]!)).toContain('src/auth.ts');
    expect(buildNodeText(sampleSnapshot().nodes[0]!)).toContain('return decodeJwt');
  });

  test('creates vector documents traceable to CodeGraph node ids', async () => {
    const [document] = await createVectorDocuments(sampleSnapshot());
    expect(document?.nodeId).toBe('node-1');
    expect(document?.content).toContain('validateToken');
    expect(document?.chunkerVersion).toBe(DEFAULT_CHUNKER_VERSION);
    expect(Object.keys(document?.contentSparse ?? {}).length).toBeGreaterThan(0);
  });

  test('reads CodeGraph snapshot and filters meaningful nodes', () => {
    const project = tempProject();
    createFakeCodeGraph(project, 50);
    const snapshot = readCodeGraphSnapshot(project);
    expect(snapshot.nodes).toHaveLength(50);
    expect(snapshot.files).toHaveLength(5);
    expect(snapshot.nodes[0]?.calls).toEqual(['symbol2']);
    expect(snapshot.nodes[0]?.startLine).toBe(1);
    expect(snapshot.nodes[0]?.sourceSnippet).toContain('zincgraph_semantic_search');
  });

  test('safe source snippets fail open for unsafe paths and IO failures', () => {
    const project = tempProject();
    mkdirSync(join(project, 'src'), { recursive: true });
    writeFileSync(join(project, 'src/valid.ts'), 'line1\nline2 target\nline3\n');
    expect(safeSourceSnippet(project, 'src/valid.ts', 2, 2)).toBe('line2 target');
    expect(safeSourceSnippet(project, 'src/missing.ts', 1, 1)).toBeUndefined();
    expect(safeSourceSnippet(project, 'src/valid.ts', 99, 100)).toBeUndefined();
    expect(safeSourceSnippet(project, resolve(project, 'src/valid.ts'), 1, 1)).toBeUndefined();
    expect(safeSourceSnippet(project, '../outside.ts', 1, 1)).toBeUndefined();
    expect(safeSourceSnippet(project, 'src', 1, 1)).toBeUndefined();
    expect(safeSourceSnippet(project, 'src/valid.ts', 1, 1, {
      realpath: (path) => path,
      stat: () => { throw new Error('stat failed'); },
      readFilePrefix: () => 'unreachable'
    })).toBeUndefined();
    expect(safeSourceSnippet(project, 'src/valid.ts', 1, 1, {
      realpath: (path) => path,
      stat: () => ({ isFile: () => true, size: 10 }),
      readFilePrefix: () => { throw new Error('read failed'); }
    })).toBeUndefined();
  });

  test('safe source snippets reject symlink and prefix-sibling escapes', () => {
    const project = tempProject();
    const sibling = `${project}-evil`;
    mkdirSync(join(project, 'src'), { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'secret.ts'), 'secret\n');
    symlinkSync(join(sibling, 'secret.ts'), join(project, 'src/link.ts'));
    expect(safeSourceSnippet(project, 'src/link.ts', 1, 1)).toBeUndefined();
    expect(safeSourceSnippet(project, `../${sibling.split('/').pop()}/secret.ts`, 1, 1)).toBeUndefined();
    rmSync(sibling, { force: true, recursive: true });
  });

  test('safe source snippets bound source reads and snippet output', () => {
    const project = tempProject();
    mkdirSync(join(project, 'src'), { recursive: true });
    const longLine = 'x'.repeat(MAX_SOURCE_SNIPPET_CHARS + 500);
    writeFileSync(join(project, 'src/long.ts'), `${longLine}\n${'y'.repeat(MAX_SOURCE_FILE_READ_BYTES)}\n`);
    const snippet = safeSourceSnippet(project, 'src/long.ts', 1, 2);
    expect(snippet?.length).toBeLessThanOrEqual(MAX_SOURCE_SNIPPET_CHARS);
  });

  test('vectorizes a 50 node graph into at least 20 documents', async () => {
    const project = tempProject();
    createFakeCodeGraph(project, 50);
    const result = await vectorizeProject(project);
    expect(result.documentsWritten).toBeGreaterThanOrEqual(20);
    expect(result.filesFresh).toBe(5);
    expect(existsSync(result.fusionDbPath)).toBe(true);
  }, VECTORIZE_TEST_TIMEOUT_MS);

  test('written collection supports text and filtered vector queries', async () => {
    const project = tempProject();
    createFakeCodeGraph(project, 50);
    await vectorizeProject(project);
    const collection = openCollection(project);
    try {
      expect(collection.count()).toBeGreaterThanOrEqual(20);
      await expect(collection.query([{ text: 'token validation' }], 10)).resolves.not.toHaveLength(0);
      expect(collection.queryByKind('function', 10).length).toBeGreaterThan(0);
    } finally {
      collection.destroy();
    }
  }, VECTORIZE_TEST_TIMEOUT_MS);

  test('vectorize stores vector documents and fresh manifest entries', async () => {
    const project = tempProject();
    createFakeCodeGraph(project, 10);
    const result = await vectorizeProject(project);
    const store = new FusionStore(project);
    const manifest = new VectorManifestStore(store, 'local-token-v1:64');
    expect(store.countVectorDocuments()).toBe(result.documentsWritten);
    const [stored] = store.listVectorDocuments();
    expect(stored?.chunkerVersion).toBe(DEFAULT_CHUNKER_VERSION);
    expect((stored?.json as { chunkerVersion?: string } | undefined)?.chunkerVersion).toBe(DEFAULT_CHUNKER_VERSION);
    expect(manifest.summary()).toMatchObject({ fresh: 5, stale: 0, failed: 0 });
    expect(manifest.entries().every((entry) => entry.chunkerVersion === DEFAULT_CHUNKER_VERSION)).toBe(true);
  }, VECTORIZE_TEST_TIMEOUT_MS);
});
