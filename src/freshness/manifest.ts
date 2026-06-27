import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { FusionStore, type StoredManifestEntry } from './fusion-store.js';
import { SemanticStatus } from './semantic-status.js';
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

export interface ManifestSnapshot extends ManifestSummary {
  isFresh: boolean;
  warnings: string[];
  entries: VectorManifestEntry[];
}

export { DEFAULT_CHUNKER_VERSION };

interface PersistedManifestState {
  version: 1;
  embeddingProfile: string;
  chunkerVersion: string;
  entries: VectorManifestEntry[];
  summary: ManifestSummary;
  warnings: string[];
  isFresh: boolean;
}

export class VectorManifestStore {
  private stateCache: PersistedManifestState | null = null;
  private closed = false;

  constructor(
    private readonly fusionStore: FusionStore,
    private readonly embeddingProfile: string,
    private readonly chunkerVersion = DEFAULT_CHUNKER_VERSION
  ) {}

  static open(projectPath: string, embeddingProfile: string, chunkerVersion = DEFAULT_CHUNKER_VERSION): VectorManifestStore {
    return new VectorManifestStore(new FusionStore(projectPath), embeddingProfile, chunkerVersion);
  }

  markPending(filePath: string, contentHash: string): VectorManifestEntry {
    return this.writeEntries([{ filePath, contentHash, docIds: [], state: 'pending' }])[0]!;
  }

  markFresh(filePath: string, contentHash: string, docIds: readonly string[]): VectorManifestEntry {
    return this.writeEntries([{ filePath, contentHash, docIds: [...docIds], state: 'fresh' }])[0]!;
  }

  markStale(filePath: string, contentHash: string): VectorManifestEntry {
    const existing = this.getByFile(filePath);
    return this.writeEntries([{
      filePath,
      contentHash,
      docIds: existing?.docIds ?? [],
      state: 'stale'
    }])[0]!;
  }

  markFailed(filePath: string, contentHash: string, error: string): VectorManifestEntry {
    const existing = this.getByFile(filePath);
    return this.writeEntries([{
      filePath,
      contentHash,
      docIds: existing?.docIds ?? [],
      state: 'failed',
      error
    }])[0]!;
  }

  markPendingFiles(files: readonly ManifestFileRecord[]): VectorManifestEntry[] {
    return this.writeEntries(files.map((file) => ({
      filePath: file.path,
      contentHash: file.contentHash,
      docIds: [],
      state: 'pending'
    })));
  }

  markFreshFiles(files: ReadonlyArray<ManifestFileRecord & { docIds: readonly string[] }>): VectorManifestEntry[] {
    return this.writeEntries(files.map((file) => ({
      filePath: file.path,
      contentHash: file.contentHash,
      docIds: [...file.docIds],
      state: 'fresh'
    })));
  }

  deleteFiles(filePaths: readonly string[]): void {
    if (filePaths.length === 0) {
      return;
    }
    this.deleteEntries(filePaths);
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
    const entry = this.getByFileFromState(filePath);
    return entry ? cloneEntry(entry) : null;
  }

  entries(): VectorManifestEntry[] {
    return this.loadState().entries.map(cloneEntry);
  }

  summary(): ManifestSummary {
    return { ...this.loadState().summary };
  }

  snapshot(): ManifestSnapshot {
    const state = this.loadState();
    return {
      ...state.summary,
      isFresh: state.isFresh,
      warnings: [...state.warnings],
      entries: state.entries.map(cloneEntry)
    };
  }

  private writeEntries(inputs: ReadonlyArray<{
    filePath: string;
    contentHash: string;
    docIds: string[];
    state: ManifestState;
    error?: string;
  }>): VectorManifestEntry[] {
    const state = this.loadState();
    const byKey = new Map(state.entries.map((entry) => [entry.entryKey, entry]));
    const entries = inputs.map((input) => ({
      entryKey: this.entryKey(input.filePath),
      filePath: input.filePath,
      embeddingProfile: this.embeddingProfile,
      chunkerVersion: this.chunkerVersion,
      docIds: [...input.docIds],
      contentHash: input.contentHash,
      state: input.state,
      updatedAt: Date.now(),
      ...(input.error ? { error: input.error } : {})
    }));
    for (const entry of entries) {
      byKey.set(entry.entryKey, entry);
    }
    this.persistState([...byKey.values()]);
    return entries;
  }

  private deleteEntries(filePaths: readonly string[]): void {
    const state = this.loadState();
    const remove = new Set(filePaths);
    const nextEntries = state.entries.filter((entry) => !remove.has(entry.filePath));
    if (nextEntries.length === state.entries.length) {
      return;
    }
    this.persistState(nextEntries);
  }

  private getByFileFromState(filePath: string, state = this.loadState()): VectorManifestEntry | null {
    return state.entries.find((entry) => entry.filePath === filePath) ?? null;
  }

