import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CompressionFeedbackLoop, type FeedbackSummary } from '../../src/compression/feedback-loop.js';
import { FeedbackStore } from '../../src/compression/feedback-store.js';
import { RankingAdjuster } from '../../src/compression/ranking-adjuster.js';
import { FUSION_RANKING_POLICY } from '../../src/fusion/query-engine.js';

function seedFrequentGraph(loop: CompressionFeedbackLoop): void {
  for (let i = 0; i < 4; i++) {
    loop.recordCompression({ hash: `g${i}`, nodeId: `n${i}`, source: 'graph', contentType: 'json', kind: 'function', compressedAt: i });
    loop.recordRetrieval({ hash: `g${i}`, nodeId: `n${i}`, source: 'graph', contentType: 'json', kind: 'function', retrievedAt: 10 + i, queryContext: 'q' });
  }
  // fts compressions that are never retrieved
  for (let i = 0; i < 4; i++) {
    loop.recordCompression({ hash: `f${i}`, nodeId: `nf${i}`, source: 'fts', contentType: 'text', kind: 'class', compressedAt: i });
  }
}

describe('CompressionFeedbackLoop (T6.1)', () => {
  let tempDir: string;
  let store: FeedbackStore;
  let loop: CompressionFeedbackLoop;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'zincgraph-fb-'));
    store = new FeedbackStore({ projectPath: tempDir });
    loop = new CompressionFeedbackLoop({ store });
  });

  afterEach(async () => {
    loop.close();
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  test('records and lists retrieval events', () => {
    loop.recordRetrieval({ hash: 'h1', nodeId: 'n1', source: 'graph', contentType: 'json', kind: 'function', retrievedAt: 5, queryContext: 'auth' });
    const events = loop.recentRetrievals();
    expect(events).toHaveLength(1);
    expect(events[0]?.hash).toBe('h1');
    expect(events[0]?.queryContext).toBe('auth');
  });

  test('records and lists compression events', () => {
    loop.recordCompression({ hash: 'c1', nodeId: 'n1', source: 'vector', contentType: 'code', kind: 'method', compressedAt: 7 });
    const events = loop.recentCompressions();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('method');
  });

  test('summarize aggregates by source, contentType, and kind', () => {
    seedFrequentGraph(loop);
    const summary: FeedbackSummary = loop.summarize();
    expect(summary.totalCompressions).toBe(8);
    expect(summary.totalRetrievals).toBe(4);
    expect(summary.retrievalRate).toBeCloseTo(0.5, 5);
    expect(summary.bySource.graph).toEqual({ compressed: 4, retrieved: 4 });
    expect(summary.bySource.fts).toEqual({ compressed: 4, retrieved: 0 });
    expect(summary.byContentType.json).toEqual({ compressed: 4, retrieved: 4 });
    expect(summary.byKind.function).toEqual({ compressed: 4, retrieved: 4 });
  }, 15000);

  test('neverRetrievedCategories flags zero-retrieval buckets', () => {
    seedFrequentGraph(loop);
    const summary = loop.summarize();
    expect(summary.neverRetrievedCategories).toContain('source:fts');
    expect(summary.neverRetrievedCategories).toContain('contentType:text');
    expect(summary.neverRetrievedCategories).toContain('kind:class');
  }, 15000);

  test('frequentlyRetrievedCategories flags high-retrieval buckets', () => {
    seedFrequentGraph(loop);
    const summary = loop.summarize();
    expect(summary.frequentlyRetrievedCategories).toContain('source:graph');
    expect(summary.frequentlyRetrievedCategories).toContain('kind:function');
  }, 15000);

  test('RankingAdjuster boosts graph-first route weight when graph retrieval rate > 0.6', () => {
    seedFrequentGraph(loop);
    const summary = loop.summarize();
    const adjuster = new RankingAdjuster({ store });
    const policy = adjuster.buildPolicy(summary);
    expect(policy.adjustments.routeWeightOverrides?.['graph-first']?.graph).toBe(
      (FUSION_RANKING_POLICY.routeWeights['graph-first'].graph ?? 1) + 0.1
    );
    expect(policy.adjustments.compressionAggressiveness?.graph).toBe('conservative');
  }, 15000);

  test('RankingAdjuster marks never-retrieved fts as aggressive compression', () => {
    seedFrequentGraph(loop);
    const summary = loop.summarize();
    const adjuster = new RankingAdjuster({ store });
    const policy = adjuster.buildPolicy(summary);
    expect(policy.adjustments.compressionAggressiveness?.fts).toBe('aggressive');
  }, 15000);

  test('RankingAdjuster records adjustment rows with before/after values and reason', () => {
    seedFrequentGraph(loop);
    const summary = loop.summarize();
    const adjuster = new RankingAdjuster({ store });
    const policy = adjuster.buildPolicy(summary);
    const records = adjuster.recordAdjustments(policy, summary, 'graph retrieval rate > 0.6');
    expect(records.length).toBeGreaterThan(0);
    const stored = store.listAdjustments();
    expect(stored).toHaveLength(records.length);
    const routeRecord = stored.find((r) => r.adjustmentType === 'route-weight');
    expect(routeRecord?.oldValue).toBe(String(FUSION_RANKING_POLICY.routeWeights['graph-first'].graph));
    expect(routeRecord?.newValue).toBe(String(policy.adjustments.routeWeightOverrides?.['graph-first']?.graph));
    expect(routeRecord?.reason).toBe('graph retrieval rate > 0.6');
  }, 15000);

  test('findCompressionByHash recovers metadata for retrieval feedback', () => {
    store.recordCompression({ hash: 'lookup', nodeId: 'node-x', source: 'vector', contentType: 'code', kind: 'method', compressedAt: 1 });
    const found = store.findCompressionByHash('lookup');
    expect(found?.nodeId).toBe('node-x');
    expect(found?.source).toBe('vector');
    expect(found?.contentType).toBe('code');
    expect(found?.kind).toBe('method');
    expect(store.findCompressionByHash('missing')).toBeNull();
  });

  test('empty store yields zero-rate summary with no adjustments', () => {
    const summary = loop.summarize();
    expect(summary.totalCompressions).toBe(0);
    expect(summary.totalRetrievals).toBe(0);
    expect(summary.retrievalRate).toBe(0);
    expect(summary.neverRetrievedCategories).toHaveLength(0);
    expect(summary.frequentlyRetrievedCategories).toHaveLength(0);
    const adjuster = new RankingAdjuster({ store });
    const policy = adjuster.buildPolicy(summary);
    expect(policy.adjustments.routeWeightOverrides).toBeUndefined();
    expect(policy.adjustments.compressionAggressiveness).toBeUndefined();
  });

  test('createfromProject factory builds an independent feedback loop', () => {
    const factoryLoop = CompressionFeedbackLoop.createFromProject(tempDir);
    try {
      factoryLoop.recordCompression({ hash: 'f', nodeId: 'n', source: 'graph', contentType: 'json', kind: 'function', compressedAt: 1 });
      const summary = factoryLoop.summarize();
      expect(summary.totalCompressions).toBe(1);
    } finally {
      factoryLoop.close();
    }
  });
});
