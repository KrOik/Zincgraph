import type { ManifestSummary, VectorManifestEntry } from './manifest.js';

export class SemanticStatus {
  constructor(private readonly entries: readonly VectorManifestEntry[]) {}

  summary(): ManifestSummary {
    const summary: ManifestSummary = { fresh: 0, pending: 0, stale: 0, failed: 0, total: 0 };
    for (const entry of this.entries) {
      summary[entry.state] += 1;
      summary.total += 1;
    }
    return summary;
  }

  getWarnings(): string[] {
    const summary = this.summary();
    const warnings: string[] = [];
    if (summary.stale > 0) {
      warnings.push(`${summary.stale} files have stale embeddings`);
    }
    if (summary.pending > 0) {
      warnings.push(`${summary.pending} files have pending embeddings`);
    }
    if (summary.failed > 0) {
      warnings.push(`${summary.failed} files failed embedding`);
    }
    return warnings;
  }
}
