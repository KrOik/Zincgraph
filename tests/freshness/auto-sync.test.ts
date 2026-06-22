import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { AutoSyncPipeline, autoSyncProject, runAutoSyncOnce, type GraphChangeEvent } from '../../src/freshness/auto-sync.js';
import { FusionStore } from '../../src/freshness/fusion-store.js';
import { DEFAULT_FRESHNESS_EMBEDDING_PROFILE } from '../../src/freshness/freshness-gate.js';
import { VectorManifestStore } from '../../src/freshness/manifest.js';
import type { CodeGraphSnapshot } from '../../src/vector/code-to-vectors.js';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'zincgraph-autosync-'));
  writeFileSync(join(root, 'auth.ts'), 'export function validateToken() { return true; }');
  writeFileSync(join(root, 'date.ts'), 'export function formatDate() { return ""; }');
  return root;
}

function snapshot(projectPath: string, contentHash = 'new-hash'): CodeGraphSnapshot {
  return {
    projectPath,
    files: [{ path: 'auth.ts', contentHash, language: 'typescript' }],
    nodes: [{ id: 'node-auth', kind: 'function', name: 'validateToken', qualifiedName: 'validateToken', filePath: 'auth.ts', language: 'typescript', calls: [] }]
  };
}

function manifest(projectPath: string): VectorManifestStore {
  return new VectorManifestStore(new FusionStore(projectPath), DEFAULT_FRESHNESS_EMBEDDING_PROFILE);
}

