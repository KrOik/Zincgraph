import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FusionCompressor } from '../../src/compression/fusion-compressor.js';
import { CcrStore } from '../../src/compression/ccr-store.js';
import type { FusionNode } from '../../src/fusion/query-engine.js';

function makeFusionNode(overrides: Partial<FusionNode> = {}): FusionNode {
  return {
    nodeId: overrides.nodeId ?? 'node-1',
    filePath: overrides.filePath ?? 'src/test.ts',
    language: overrides.language ?? 'typescript',
    kind: overrides.kind ?? 'function',
    qualifiedName: overrides.qualifiedName ?? 'testFunction',
    contentHash: overrides.contentHash ?? 'abc123',
    score: overrides.score ?? 1.0,
    sources: overrides.sources ?? ['graph'],
    sourceScores: overrides.sourceScores ?? { graph: 1.0 },
    content: overrides.content ?? 'export function testFunction() { return 42; }'
  };
}

describe('FusionCompressor', () => {
  let tempDir: string;
  let compressor: FusionCompressor;
  let ccrStore: CcrStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'zincgraph-test-'));
    ccrStore = new CcrStore({ projectPath: tempDir });
    compressor = new FusionCompressor({ ccrStore });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('compresses large code content and stores in CCR', async () => {
    const largeContent = `export function processData() {\n${'  const step = compute();\n'.repeat(200)}}`;
    const nodes = [makeFusionNode({ content: largeContent, nodeId: 'large-fn' })];

    const result = await compressor.compress(nodes, { maxTokens: 50 });

    expect(result.compressedCandidates).toHaveLength(1);
    expect(result.ccrHashes.size).toBeGreaterThan(0);
    expect(result.tokensSaved).toBeGreaterThan(0);
    expect(result.compressionRatio).toBeGreaterThan(0);
  });

  test('does not compress when content is within budget', async () => {
    const shortNode = makeFusionNode({ content: 'short content', nodeId: 'short' });
    const result = await compressor.compress([shortNode], { maxTokens: 8000 });

    expect(result.compressedCandidates).toHaveLength(1);
    expect(result.ccrHashes.size).toBe(0);
    expect(result.tokensSaved).toBe(0);
  });

  test('retrieve returns original content from CCR', async () => {
    const largeContent = `function largeFunction() {\n${'  process(data);\n'.repeat(100)}}`;
    const nodes = [makeFusionNode({ content: largeContent, nodeId: 'retrieve-test' })];

    const result = await compressor.compress(nodes, { maxTokens: 20 });
    const hash = result.ccrHashes.get('retrieve-test');
    expect(hash).toBeTruthy();

    if (hash) {
      const retrieved = await compressor.retrieve(hash);
      expect(retrieved).toBe(largeContent);
    }
  });

  test('retrieve returns null for unknown hash', async () => {
    const result = await compressor.retrieve('nonexistent-hash');
    expect(result).toBeNull();
  });

  test('stats track compression operations', async () => {
    const stats0 = compressor.getStats();
    expect(stats0.totalCompressions).toBe(0);

    const largeContent = `function big() {\n${'  doWork();\n'.repeat(100)}}`;
    await compressor.compress([makeFusionNode({ content: largeContent })], { maxTokens: 10 });

    const stats1 = compressor.getStats();
    expect(stats1.totalCompressions).toBe(1);
    expect(stats1.totalTokensBefore).toBeGreaterThan(0);
  });

  test('disabled compression returns unchanged candidates', async () => {
    const largeContent = `function large() {\n${'  work();\n'.repeat(100)}}`;
    const nodes = [makeFusionNode({ content: largeContent })];

    const result = await compressor.compress(nodes, { maxTokens: 10, enabled: false });

    expect(result.compressedCandidates[0]?.content).toBe(largeContent);
    expect(result.ccrHashes.size).toBe(0);
  });

  test('off strategy returns unchanged candidates', async () => {
    const largeContent = `function large() {\n${'  work();\n'.repeat(100)}}`;
    const nodes = [makeFusionNode({ content: largeContent })];

    const result = await compressor.compress(nodes, { maxTokens: 10, strategy: 'off' });

    expect(result.compressedCandidates[0]?.content).toBe(largeContent);
  });

  test('compressed candidates include compression-info annotation', async () => {
    const largeContent = `export function processData() {\n${'  const step = compute();\n'.repeat(200)}}`;
    const nodes = [makeFusionNode({ content: largeContent, nodeId: 'annotated' })];

    const result = await compressor.compress(nodes, { maxTokens: 20 });

    if (result.ccrHashes.size > 0) {
      const compressed = result.compressedCandidates[0];
      const compressionAnnotation = compressed?.annotations?.find(
        (annotation) => annotation.type === 'compression-info'
      );
      expect(compressionAnnotation).toBeDefined();
      expect(compressionAnnotation?.evidence['__headroom_compressed']).toBe(true);
      expect(compressionAnnotation?.evidence['__headroom_hash']).toBeTruthy();
    }
  });

  test('handles multiple candidates with mixed sizes', async () => {
    const nodes = [
      makeFusionNode({ nodeId: 'small', content: 'small function' }),
      makeFusionNode({ nodeId: 'large', content: `function big() {\n${'  work();\n'.repeat(100)}}` }),
      makeFusionNode({ nodeId: 'medium', content: `function medium() {\n${'  process();\n'.repeat(30)}}` })
    ];

    const result = await compressor.compress(nodes, { maxTokens: 50 });

    expect(result.compressedCandidates).toHaveLength(3);
    const smallNode = result.compressedCandidates.find((n) => n.nodeId === 'small');
    expect(smallNode?.content).toBe('small function');
  });

  test('createFromProject factory creates working compressor', () => {
    const created = FusionCompressor.createFromProject(tempDir);
    const stats = created.getStats();
    expect(stats.totalCompressions).toBe(0);
  });
});
