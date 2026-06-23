import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CrossTurnContextTracker,
  ReviewCompressor,
  findingSignature
} from '../../src/compression/review-compressor.js';
import { CcrStore } from '../../src/compression/ccr-store.js';
import { CompressionFeedbackLoop } from '../../src/compression/feedback-loop.js';
import type { GraphReviewFinding, GraphReviewFindingType } from '../../src/behavior/graph-review.js';

type FindingType = GraphReviewFindingType;

function finding(type: FindingType, filePath: string, name: string, extra: Record<string, unknown> = {}): GraphReviewFinding {
  return {
    type,
    severity: 'warning',
    message: `${type} ${name}`,
    evidence: { added: { name, filePath }, ...extra }
  } as GraphReviewFinding;
}

describe('ReviewCompressor (T6.2)', () => {
  let tempDir: string;
  let ccrStore: CcrStore;
  let compressor: ReviewCompressor;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'zincgraph-rc-'));
    ccrStore = new CcrStore({ projectPath: tempDir });
    compressor = new ReviewCompressor({ ccrStore });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('aggregates same-type same-file findings into one group with matchCount', async () => {
    const findings = [
      finding('same-signature', 'src/utils/date.ts', 'formatDateTime'),
      finding('same-signature', 'src/utils/date.ts', 'parseTimestamp'),
      finding('same-signature', 'src/utils/date.ts', 'formatDate')
    ];
    const result = await compressor.compress(findings);
    expect(result.aggregated).toHaveLength(1);
    expect(result.aggregated[0]?.matchCount).toBe(3);
    expect(result.aggregated[0]?.subjects).toEqual(['formatDateTime', 'parseTimestamp', 'formatDate']);
    expect(result.aggregated[0]?.summary).toContain('3 matches');
  });

  test('stores original findings in CCR and exposes a retrievable hash', async () => {
    const findings = [finding('yagni', 'src/api.ts', 'unusedHelper', { callerCount: 1 })];
    const result = await compressor.compress(findings);
    expect(result.ccrHash).toBeTruthy();
    const entry = ccrStore.get(result.ccrHash);
    expect(entry).not.toBeNull();
    const parsed = JSON.parse(entry!.content) as GraphReviewFinding[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.type).toBe('yagni');
  });

  test('compressed output is at least 30% smaller than the raw findings text', async () => {
    const findings: GraphReviewFinding[] = [];
    for (let i = 0; i < 10; i++) {
      findings.push(finding('same-signature', 'src/big.ts', `func${i}`));
    }
    const result = await compressor.compress(findings);
    expect(result.tokensSaved).toBeGreaterThan(0);
    expect(result.compressionRatio).toBeGreaterThan(0.3);
  });

  test('cross-turn tracker marks previously discussed groups', async () => {
    const tracker = new CrossTurnContextTracker();
    const compressorWithTracker = new ReviewCompressor({ ccrStore, tracker });
    const findings = [finding('dead-code', 'src/old.ts', 'legacyFn', { node: { qualifiedName: 'legacyFn', filePath: 'src/old.ts' } })];

    const first = await compressorWithTracker.compress(findings);
    expect(first.aggregated[0]?.previouslyDiscussed).toBe(false);
    expect(tracker.size).toBe(1);

    const second = await compressorWithTracker.compress(findings);
    expect(second.aggregated[0]?.previouslyDiscussed).toBe(true);
  });

  test('createFromProject persists discussed findings across compressor instances', async () => {
    const findings = [finding('dead-code', 'src/old.ts', 'legacyFn', { node: { qualifiedName: 'legacyFn', filePath: 'src/old.ts' } })];
    const first = ReviewCompressor.createFromProject(tempDir);
    const firstResult = await first.compress(findings);
    expect(firstResult.aggregated[0]?.previouslyDiscussed).toBe(false);

    const second = ReviewCompressor.createFromProject(tempDir);
    const secondResult = await second.compress(findings);
    expect(secondResult.aggregated[0]?.previouslyDiscussed).toBe(true);
  }, 15000);

  test('queryContext scopes previously discussed findings', async () => {
    const findings = [finding('dead-code', 'src/old.ts', 'legacyFn', { node: { qualifiedName: 'legacyFn', filePath: 'src/old.ts' } })];
    const compressor = ReviewCompressor.createFromProject(tempDir);

    const first = await compressor.compress(findings, { queryContext: 'diff-a' });
    expect(first.aggregated[0]?.previouslyDiscussed).toBe(false);

    const second = await compressor.compress(findings, { queryContext: 'diff-b' });
    expect(second.aggregated[0]?.previouslyDiscussed).toBe(false);

    const third = await compressor.compress(findings, { queryContext: 'diff-a' });
    expect(third.aggregated[0]?.previouslyDiscussed).toBe(true);
  }, 15000);

  test('skipDiscussed option omits previously discussed groups', async () => {
    const tracker = new CrossTurnContextTracker();
    const compressorWithTracker = new ReviewCompressor({ ccrStore, tracker });
    const findings = [finding('cycle-dependency', 'src/mod.ts', 'a->b->a', { cycle: ['a', 'b', 'a'] })];

    await compressorWithTracker.compress(findings);
    const second = await compressorWithTracker.compress(findings, { skipDiscussed: true });
    expect(second.aggregated).toHaveLength(0);
  });

  test('format produces CCR retrieve markers and compression stats', async () => {
    const findings = [
      finding('redundant-import', 'src/api.ts', 'lodash', { redundantImport: { moduleName: 'lodash', via: 'utils' } }),
      finding('yagni', 'src/api.ts', 'overkill', { callerCount: 0 })
    ];
    const result = await compressor.compress(findings);
    const lines = compressor.format(result);
    expect(lines.some((l) => l.includes('zincgraph_retrieve'))).toBe(true);
    expect(lines.some((l) => l.includes('Compression:'))).toBe(true);
  });

  test('records compression events to feedback loop when provided', async () => {
    const loop = new CompressionFeedbackLoop({ store: new (await import('../../src/compression/feedback-store.js')).FeedbackStore({ projectPath: tempDir }) });
    const compressorWithFeedback = new ReviewCompressor({ ccrStore, feedbackLoop: loop });
    const findings = [finding('dead-code', 'src/old.ts', 'legacyFn', { node: { qualifiedName: 'legacyFn', filePath: 'src/old.ts' } })];
    await compressorWithFeedback.compress(findings);
    const summary = loop.summarize();
    expect(summary.totalCompressions).toBeGreaterThan(0);
    expect(summary.byKind['dead-code']?.compressed).toBeGreaterThan(0);
  }, 15000);

  test('findingSignature is stable for identical findings', () => {
    const f = finding('same-signature', 'src/a.ts', 'foo');
    expect(findingSignature(f)).toBe(findingSignature(f));
    expect(findingSignature(f)).toBe('same-signature:src/a.ts:foo');
  });
});
