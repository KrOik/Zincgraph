import { createServer, type Server } from 'node:http';
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
import type { EmbeddingAdapter } from '../../src/vector/embedding/index.js';

const tempProjects: string[] = [];
const servers: Server[] = [];
const fusionStores: FusionStore[] = [];
const manifestStores: VectorManifestStore[] = [];
const VECTORIZE_TEST_TIMEOUT_MS = 60_000;

function tempProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'zincgraph-vectorize-test-'));
  tempProjects.push(project);
  return project;
}

afterEach(() => {
  for (const store of manifestStores.splice(0)) {
    store.close();
  }
  for (const store of fusionStores.splice(0)) {
    store.close();
  }
  for (const project of tempProjects.splice(0)) {
    rmSync(project, { force: true, recursive: true });
  }
  for (const server of servers.splice(0)) {
    server.close();
  }
});

function trackedFusionStore(project: string): FusionStore {
  const store = new FusionStore(project);
  fusionStores.push(store);
  return store;
}

function trackedManifestStore(project: string, embeddingProfile = 'local-token-v1:64'): VectorManifestStore {
  const store = new VectorManifestStore(trackedFusionStore(project), embeddingProfile);
  manifestStores.push(store);
  return store;
}

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

function updateFakeCodeGraphFileHash(project: string, filePath: string, contentHash: string): void {
  const script = String.raw`
import os
import sqlite3
import sys
project = sys.argv[1]
file_path = sys.argv[2]
content_hash = sys.argv[3]
db_path = os.path.join(project, '.codegraph', 'codegraph.db')
con = sqlite3.connect(db_path)
con.execute('UPDATE files SET content_hash = ? WHERE path = ?', (content_hash, file_path))
con.commit()
con.close()
`;
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const result = spawnSync(py, ['-c', script, project, filePath, contentHash], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
}

function deleteFakeCodeGraphFile(project: string, filePath: string): void {
  const script = String.raw`
import os
import sqlite3
import sys
project = sys.argv[1]
file_path = sys.argv[2]
db_path = os.path.join(project, '.codegraph', 'codegraph.db')
con = sqlite3.connect(db_path)
node_ids = [row[0] for row in con.execute('SELECT id FROM nodes WHERE file_path = ?', (file_path,)).fetchall()]
if node_ids:
    placeholders = ','.join('?' for _ in node_ids)
    con.execute(f'DELETE FROM edges WHERE source IN ({placeholders}) OR target IN ({placeholders})', tuple(node_ids + node_ids))
con.execute('DELETE FROM nodes WHERE file_path = ?', (file_path,))
con.execute('DELETE FROM files WHERE path = ?', (file_path,))
con.commit()
con.close()
`;
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const result = spawnSync(py, ['-c', script, project, filePath], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
}

function makeCountingAdapter(profile = 'test-token-v1:64'): { adapter: EmbeddingAdapter; batches: string[][] } {
  const batches: string[][] = [];
  return {
    batches,
    adapter: {
      provider: 'local',
      profile,
      async embed(texts: readonly string[]) {
        batches.push([...texts]);
        return texts.map((text, index) => ({
          sparse: { [index + 1]: 1 },
          dense: Array.from({ length: 64 }, (_, dimension) => (dimension === index % 64 ? 1 : 0)),
          tokens: [text]
        }));
      }
    }
  };
}

async function startEmbeddingServer(): Promise<string> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input?: string[] };
    const texts = payload.input ?? [];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      data: texts.map((_text, index) => ({
        embedding: [1, index + 1, 0]
      }))
    }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('missing embedding server address');
  }
  return `http://127.0.0.1:${address.port}/embeddings`;
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

  test('adds normalized identifier tokens for underscore and camelCase evidence', () => {
    const node = {
      ...sampleSnapshot().nodes[0]!,
      filePath: 'pkg/registry/apis/datasource/sub_proxy_loader.go',
      qualifiedName: 'pkg/registry/apis/datasource/sub_proxy_loader.go::datasourceLoader::GetHTTPTransport',
      name: 'GetHTTPTransport',
      signature: 'func (d *datasourceLoader) GetHTTPTransport()',
      docstring: 'Loads HTTP transport settings',
      sourceSnippet: 'return transport',
      calls: []
    };

    const text = buildNodeText(node);
    expect(text).toContain('normalized path');
    expect(text).toMatch(/normalized path .*\bproxy\b/);
    expect(text).toContain('normalized qualified');
    expect(text).toContain('get http transport');
  });

  test('creates vector documents traceable to CodeGraph node ids', async () => {
    const [document] = await createVectorDocuments(sampleSnapshot());
    expect(document?.nodeId).toBe('node-1');
    expect(document?.content).toContain('validateToken');
    expect(document?.chunkerVersion).toBe(DEFAULT_CHUNKER_VERSION);
    expect(Object.keys(document?.contentSparse ?? {}).length).toBeGreaterThan(0);
  });

  test('adds semantic bridge metadata for isolated same-file peers', async () => {
    const snapshot: CodeGraphSnapshot = {
      projectPath: '/tmp/project',
      files: [{ path: 'src/auth.ts', contentHash: 'file-hash', language: 'typescript' }],
      nodes: [
        {
          id: 'node-orphan',
          kind: 'function',
          name: 'authenticateRequest',
          qualifiedName: 'src/auth.ts::authenticateRequest',
          filePath: 'src/auth.ts',
          language: 'typescript',
          signature: 'function authenticateRequest(request: Request): Response',
          docstring: 'Validates bearer credentials',
          calls: []
        },
        {
          id: 'node-peer',
          kind: 'function',
          name: 'LegacyRouteGuard',
          qualifiedName: 'src/auth.ts::LegacyRouteGuard',
          filePath: 'src/auth.ts',
          language: 'typescript',
          signature: 'function LegacyRouteGuard(): void',
          docstring: 'Compatibility guard used during framework migration',
          calls: []
        }
      ]
    };

    const documents = await createVectorDocuments(snapshot);
    const orphan = documents.find((document) => document.nodeId === 'node-orphan');
    expect(orphan?.semanticAliases).toContain('LegacyRouteGuard');
    expect(orphan?.semanticNeighbors?.[0]?.nodeId).toBe('node-peer');
    expect(orphan?.content).toContain('semantic aliases');
  });

  test('seeds semantic bridges from cross-file call edges', async () => {
    const snapshot: CodeGraphSnapshot = {
      projectPath: '/tmp/project',
      files: [
        { path: 'src/caller.ts', contentHash: 'caller-hash', language: 'typescript' },
        { path: 'src/plain.ts', contentHash: 'plain-hash', language: 'typescript' }
      ],
      nodes: [
        {
          id: 'node-caller',
          kind: 'function',
          name: 'caller',
          qualifiedName: 'src/caller.ts::caller',
          filePath: 'src/caller.ts',
          language: 'typescript',
          signature: 'function caller(): void',
          docstring: 'Calls the plain helper',
          calls: ['plainHelper']
        },
        {
          id: 'node-target',
          kind: 'function',
          name: 'plainHelper',
          qualifiedName: 'src/plain.ts::plainHelper',
          filePath: 'src/plain.ts',
          language: 'typescript',
          signature: 'function plainHelper(): void',
          docstring: 'Receives cross-file calls',
          calls: []
        }
      ]
    };

    const documents = await createVectorDocuments(snapshot);
    const caller = documents.find((document) => document.nodeId === 'node-caller');
    expect(caller?.semanticNeighbors?.some((neighbor) => neighbor.nodeId === 'node-target')).toBe(true);
    expect(caller?.content).toContain('semantic neighbors');
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
  }, 15_000);

  test('reads lightweight CodeGraph snapshots without source snippets', () => {
    const project = tempProject();
    createFakeCodeGraph(project, 50);
    const snapshot = readCodeGraphSnapshot(project, { includeSourceSnippets: false });

    expect(snapshot.nodes).toHaveLength(50);
    expect(snapshot.nodes.some((node) => typeof node.sourceSnippet === 'string')).toBe(false);
  }, 15_000);

  test('can attach source snippets only for targeted files', () => {
    const project = tempProject();
    createFakeCodeGraph(project, 50);
    const snapshot = readCodeGraphSnapshot(project, {
      includeSourceSnippets: true,
      sourceSnippetFiles: ['src/file0.ts']
    });

    expect(snapshot.nodes.some((node) => node.filePath === 'src/file0.ts' && typeof node.sourceSnippet === 'string')).toBe(true);
    expect(snapshot.nodes.some((node) => node.filePath === 'src/file1.ts' && typeof node.sourceSnippet === 'string')).toBe(false);
  }, 15_000);

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

  test('refreshes cached snapshots when the CodeGraph DB changes', () => {
    const project = tempProject();
    createFakeCodeGraph(project, 10);
    const first = readCodeGraphSnapshot(project);
    expect(first.files[0]?.contentHash).toBe('hash-0');

    updateFakeCodeGraphFileHash(project, 'src/file0.ts', 'hash-updated');

    const second = readCodeGraphSnapshot(project);
    expect(second.files[0]?.contentHash).toBe('hash-updated');
  }, 15_000);

  test('safe source snippets reject symlink and prefix-sibling escapes', () => {
    const project = tempProject();
    const sibling = `${project}-evil`;
    mkdirSync(join(project, 'src'), { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'secret.ts'), 'secret\n');
    try {
      symlinkSync(join(sibling, 'secret.ts'), join(project, 'src/link.ts'));
      expect(safeSourceSnippet(project, 'src/link.ts', 1, 1)).toBeUndefined();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EACCES') {
        throw error;
      }
    }
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
    const store = trackedFusionStore(project);
    const manifest = trackedManifestStore(project, 'local-token-v1:64');
    expect(store.countVectorDocuments()).toBe(result.documentsWritten);
    const [stored] = store.listVectorDocuments();
    expect(stored?.chunkerVersion).toBe(DEFAULT_CHUNKER_VERSION);
    expect((stored?.json as { chunkerVersion?: string } | undefined)?.chunkerVersion).toBe(DEFAULT_CHUNKER_VERSION);
    expect(manifest.summary()).toMatchObject({ fresh: 5, stale: 0, failed: 0 });
    expect(manifest.entries().every((entry) => entry.chunkerVersion === DEFAULT_CHUNKER_VERSION)).toBe(true);
  }, VECTORIZE_TEST_TIMEOUT_MS);

  test('vectorizeProject scopes collection path and stored docs by configured embedding profile', async () => {
    const project = tempProject();
    const endpoint = await startEmbeddingServer();
    createFakeCodeGraph(project, 10);
    const metadata = trackedFusionStore(project);
    metadata.setMetadata('embedding.provider', 'http');
    metadata.setMetadata('embedding.profile', 'repo-http-v1');
    metadata.setMetadata('embedding.network', 'enabled');
    metadata.setMetadata('embedding.http.endpoint', endpoint);

    const result = await vectorizeProject(project);
    const store = trackedFusionStore(project);
    const manifest = trackedManifestStore(project, 'repo-http-v1');

    expect(result.collectionPath).toContain('repo-http-v1');
    expect(store.listVectorDocuments('repo-http-v1', DEFAULT_CHUNKER_VERSION)).toHaveLength(result.documentsWritten);
    expect(store.listVectorDocuments('other-profile', DEFAULT_CHUNKER_VERSION)).toHaveLength(0);
    expect(manifest.summary()).toMatchObject({ fresh: 5, stale: 0, failed: 0 });
  }, VECTORIZE_TEST_TIMEOUT_MS);

  test('vectorizeProject only embeds and rewrites changed-file nodes on subsequent runs', async () => {
    const project = tempProject();
    createFakeCodeGraph(project, 20);
    const { adapter, batches } = makeCountingAdapter();

    await vectorizeProject(project, { dependencies: { adapter } });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(20);

    updateFakeCodeGraphFileHash(project, 'src/file0.ts', 'hash-0-updated');

    await vectorizeProject(project, { dependencies: { adapter } });
    expect(batches).toHaveLength(2);
    expect(batches[1]).toHaveLength(4);

    const store = trackedFusionStore(project);
    const manifest = trackedManifestStore(project, adapter.profile);
    expect(store.countVectorDocuments()).toBe(20);
    expect(manifest.getByFile('src/file0.ts')?.contentHash).toBe('hash-0-updated');
    expect(manifest.summary()).toMatchObject({ fresh: 5, stale: 0, failed: 0 });
  }, VECTORIZE_TEST_TIMEOUT_MS);

  test('vectorizeProject honors explicit changedFiles during incremental refresh', async () => {
    const project = tempProject();
    createFakeCodeGraph(project, 20);
    const { adapter, batches } = makeCountingAdapter();

    await vectorizeProject(project, { dependencies: { adapter } });
    updateFakeCodeGraphFileHash(project, 'src/file0.ts', 'hash-0-updated');
    updateFakeCodeGraphFileHash(project, 'src/file1.ts', 'hash-1-updated');

    await vectorizeProject(project, {
      changedFiles: ['src/file0.ts'],
      dependencies: { adapter }
    });

    const store = trackedFusionStore(project);
    const manifest = trackedManifestStore(project, adapter.profile);
    expect(batches).toHaveLength(2);
    expect(batches[1]).toHaveLength(4);
    expect(manifest.getByFile('src/file0.ts')?.contentHash).toBe('hash-0-updated');
    expect(manifest.getByFile('src/file1.ts')?.contentHash).toBe('hash-1');
    expect(store.countVectorDocuments()).toBe(20);
  }, VECTORIZE_TEST_TIMEOUT_MS);

  test('vectorizeProject deletes stale documents and manifest entries for removed files', async () => {
    const project = tempProject();
    createFakeCodeGraph(project, 20);
    const { adapter } = makeCountingAdapter('test-token-v1:64');

    await vectorizeProject(project, { dependencies: { adapter } });
    deleteFakeCodeGraphFile(project, 'src/file4.ts');

    await vectorizeProject(project, { dependencies: { adapter } });

    const store = trackedFusionStore(project);
    const manifest = trackedManifestStore(project, adapter.profile);
    expect(store.countVectorDocuments()).toBe(16);
    expect(manifest.getByFile('src/file4.ts')).toBeNull();
    expect(manifest.summary()).toMatchObject({ fresh: 4, stale: 0, failed: 0 });
  }, VECTORIZE_TEST_TIMEOUT_MS);

  test('vectorizeProject only removes deleted files listed in changedFiles', async () => {
    const project = tempProject();
    createFakeCodeGraph(project, 20);
    const { adapter } = makeCountingAdapter('test-token-v1:64');

    await vectorizeProject(project, { dependencies: { adapter } });
    deleteFakeCodeGraphFile(project, 'src/file4.ts');

    await vectorizeProject(project, {
      changedFiles: ['src/file4.ts'],
      dependencies: { adapter }
    });

    const store = trackedFusionStore(project);
    const manifest = trackedManifestStore(project, adapter.profile);
    expect(store.countVectorDocuments()).toBe(16);
    expect(manifest.getByFile('src/file4.ts')).toBeNull();
    expect(manifest.getByFile('src/file0.ts')?.state).toBe('fresh');
  }, VECTORIZE_TEST_TIMEOUT_MS);
});
