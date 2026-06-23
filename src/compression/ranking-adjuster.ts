import { FUSION_RANKING_POLICY, type FusionSource } from '../fusion/query-engine.js';
import type { QueryRoute } from '../fusion/intent-router.js';
import type { FeedbackSummary } from './feedback-loop.js';
import { CompressionFeedbackLoop } from './feedback-loop.js';
import { FeedbackStore, type RankingAdjustmentRecord } from './feedback-store.js';

export type CompressionAggressiveness = 'off' | 'conservative' | 'normal' | 'aggressive';

export interface RankingAdjustments {
  routeWeightOverrides?: Partial<Record<QueryRoute, Partial<Record<FusionSource, number>>>>;
  fusionBoostOverrides?: Partial<{ graphExactMultiplier: number; callProximityMultiplier: number }>;
  kindBoosts?: Record<string, number>;
  compressionAggressiveness?: Record<string, CompressionAggressiveness>;
}

export interface DynamicFusionPolicy {
  base: typeof FUSION_RANKING_POLICY;
  adjustments: RankingAdjustments;
}

export interface RankingAdjusterOptions {
  store: FeedbackStore;
  routeWeightDelta?: number;
  kindBoost?: number;
}

const DEFAULT_ROUTE_WEIGHT_DELTA = 0.1;
const DEFAULT_KIND_BOOST = 0.2;

export class RankingAdjuster {
  readonly store: FeedbackStore;
  private readonly routeWeightDelta: number;
  private readonly kindBoost: number;

  constructor(options: RankingAdjusterOptions) {
    this.store = options.store;
    this.routeWeightDelta = options.routeWeightDelta ?? DEFAULT_ROUTE_WEIGHT_DELTA;
    this.kindBoost = options.kindBoost ?? DEFAULT_KIND_BOOST;
  }

  static createFromProject(projectPath: string): RankingAdjuster {
    return new RankingAdjuster({ store: new FeedbackStore({ projectPath }) });
  }

  buildPolicy(summary: FeedbackSummary): DynamicFusionPolicy {
    const adjustments: RankingAdjustments = {};
    const compression: Record<string, CompressionAggressiveness> = {};
    const fusionBoostOverrides: NonNullable<RankingAdjustments['fusionBoostOverrides']> = {};

    // Frequently retrieved graph results -> boost graph-first route weights + conservative compression.
    const graphRetrievalRate = summary.bySource.graph?.compressed
      ? summary.bySource.graph.retrieved / summary.bySource.graph.compressed
      : 0;
    if (graphRetrievalRate > 0.6) {
      adjustments.routeWeightOverrides = {
        'graph-first': { graph: (FUSION_RANKING_POLICY.routeWeights['graph-first'].graph ?? 1) + this.routeWeightDelta },
        'graph-first-filter': { graph: (FUSION_RANKING_POLICY.routeWeights['graph-first-filter'].graph ?? 1) + this.routeWeightDelta }
      };
      fusionBoostOverrides.graphExactMultiplier = FUSION_RANKING_POLICY.fusionBoosts.graphExactMultiplier + 0.05;
      fusionBoostOverrides.callProximityMultiplier = FUSION_RANKING_POLICY.fusionBoosts.callProximityMultiplier + 0.03;
      compression.graph = 'conservative';
    }

    // Never-retrieved FTS results -> more aggressive compression.
    const ftsCompressed = summary.bySource.fts?.compressed ?? 0;
    const ftsRetrievalRate = ftsCompressed > 0 ? (summary.bySource.fts?.retrieved ?? 0) / ftsCompressed : 0;
    if (ftsCompressed > 0 && ftsRetrievalRate < 0.05) {
      compression.fts = 'aggressive';
    }

    // Frequently retrieved kinds -> ranking boost.
    const kindBoosts: Record<string, number> = {};
    for (const [kind, entry] of Object.entries(summary.byKind)) {
      if (entry.compressed === 0) {
        continue;
      }
      const rate = entry.retrieved / entry.compressed;
      if (rate > 0.5) {
        kindBoosts[kind] = this.kindBoost;
      }
    }
    if (Object.keys(kindBoosts).length > 0) {
      adjustments.kindBoosts = kindBoosts;
    }

    // High code retrieval rate -> conservative code compression.
    const codeCompressed = summary.byContentType.code?.compressed ?? 0;
    const codeRetrievalRate = codeCompressed > 0 ? (summary.byContentType.code?.retrieved ?? 0) / codeCompressed : 0;
    if (codeRetrievalRate > 0.7) {
      compression.code = 'conservative';
    }

    // Low JSON retrieval rate -> aggressive JSON compression.
    const jsonCompressed = summary.byContentType.json?.compressed ?? 0;
    const jsonRetrievalRate = jsonCompressed > 0 ? (summary.byContentType.json?.retrieved ?? 0) / jsonCompressed : 0;
    if (jsonCompressed > 0 && jsonRetrievalRate < 0.1) {
      compression.json = 'aggressive';
    }

    if (Object.keys(compression).length > 0) {
      adjustments.compressionAggressiveness = compression;
    }
    if (Object.keys(fusionBoostOverrides).length > 0) {
      adjustments.fusionBoostOverrides = fusionBoostOverrides;
    }

    return { base: FUSION_RANKING_POLICY, adjustments };
  }