describe('Phase 4 auto sync pipeline', () => {
  test('file change marks stale then pending then fresh after sync', async () => {
    const project = fixture();
    const events: string[] = [];
    const result = await autoSyncProject(project, { files: [{ path: 'auth.ts', contentHash: 'new-hash' }], source: 'test' }, {
      debounceMs: 0,
      dependencies: {
        syncProject: async () => { events.push('sync'); },
        readSnapshot: () => snapshot(project)
      }
    });
    expect(events).toEqual(['sync']);
    expect(result.transitions[0]?.stale.state).toBe('stale');
    expect(result.transitions[0]?.pending?.state).toBe('pending');
    expect(result.transitions[0]?.fresh?.state).toBe('fresh');
    expect(manifest(project).getByFile('auth.ts')?.state).toBe('fresh');
  });

  test('debounce window reports syncing warning', async () => {
    const project = fixture();
    let resumeSleep!: () => void;
    const pipeline = new AutoSyncPipeline(project, {
      debounceMs: 100,
      dependencies: {
        sleep: async () => new Promise<void>((resolve) => { resumeSleep = resolve; }),
        syncProject: async () => undefined,
        readSnapshot: () => snapshot(project)
      }
    });
    const pending = pipeline.handleChange({ files: [{ path: 'auth.ts', contentHash: 'hash' }], source: 'debounce-test' });
    expect(pipeline.isSyncing()).toBe(true);
    expect(pipeline.freshness().warnings[0]).toContain('syncing');
    resumeSleep();
    await pending;
    expect(pipeline.isSyncing()).toBe(false);
  });

  test('failed sync marks affected file failed', async () => {
    const project = fixture();
    const result = await autoSyncProject(project, { files: [{ path: 'auth.ts', contentHash: 'bad' }] }, {
      debounceMs: 0,
      dependencies: {
        syncProject: async () => { throw new Error('sync failed'); },
        readSnapshot: () => snapshot(project)
      }
    });
    expect(result.warnings[0]).toContain('sync failed');
    expect(result.transitions[0]?.failed?.state).toBe('failed');
    expect(manifest(project).getByFile('auth.ts')?.state).toBe('failed');
  });

  test('injectable event source emits changes without a live daemon', async () => {
    const project = fixture();
    const sourceEvent: GraphChangeEvent = { files: [{ path: 'auth.ts', contentHash: 'source-hash' }], source: 'fake-source' };
    const pipeline = new AutoSyncPipeline(project, {
      debounceMs: 0,
      dependencies: { syncProject: async () => undefined, readSnapshot: () => snapshot(project, 'source-hash') }
    });
    await pipeline.attach({ start: async (onChange) => { await onChange(sourceEvent); } });
    expect(manifest(project).getByFile('auth.ts')?.contentHash).toBe('source-hash');
  });

  test('coalesced multi-file event returns per-file transition evidence', async () => {
    const project = fixture();
    const result = await autoSyncProject(project, {
      files: [{ path: 'auth.ts', contentHash: 'auth-hash' }, { path: 'date.ts', contentHash: 'date-hash' }]
    }, {
      debounceMs: 0,
      dependencies: {
        syncProject: async () => undefined,
        readSnapshot: () => ({ ...snapshot(project, 'auth-hash'), files: [
          { path: 'auth.ts', contentHash: 'auth-hash', language: 'typescript' },
          { path: 'date.ts', contentHash: 'date-hash', language: 'typescript' }
        ] })
      }
    });
    expect(result.transitions.map((transition) => transition.filePath)).toEqual(['auth.ts', 'date.ts']);
  });

  test('rejects traversal paths before hashing outside files or syncing', async () => {
    const project = fixture();
    const outside = resolve(project, '..', 'outside-secret.txt');
    writeFileSync(outside, 'outside secret');
    let syncCalled = false;

    await expect(autoSyncProject(project, {
      files: [{ path: '../outside-secret.txt' }]
    }, {
      debounceMs: 0,
      dependencies: {
        syncProject: async () => { syncCalled = true; },
        readSnapshot: () => snapshot(project)
      }
    })).rejects.toThrow('escapes project root');

    expect(syncCalled).toBe(false);
    expect(manifest(project).entries()).toEqual([]);
  });

  test('rejects absolute changed-file paths even when they point inside project', async () => {
    const project = fixture();

    await expect(autoSyncProject(project, {
      files: [{ path: join(project, 'auth.ts') }]
    }, {
      debounceMs: 0,
      dependencies: {
        syncProject: async () => undefined,
        readSnapshot: () => snapshot(project)
      }
    })).rejects.toThrow('project-relative');
  });

  test('normalizes safe nested relative paths and passes sanitized event to syncProject', async () => {
    const project = fixture();
    let sanitizedEvent!: GraphChangeEvent;
    const result = await autoSyncProject(project, {
      files: [{ path: 'src/../date.ts' }]
    }, {
      debounceMs: 0,
      dependencies: {
        syncProject: async (_projectPath, event) => { sanitizedEvent = event; },
        readSnapshot: () => ({
          ...snapshot(project),
          files: [{ path: 'date.ts', contentHash: 'date-hash', language: 'typescript' }],
          nodes: [{ id: 'node-date', kind: 'function', name: 'formatDate', qualifiedName: 'formatDate', filePath: 'date.ts', language: 'typescript', calls: [] }]
        })
      }
    });

    expect(result.transitions[0]?.filePath).toBe('date.ts');
    expect(sanitizedEvent.files[0]?.path).toBe('date.ts');
    expect(sanitizedEvent.files[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest(project).getByFile('date.ts')?.state).toBe('fresh');
    expect(existsSync(join(project, 'date.ts'))).toBe(true);
  });

  test('runAutoSyncOnce calls CodeGraph sync before full-snapshot vectorization', async () => {
    const project = fixture();
    const events: string[] = [];

    const result = await runAutoSyncOnce(project, { files: ['auth.ts'], source: 'runtime' }, {
      debounceMs: 0,
      dependencies: {
        syncCodeGraph: async () => { events.push('codegraph-sync'); },
        vectorize: async () => {
          events.push('vectorize');
          return {
            projectPath: project,
            collectionPath: join(project, '.zincgraph', 'vectors'),
            fusionDbPath: join(project, '.zincgraph', 'fusion.sqlite'),
            filesFresh: 1,
            documentsWritten: 1,
            manifestWarnings: []
          };
        },
        readSnapshot: () => snapshot(project)
      }
    });

    expect(events).toEqual(['codegraph-sync', 'vectorize']);
    expect(result.source).toBe('runtime');
    expect(result.transitions[0]?.fresh?.state).toBe('fresh');
  });

  test('rejects symlink path segments before graph sync or vectorization', async () => {
    const project = fixture();
    const outside = mkdtempSync(join(tmpdir(), 'zincgraph-autosync-outside-'));
    writeFileSync(join(outside, 'secret.ts'), 'export const secret = true;');
    symlinkSync(outside, join(project, 'linked'), 'dir');
    const events: string[] = [];

    await expect(runAutoSyncOnce(project, { files: ['linked/secret.ts'] }, {
      debounceMs: 0,
      dependencies: {
        syncCodeGraph: async () => { events.push('codegraph-sync'); },
        vectorize: async () => {
          events.push('vectorize');
          return {
            projectPath: project,
            collectionPath: join(project, '.zincgraph', 'vectors'),
            fusionDbPath: join(project, '.zincgraph', 'fusion.sqlite'),
            filesFresh: 0,
            documentsWritten: 0,
            manifestWarnings: []
          };
        },
        readSnapshot: () => snapshot(project)
      }
    })).rejects.toThrow('symlink');

    expect(events).toEqual([]);
    expect(manifest(project).entries()).toEqual([]);
  });

  test('rejects debounce-time symlink swaps before pending state or sync work', async () => {
    const project = fixture();
    const outside = mkdtempSync(join(tmpdir(), 'zincgraph-autosync-outside-'));
    writeFileSync(join(outside, 'auth.ts'), 'export const secret = true;');
    let syncCalls = 0;
    let vectorizeCalls = 0;

    await expect(runAutoSyncOnce(project, { files: ['auth.ts'], source: 'runtime' }, {
      debounceMs: 1,
      dependencies: {
        sleep: async () => {
          rmSync(join(project, 'auth.ts'));
          mkdirSync(join(project, 'auth.ts'));
          symlinkSync(outside, join(project, 'auth.ts', 'link'), 'dir');
          rmSync(join(project, 'auth.ts'), { recursive: true, force: true });
          symlinkSync(join(outside, 'auth.ts'), join(project, 'auth.ts'));
        },
        syncCodeGraph: async () => { syncCalls += 1; },
        vectorize: async () => {
          vectorizeCalls += 1;
          return {
            projectPath: project,
            collectionPath: join(project, '.zincgraph', 'vectors'),
            fusionDbPath: join(project, '.zincgraph', 'fusion.sqlite'),
            filesFresh: 0,
            documentsWritten: 0,
            manifestWarnings: []
          };
        },
        readSnapshot: () => snapshot(project)
      }
    })).rejects.toThrow('symlink');

    expect(syncCalls).toBe(0);
    expect(vectorizeCalls).toBe(0);
    expect(manifest(project).getByFile('auth.ts')?.state).toBe('stale');
  });
});
