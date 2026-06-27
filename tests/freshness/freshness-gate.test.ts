import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { FreshnessGate, getFreshnessSnapshot, summarizeFreshness } from '../../src/freshness/freshness-gate.js';
import { FusionStore } from '../../src/freshness/fusion-store.js';
import { VectorManifestStore } from '../../src/freshness/manifest.js';
import { DEFAULT_CHUNKER_VERSION } from '../../src/vector/chunker.js';

const tempProjects: string[] = [];
const profile = 'local-token-v1:64';
const manifestStores: VectorManifestStore[] = [];
const FRESHNESS_SQLITE_TEST_TIMEOUT_MS = 30_000;

function tempProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'zincgraph-freshness-gate-'));
  tempProjects.push(project);
  return project;
}

function createManifest(project: string): VectorManifestStore {
  const store = new VectorManifestStore(new FusionStore(project), profile);
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

describe('Phase 2 freshness gate', () => {
  test('summarizes fresh entries without warnings', () => {
    const snapshot = summarizeFreshness([
      { entryKey: 'a', filePath: 'src/a.ts', embeddingProfile: profile, chunkerVersion: 'v1', docIds: [], contentHash: 'h', state: 'fresh', updatedAt: 1 }
    ]);
    expect(snapshot.isFresh).toBe(true);
    expect(snapshot.warnings).toEqual([]);
  });

  test('reports stale, pending, and failed warnings', () => {
    const snapshot = summarizeFreshness([
      { entryKey: 'a', filePath: 'src/a.ts', embeddingProfile: profile, chunkerVersion: 'v1', docIds: [], contentHash: 'h', state: 'stale', updatedAt: 1 },
      { entryKey: 'b', filePath: 'src/b.ts', embeddingProfile: profile, chunkerVersion: 'v1', docIds: [], contentHash: 'h', state: 'pending', updatedAt: 1 },
      { entryKey: 'c', filePath: 'src/c.ts', embeddingProfile: profile, chunkerVersion: 'v1', docIds: [], contentHash: 'h', state: 'failed', updatedAt: 1 }
    ]);
    expect(snapshot.warnings).toContain('1 files have stale embeddings');
    expect(snapshot.warnings).toContain('1 files have pending embeddings');
    expect(snapshot.warnings).toContain('1 files failed embedding');
  });

  test('sync callback can restore review readiness', async () => {
    const project = tempProject();
    const manifest = createManifest(project);
    manifest.markStale('src/a.ts', 'h2');
    const gate = new FreshnessGate(project, profile);
    const result = await gate.ensureReady({
      sync: () => {
        manifest.markFresh('src/a.ts', 'h2', ['node-1']);
      }
    });
    expect(result.synced).toBe(true);
    expect(result.allowed).toBe(true);
    expect(getFreshnessSnapshot(project, profile).fresh).toBe(1);
  }, FRESHNESS_SQLITE_TEST_TIMEOUT_MS);

  test('current freshness ignores old v1 manifest entries after chunker bump', () => {
    const project = tempProject();
    const oldManifest = new VectorManifestStore(new FusionStore(project), profile, 'codegraph-node-v1');
    manifestStores.push(oldManifest);
    oldManifest.markFresh('src/a.ts', 'h1', ['old-doc']);
    const freshness = getFreshnessSnapshot(project, profile);
    expect(DEFAULT_CHUNKER_VERSION).not.toBe('codegraph-node-v1');
    expect(freshness.entries).toEqual([]);
    expect(freshness.fresh).toBe(0);
    expect(freshness.isFresh).toBe(true);
  });

  test('force bypasses stale blocking', async () => {
    const project = tempProject();
    const manifest = createManifest(project);
    manifest.markStale('src/a.ts', 'h2');
    const result = await new FreshnessGate(project, profile).ensureReady({ force: true });
    expect(result.forced).toBe(true);
    expect(result.allowed).toBe(true);
  });

  test('sync failure reports index-not-fresh warning', async () => {
    const project = tempProject();
    const manifest = createManifest(project);
    manifest.markStale('src/a.ts', 'h2');
    const result = await new FreshnessGate(project, profile).ensureReady({
      sync: () => {
        throw new Error('sync failed');
      }
    });
    expect(result.allowed).toBe(false);
    expect(result.warnings.join('\n')).toContain('index not fresh');
  });
});
