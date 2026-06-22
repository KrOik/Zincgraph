import { createHash } from 'node:crypto';

import { FusionStore, type StoredManifestEntry } from './fusion-store.js';
import { DEFAULT_CHUNKER_VERSION } from '../vector/chunker.js';

export type ManifestState = 'fresh' | 'pending' | 'stale' | 'failed';

export interface VectorManifestEntry {
  entryKey: string;
  filePath: string;
  embeddingProfile: string;
  chunkerVersion: string;
  docIds: string[];
  contentHash: string;
  state: ManifestState;
  error?: string;
  updatedAt: number;
}

export interface ManifestFileRecord {
  path: string;
  contentHash: string;
}

export interface ManifestSummary {
  fresh: number;
  pending: number;
  stale: number;
  failed: number;
  total: number;
}

export { DEFAULT_CHUNKER_VERSION };

export class VectorManifestStore {
  constructor(
    private readonly fusionStore: FusionStore,
    private readonly embeddingProfile: string,
    private readonly chunkerVersion = DEFAULT_CHUNKER_VERSION
  ) {}

  static open(projectPath: string, embeddingProfile: string, chunkerVersion = DEFAULT_CHUNKER_VERSION): VectorManifestStore {
    return new VectorManifestStore(new FusionStore(projectPath), embeddingProfile, chunkerVersion);
  }

  markPending(filePath: string, contentHash: string): VectorManifestEntry {
    return this.writeEntry({ filePath, contentHash, docIds: [], state: 'pending' });
  }

  markFresh(filePath: string, contentHash: string, docIds: readonly string[]): VectorManifestEntry {
    return this.writeEntry({ filePath, contentHash, docIds: [...docIds], state: 'fresh' });
  }

  markStale(filePath: string, contentHash: string): VectorManifestEntry {
    const existing = this.getByFile(filePath);
    return this.writeEntry({
      filePath,
      contentHash,
      docIds: existing?.docIds ?? [],
      state: 'stale'
    });
  }

  markFailed(filePath: string, contentHash: string, error: string): VectorManifestEntry {
    const existing = this.getByFile(filePath);
    return this.writeEntry({
      filePath,
      contentHash,
      docIds: existing?.docIds ?? [],
      state: 'failed',
      error
    });
  }

  markChangedFilesStale(files: readonly ManifestFileRecord[]): VectorManifestEntry[] {
    const changed: VectorManifestEntry[] = [];
    for (const file of files) {
      const entry = this.getByFile(file.path);
      if (entry && entry.contentHash !== file.contentHash) {
        changed.push(this.markStale(file.path, file.contentHash));
      }
    }
    return changed;
  }

  getByFile(filePath: string): VectorManifestEntry | null {
    const entry = this.fusionStore.getManifestEntry(this.entryKey(filePath));
    return entry ? fromStoredManifest(entry) : null;
  }

  entries(): VectorManifestEntry[] {
    return this.fusionStore
      .listManifestEntries()
      .filter((entry) => entry.embeddingProfile === this.embeddingProfile && entry.chunkerVersion === this.chunkerVersion)
      .map(fromStoredManifest);
  }

  summary(): ManifestSummary {
    const summary: ManifestSummary = { fresh: 0, pending: 0, stale: 0, failed: 0, total: 0 };
    for (const entry of this.entries()) {
      summary[entry.state] += 1;
      summary.total += 1;
    }
    return summary;
  }

  private writeEntry(input: {
    filePath: string;
    contentHash: string;
    docIds: string[];
    state: ManifestState;
    error?: string;
  }): VectorManifestEntry {
    const entry: VectorManifestEntry = {
      entryKey: this.entryKey(input.filePath),
      filePath: input.filePath,
      embeddingProfile: this.embeddingProfile,
      chunkerVersion: this.chunkerVersion,
      docIds: input.docIds,
      contentHash: input.contentHash,
      state: input.state,
      updatedAt: Date.now(),
      ...(input.error ? { error: input.error } : {})
    };
    this.fusionStore.upsertManifestEntries([toStoredManifest(entry)]);
    return entry;
  }

  private entryKey(filePath: string): string {
    return createHash('sha256')
      .update(`${filePath}\0${this.embeddingProfile}\0${this.chunkerVersion}`)
      .digest('hex');
  }
}

function toStoredManifest(entry: VectorManifestEntry): StoredManifestEntry {
  return {
    entryKey: entry.entryKey,
    filePath: entry.filePath,
    embeddingProfile: entry.embeddingProfile,
    chunkerVersion: entry.chunkerVersion,
    json: entry
  };
}

function fromStoredManifest(entry: StoredManifestEntry): VectorManifestEntry {
  return entry.json as VectorManifestEntry;
}