  recordAdjustments(policy: DynamicFusionPolicy, summary: FeedbackSummary, reason: string): RankingAdjustmentRecord[] {
    const records: RankingAdjustmentRecord[] = [];

    if (policy.adjustments.routeWeightOverrides) {
      for (const [route, overrides] of Object.entries(policy.adjustments.routeWeightOverrides)) {
        if (!overrides) {
          continue;
        }
        for (const [source, value] of Object.entries(overrides)) {
          if (value === undefined) {
            continue;
          }
          const oldValue = String(FUSION_RANKING_POLICY.routeWeights[route as QueryRoute]?.[source as FusionSource] ?? '');
          const record: RankingAdjustmentRecord = {
            adjustedAt: Date.now(),
            adjustmentType: 'route-weight',
            field: `routeWeights.${route}.${source}`,
            oldValue,
            newValue: String(value),
            reason
          };
          this.store.recordAdjustment(record);
          records.push(record);
        }
      }
    }

    if (policy.adjustments.fusionBoostOverrides) {
      for (const [field, value] of Object.entries(policy.adjustments.fusionBoostOverrides)) {
        if (value === undefined) {
          continue;
        }
        const oldValue = String(FUSION_RANKING_POLICY.fusionBoosts[field as keyof typeof FUSION_RANKING_POLICY.fusionBoosts] ?? '');
        const record: RankingAdjustmentRecord = {
          adjustedAt: Date.now(),
          adjustmentType: 'fusion-boost',
          field: `fusionBoosts.${field}`,
          oldValue,
          newValue: String(value),
          reason
        };
        this.store.recordAdjustment(record);
        records.push(record);
      }
    }

    if (policy.adjustments.kindBoosts) {
      for (const [kind, value] of Object.entries(policy.adjustments.kindBoosts)) {
        const record: RankingAdjustmentRecord = {
          adjustedAt: Date.now(),
          adjustmentType: 'kind-boost',
          field: `kindBoosts.${kind}`,
          oldValue: '0',
          newValue: String(value),
          reason: `kind:${kind} retrievalRate>0.5 (${summary.byKind[kind]?.retrieved ?? 0}/${summary.byKind[kind]?.compressed ?? 0})`
        };
        this.store.recordAdjustment(record);
        records.push(record);
      }
    }

    if (policy.adjustments.compressionAggressiveness) {
      for (const [category, level] of Object.entries(policy.adjustments.compressionAggressiveness)) {
        const record: RankingAdjustmentRecord = {
          adjustedAt: Date.now(),
          adjustmentType: 'compression-aggressiveness',
          field: `compressionAggressiveness.${category}`,
          oldValue: 'normal',
          newValue: String(level),
          reason
        };
        this.store.recordAdjustment(record);
        records.push(record);
      }
    }

    return records;
  }
}

export function createFeedbackAwarePolicy(projectPath: string): DynamicFusionPolicy {
  const feedbackLoop = CompressionFeedbackLoop.createFromProject(projectPath);
  const adjuster = new RankingAdjuster({ store: feedbackLoop.store });
  return adjuster.buildPolicy(feedbackLoop.summarize());
}
