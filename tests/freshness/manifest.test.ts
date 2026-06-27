import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { FusionStore } from '../../src/freshness/fusion-store.js';
import { VectorManifestStore } from '../../src/freshness/manifest.js';
import { SemanticStatus } from '../../src/freshness/semantic-status.js';

const tempProjects: string[] = [];
const manifestStores: VectorManifestStore[] = [];

function tempProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'zincgraph-manifest-test-'));
  tempProjects.push(project);
  return project;
}

function manifest(project: string): VectorManifestStore {
  const store = new VectorManifestStore(new FusionStore(project), 'local-token-v1:64');
  manifestStores.push(store);
  return store;
}

afterEach(() => {
  for (const store of manifestStores.splice(0)) {
    store.close();
  }
  for (const project of tempProjects.splice(0)) {
    rmSync(project, { force: true, recursive: true });
  }
});

describe('Phase 1 VectorManifestStore', () => {
  test('records pending then fresh state', () => {
    const store = manifest(tempProject());
    expect(store.markPending('src/a.ts', 'h1').state).toBe('pending');
    expect(store.markFresh('src/a.ts', 'h1', ['doc-1']).state).toBe('fresh');
    expect(store.getByFile('src/a.ts')?.docIds).toEqual(['doc-1']);
  });

  test('detects changed file hashes as stale', () => {
    const store = manifest(tempProject());
    store.markFresh('src/a.ts', 'h1', ['doc-1']);
    const stale = store.markChangedFilesStale([{ path: 'src/a.ts', contentHash: 'h2' }]);
    expect(stale).toHaveLength(1);
    expect(store.getByFile('src/a.ts')?.state).toBe('stale');
  });

  test('re-embedding moves stale through pending back to fresh', () => {
    const store = manifest(tempProject());
    store.markFresh('src/a.ts', 'h1', ['doc-1']);
    store.markStale('src/a.ts', 'h2');
    expect(store.markPending('src/a.ts', 'h2').state).toBe('pending');
    expect(store.markFresh('src/a.ts', 'h2', ['doc-2']).state).toBe('fresh');
    expect(store.getByFile('src/a.ts')?.contentHash).toBe('h2');
  }, 15_000);

  test('SemanticStatus generates warnings for stale and failed files', () => {
    const store = manifest(tempProject());
    store.markFresh('src/a.ts', 'h1', ['doc-1']);
    store.markStale('src/b.ts', 'h2');
    store.markFailed('src/c.ts', 'h3', 'boom');
    expect(new SemanticStatus(store.entries()).getWarnings()).toEqual([
      '1 files have stale embeddings',
      '1 files failed embedding'
    ]);
  });

  test('persists manifest data across store restart', () => {
    const project = tempProject();
    manifest(project).markFresh('src/a.ts', 'h1', ['doc-1']);
    expect(manifest(project).getByFile('src/a.ts')?.state).toBe('fresh');
  });

  test('summarizes all manifest states', () => {
    const store = manifest(tempProject());
    store.markFresh('src/a.ts', 'h1', ['doc-1']);
    store.markPending('src/b.ts', 'h2');
    store.markStale('src/c.ts', 'h3');
    store.markFailed('src/d.ts', 'h4', 'boom');
    expect(store.summary()).toEqual({ fresh: 1, pending: 1, stale: 1, failed: 1, total: 4 });
  });
});
