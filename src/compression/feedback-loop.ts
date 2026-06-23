import {
  FeedbackStore,
  type CompressionEvent,
  type FeedbackSource,
  type RetrievalEvent
} from './feedback-store.js';

export interface FeedbackSummary {
  totalCompressions: number;
  totalRetrievals: number;
  retrievalRate: number;
  bySource: Record<string, { compressed: number; retrieved: number }>;
  byContentType: Record<string, { compressed: number; retrieved: number }>;
  byKind: Record<string, { compressed: number; retrieved: number }>;
  neverRetrievedCategories: string[];
  frequentlyRetrievedCategories: string[];
}

export interface CompressionFeedbackLoopOptions {
  store: FeedbackStore;
  frequentRetrievalThreshold?: number;
  neverRetrievalThreshold?: number;
}

const DEFAULT_FREQUENT_THRESHOLD = 0.5;
const DEFAULT_NEVER_THRESHOLD = 0.05;

export class CompressionFeedbackLoop {
  readonly store: FeedbackStore;
  private readonly frequentRetrievalThreshold: number;
  private readonly neverRetrievalThreshold: number;

  constructor(options: CompressionFeedbackLoopOptions) {
    this.store = options.store;
    this.frequentRetrievalThreshold = options.frequentRetrievalThreshold ?? DEFAULT_FREQUENT_THRESHOLD;
    this.neverRetrievalThreshold = options.neverRetrievalThreshold ?? DEFAULT_NEVER_THRESHOLD;
  }

  static createFromProject(projectPath: string): CompressionFeedbackLoop {
    return new CompressionFeedbackLoop({ store: new FeedbackStore({ projectPath }) });
  }

  recordRetrieval(event: RetrievalEvent): void {
    this.store.recordRetrieval(event);
  }

  recordCompression(event: CompressionEvent): void {
    this.store.recordCompression(event);
  }

  summarize(): FeedbackSummary {
    const aggregate = this.store.aggregate();
    const bySource: Record<string, { compressed: number; retrieved: number }> = {};
    const byContentType: Record<string, { compressed: number; retrieved: number }> = {};
    const byKind: Record<string, { compressed: number; retrieved: number }> = {};

    const accumulate = (
      bucket: Record<string, { compressed: number; retrieved: number }>,
      key: string,
      field: 'compressed' | 'retrieved',
      count: number
    ): void => {
      const entry = bucket[key] ?? { compressed: 0, retrieved: 0 };
      entry[field] += count;
      bucket[key] = entry;
    };

    for (const row of aggregate.compressions) {
      accumulate(bySource, row.source, 'compressed', row.count);
      accumulate(byContentType, row.contentType, 'compressed', row.count);
      accumulate(byKind, row.kind, 'compressed', row.count);
    }
    for (const row of aggregate.retrievals) {
      accumulate(bySource, row.source, 'retrieved', row.count);
      accumulate(byContentType, row.contentType, 'retrieved', row.count);
      accumulate(byKind, row.kind, 'retrieved', row.count);
    }

    const totalCompressions = aggregate.compressions.reduce((sum, row) => sum + row.count, 0);
    const totalRetrievals = aggregate.retrievals.reduce((sum, row) => sum + row.count, 0);
    const retrievalRate = totalCompressions > 0 ? totalRetrievals / totalCompressions : 0;

    const allCategories = new Set<string>([
      ...Object.keys(bySource).map((key) => `source:${key}`),
      ...Object.keys(byContentType).map((key) => `contentType:${key}`),
      ...Object.keys(byKind).map((key) => `kind:${key}`)
    ]);

    const neverRetrievedCategories: string[] = [];
    const frequentlyRetrievedCategories: string[] = [];
    for (const category of allCategories) {
      const sep = category.indexOf(':');
      if (sep < 0) {
        continue;
      }
      const dimension = category.slice(0, sep);
      const value = category.slice(sep + 1);
      const bucket = dimension === 'source' ? bySource : dimension === 'contentType' ? byContentType : byKind;
      const entry = bucket[value];
      if (!entry || entry.compressed === 0) {
        continue;
      }
      const rate = entry.retrieved / entry.compressed;
      if (rate <= this.neverRetrievalThreshold && entry.retrieved === 0) {
        neverRetrievedCategories.push(category);
      } else if (rate >= this.frequentRetrievalThreshold) {
        frequentlyRetrievedCategories.push(category);
      }
    }

    return {
      totalCompressions,
      totalRetrievals,
      retrievalRate,
      bySource,
      byContentType,
      byKind,
      neverRetrievedCategories: neverRetrievedCategories.sort(),
      frequentlyRetrievedCategories: frequentlyRetrievedCategories.sort()
    };
  }

  recentRetrievals(since?: number): RetrievalEvent[] {
    return this.store.listRetrievalEvents(since);
  }

  recentCompressions(since?: number): CompressionEvent[] {
    return this.store.listCompressionEvents(since);
  }
}

export function recordRetrievalFeedback(loop: CompressionFeedbackLoop, hash: string, queryContext = ''): void {
  const compression = loop.store.findCompressionByHash(hash);
  loop.recordRetrieval({
    hash,
    nodeId: compression?.nodeId ?? 'unknown',
    source: compression?.source ?? 'graph',
    contentType: compression?.contentType ?? 'text',
    kind: compression?.kind ?? 'unknown',
    retrievedAt: Date.now(),
    queryContext
  });
}

export type { FeedbackSource };
