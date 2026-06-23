import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifySessionLog,
  createLearnIntegrationAdapter,
  type SessionLog
} from '../../src/compression/learn-integration.js';

function log(toolName: string, output: string, input = '', error = ''): SessionLog {
  return {
    recordedAt: Date.now(),
    toolName,
    input,
    output,
    durationMs: 25,
    error
  };
}

describe('learn integration', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'zincgraph-learn-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('classifies the four phase-6 failure patterns', () => {
    expect(classifySessionLog(log('zincgraph_review', 'false positive: already handled finding ignored'))).toContain('review-false-positive');
    expect(classifySessionLog(log('zincgraph_retrieve', 'missing detail after over-aggressive compression', '{"hash":"abc"}'))).toContain('compression-over-aggressive');
    expect(classifySessionLog(log('zincgraph_explore', '{"nodes":[]}', 'token validation'))).toContain('empty-search');
    expect(classifySessionLog(log('zincgraph_review', 'warning: stale embeddings for src/auth.ts'))).toContain('stale-index');
  });

  test('classifies structured semantic-search logs without false stale-index hits', () => {
    const structuredOutput = JSON.stringify({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            query: 'token validation',
            nodes: [],
            documents: [],
            freshness: { isFresh: true },
            policy: { nativeFts: false }
          })
        }
      ],
      isError: false
    });
    const types = classifySessionLog(log('zincgraph_semantic_search', structuredOutput, 'token validation'));
    expect(types).toContain('empty-search');
    expect(types).not.toContain('stale-index');
  });

  test('analyzeFailures and generateRules emit AGENTS-compatible marker blocks', () => {
    const adapter = createLearnIntegrationAdapter({ minOccurrences: 1 });
    const result = adapter.analyzeFailures([
      log('zincgraph_review', 'ignored finding false positive'),
      log('zincgraph_review', 'ignored finding false positive'),
      log('zincgraph_retrieve', 'too aggressive compression caused missing context', '{"hash":"abc"}'),
      log('zincgraph_explore', '{"nodes":[]}', 'token validation'),
      log('zincgraph_review', 'warning: stale embeddings for src/auth.ts')
    ]);

    expect(result.patterns.map((pattern) => pattern.type).sort()).toEqual([
      'compression-over-aggressive',
      'empty-search',
      'review-false-positive',
      'stale-index'
    ]);

    const text = adapter.generateRules(result, 'agents-md');
    expect(text).toContain('zincgraph:learn:START');
    expect(text).toContain('review-false-positive');
    expect(text).toContain('compression-over-aggressive');
    expect(text).toContain('empty-search');
    expect(text).toContain('stale-index');
  });

  test('generateRules json output is structured and parseable', () => {
    const adapter = createLearnIntegrationAdapter({ minOccurrences: 1 });
    const result = adapter.analyzeFailures([log('zincgraph_review', 'ignored finding false positive')]);
    const json = adapter.generateRules(result, 'json');
    const parsed = JSON.parse(json) as typeof result;
    expect(parsed.patterns).toHaveLength(1);
    expect(parsed.patterns[0]?.type).toBe('review-false-positive');
  });

  test('applyRules is dry-run safe and writes marker blocks when enabled', () => {
    const adapter = createLearnIntegrationAdapter({ minOccurrences: 1 });
    const result = adapter.analyzeFailures([log('zincgraph_review', 'ignored finding false positive')]);
    const text = adapter.generateRules(result, 'agents-md');
    const target = join(tempDir, 'AGENTS.md');

    adapter.applyRules(text, target, { dryRun: true });
    expect(existsSync(target)).toBe(false);

    adapter.applyRules(text, target);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('review-false-positive');
  });

  test('minOccurrences filters low-frequency patterns', () => {
    const adapter = createLearnIntegrationAdapter({ minOccurrences: 3 });
    const result = adapter.analyzeFailures([
      log('zincgraph_review', 'ignored finding false positive'),
      log('zincgraph_retrieve', 'too aggressive compression caused missing context', '{"hash":"abc"}')
    ]);
    expect(result.patterns).toHaveLength(0);
  });
});