  private loadState(): PersistedManifestState {
    if (this.stateCache) {
      return this.stateCache;
    }
    const cachePath = this.cachePath();
    if (!existsSync(cachePath)) {
      const migrated = this.loadLegacyState();
      this.stateCache = migrated ?? emptyState(this.embeddingProfile, this.chunkerVersion);
      return this.stateCache;
    }
    try {
      const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as Partial<PersistedManifestState>;
      if (
        parsed.version !== 1 ||
        parsed.embeddingProfile !== this.embeddingProfile ||
        parsed.chunkerVersion !== this.chunkerVersion ||
        !Array.isArray(parsed.entries)
      ) {
        const migrated = this.loadLegacyState();
        this.stateCache = migrated ?? emptyState(this.embeddingProfile, this.chunkerVersion);
        return this.stateCache;
      }
      const entries = parsed.entries.filter(isManifestEntry).map(cloneEntry);
      this.stateCache = buildState(this.embeddingProfile, this.chunkerVersion, entries);
      return this.stateCache;
    } catch {
      const migrated = this.loadLegacyState();
      this.stateCache = migrated ?? emptyState(this.embeddingProfile, this.chunkerVersion);
      return this.stateCache;
    }
  }

  private persistState(entries: readonly VectorManifestEntry[]): void {
    const nextState = buildState(this.embeddingProfile, this.chunkerVersion, entries);
    const cachePath = this.cachePath();
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(nextState, null, 2));
    this.stateCache = nextState;
  }

  private cachePath(): string {
    return join(
      dirname(this.fusionStore.dbPath),
      'manifests',
      `manifest-${scopeKey(this.embeddingProfile, this.chunkerVersion)}.json`
    );
  }

  private entryKey(filePath: string): string {
    return createHash('sha256')
      .update(`${filePath}\0${this.embeddingProfile}\0${this.chunkerVersion}`)
      .digest('hex');
  }

  private loadLegacyState(): PersistedManifestState | null {
    const legacyEntries = this.fusionStore
      .listManifestEntries(this.embeddingProfile, this.chunkerVersion)
      .filter((entry): entry is StoredManifestEntry => isStoredManifestEntry(entry))
      .map((entry) => cloneEntry(entry.json as VectorManifestEntry));
    if (legacyEntries.length === 0) {
      return null;
    }
    const nextState = buildState(this.embeddingProfile, this.chunkerVersion, legacyEntries);
    const cachePath = this.cachePath();
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(nextState, null, 2));
    return nextState;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.fusionStore.close();
  }
}

function buildState(
  embeddingProfile: string,
  chunkerVersion: string,
  entries: readonly VectorManifestEntry[]
): PersistedManifestState {
  const normalizedEntries = entries
    .map(cloneEntry)
    .sort((left, right) => left.filePath.localeCompare(right.filePath));
  const semanticStatus = new SemanticStatus(normalizedEntries);
  const summary = semanticStatus.summary();
  const warnings = semanticStatus.getWarnings();
  return {
    version: 1,
    embeddingProfile,
    chunkerVersion,
    entries: normalizedEntries,
    summary,
    warnings,
    isFresh: summary.pending === 0 && summary.stale === 0 && summary.failed === 0
  };
}

function emptyState(embeddingProfile: string, chunkerVersion: string): PersistedManifestState {
  return buildState(embeddingProfile, chunkerVersion, []);
}

function cloneEntry(entry: VectorManifestEntry): VectorManifestEntry {
  return {
    ...entry,
    docIds: [...entry.docIds]
  };
}

function scopeKey(embeddingProfile: string, chunkerVersion: string): string {
  return createHash('sha256')
    .update(`${embeddingProfile}\0${chunkerVersion}`)
    .digest('hex')
    .slice(0, 16);
}

function isManifestEntry(value: unknown): value is VectorManifestEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<VectorManifestEntry>;
  return typeof candidate.entryKey === 'string' &&
    typeof candidate.filePath === 'string' &&
    typeof candidate.embeddingProfile === 'string' &&
    typeof candidate.chunkerVersion === 'string' &&
    Array.isArray(candidate.docIds) &&
    candidate.docIds.every((docId) => typeof docId === 'string') &&
    typeof candidate.contentHash === 'string' &&
    (candidate.state === 'fresh' || candidate.state === 'pending' || candidate.state === 'stale' || candidate.state === 'failed') &&
    typeof candidate.updatedAt === 'number' &&
    (candidate.error === undefined || typeof candidate.error === 'string');
}

function isStoredManifestEntry(value: unknown): value is StoredManifestEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<StoredManifestEntry>;
  return typeof candidate.entryKey === 'string' &&
    typeof candidate.filePath === 'string' &&
    typeof candidate.embeddingProfile === 'string' &&
    typeof candidate.chunkerVersion === 'string' &&
    isManifestEntry(candidate.json);
}
