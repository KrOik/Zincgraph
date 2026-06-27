import { FusionStore } from './fusion-store.js';
import { SemanticStatus } from './semantic-status.js';
import { VectorManifestStore, type ManifestSummary, type VectorManifestEntry } from './manifest.js';
import { defaultLocalEmbeddingProfile, resolveActiveEmbedding, type ActiveEmbeddingConfigInput } from '../vector/embedding/index.js';

export interface FreshnessSnapshot extends ManifestSummary {
  isFresh: boolean;
  warnings: string[];
  entries: VectorManifestEntry[];
}

export interface FreshnessGateOptions {
  force?: boolean;
  sync?: () => void | Promise<void>;
}

export interface FreshnessGateResult {
  allowed: boolean;
  forced: boolean;
  synced: boolean;
  freshness: FreshnessSnapshot;
  warnings: string[];
}

export const DEFAULT_FRESHNESS_EMBEDDING_PROFILE = defaultLocalEmbeddingProfile();

export function summarizeFreshness(entries: readonly VectorManifestEntry[]): FreshnessSnapshot {
  const semanticStatus = new SemanticStatus(entries);
  const summary = semanticStatus.summary();
  const warnings = semanticStatus.getWarnings();
  return {
    ...summary,
    isFresh: summary.pending === 0 && summary.stale === 0 && summary.failed === 0,
    warnings,
    entries: [...entries]
  };
}

export function getFreshnessSnapshot(
  projectPath: string,
  embedding: string | ActiveEmbeddingConfigInput = DEFAULT_FRESHNESS_EMBEDDING_PROFILE
): FreshnessSnapshot {
  const resolved = typeof embedding === 'string'
    ? { profile: embedding, chunkerVersion: undefined }
    : resolveActiveEmbedding(projectPath, embedding);
  const store = new FusionStore(projectPath);
  try {
    const manifest = new VectorManifestStore(store, resolved.profile, resolved.chunkerVersion);
    return summarizeFreshness(manifest.entries());
  } finally {
    store.close();
  }
}

export class FreshnessGate {
  private readonly embedding: string | ActiveEmbeddingConfigInput;

  constructor(
    private readonly projectPath: string,
    embedding: string | ActiveEmbeddingConfigInput = DEFAULT_FRESHNESS_EMBEDDING_PROFILE
  ) {
    this.embedding = embedding;
  }

  status(): FreshnessSnapshot {
    return getFreshnessSnapshot(this.projectPath, this.embedding);
  }

  async ensureReady(options: FreshnessGateOptions = {}): Promise<FreshnessGateResult> {
    const initial = this.status();
    if (options.force) {
      return {
        allowed: true,
        forced: true,
        synced: false,
        freshness: initial,
        warnings: initial.warnings
      };
    }
    if (initial.isFresh) {
      return {
        allowed: true,
        forced: false,
        synced: false,
        freshness: initial,
        warnings: initial.warnings
      };
    }

    if (options.sync) {
      try {
        await options.sync();
      } catch (error) {
        return blocked(initial, true, `index not fresh: ${error instanceof Error ? error.message : String(error)}`);
      }
      const afterSync = this.status();
      if (afterSync.isFresh) {
        return {
          allowed: true,
          forced: false,
          synced: true,
          freshness: afterSync,
          warnings: afterSync.warnings
        };
      }
      return blocked(afterSync, true, 'index not fresh after sync');
    }

    return blocked(initial, false, 'index not fresh');
  }
}

function blocked(freshness: FreshnessSnapshot, synced: boolean, warning: string): FreshnessGateResult {
  return {
    allowed: false,
    forced: false,
    synced,
    freshness,
    warnings: [...freshness.warnings, warning]
  };
}
