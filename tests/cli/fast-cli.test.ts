import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test, vi } from 'vitest';

const semanticAugmentMock = vi.hoisted(() => {
  const query = vi.fn(async () => [
    {
      id: 'zg-compression',
      nodeId: 'compression-node',
      filePath: 'src/compression/ranking-adjuster.ts',
      language: 'typescript',
      kind: 'function',
      qualifiedName: 'src/compression/ranking-adjuster.ts::createFeedbackAwarePolicy',
      contentHash: 'compression-hash',
      chunkerVersion: 'codegraph-node-v3-semantic-bridge',
      score: 0.95
    },
    {
      id: 'zg-noise',
      nodeId: 'noise-node',
      filePath: 'src/behavior/dedup-check.ts',
      language: 'typescript',
      kind: 'function',
      qualifiedName: 'src/behavior/dedup-check.ts::createVectorDedupSearch',
      contentHash: 'noise-hash',
      chunkerVersion: 'codegraph-node-v3-semantic-bridge',
      score: 0.9
    }
  ]);
  const destroy = vi.fn();
  const openCollection = vi.fn(() => ({
    query,
    destroy
  }));
  return { query, destroy, openCollection };
});

vi.mock('../../src/vector/collection-manager.js', () => ({
  openCollection: semanticAugmentMock.openCollection
}));

import {
  buildRegistryFastCapsule,
  formatFastAffected,
  formatFastGraphNavigation,
  formatFastImpact,
  main,
  readFastSemanticAugments,
  selectRankedNodes,
  toFusionNode,
  type Snapshot
} from '../../src/fast-cli.js';

function snapshot(options: { includeStructuralContext?: boolean } = {}): Snapshot {
  return {
    projectPath: '/repo',
    files: [
      { path: 'src/alpha-service.ts', contentHash: 'a', language: 'typescript' },
      { path: 'src/beta-adapter.ts', contentHash: 'b', language: 'typescript' },
      { path: 'tests/alpha-service.test.ts', contentHash: 't1', language: 'typescript' },
      { path: 'tests/unrelated.test.ts', contentHash: 't2', language: 'typescript' }
    ],
    nodes: [
      {
        id: 'alpha',
        kind: 'function',
        name: 'alphaService',
        qualifiedName: 'alphaService',
        filePath: 'src/alpha-service.ts',
        language: 'typescript',
        signature: 'function alphaService()',
        sourceSnippet: 'export function alphaService() { return betaAdapter(); }',
        calls: ['betaAdapter']
      },
      ...(options.includeStructuralContext ? [{
        id: 'alpha-context',
        kind: 'class',
        name: 'AlphaServiceRuntime',
        qualifiedName: 'AlphaServiceRuntime',
        filePath: 'src/alpha-service.ts',
        language: 'typescript',
        signature: 'class AlphaServiceRuntime',
        sourceSnippet: 'export class AlphaServiceRuntime { start() { return alphaService(); } }',
        calls: ['alphaService']
      }] : []),
      {
        id: 'beta',
        kind: 'function',
        name: 'betaAdapter',
        qualifiedName: 'betaAdapter',
        filePath: 'src/beta-adapter.ts',
        language: 'typescript',
        signature: 'function betaAdapter()',
        sourceSnippet: 'export function betaAdapter() { return true; }',
        calls: []
      },
      {
        id: 'alpha-test',
        kind: 'function',
        name: 'tests alphaService',
        qualifiedName: 'alphaService test',
        filePath: 'tests/alpha-service.test.ts',
        language: 'typescript',
        signature: 'test alphaService behavior',
        sourceSnippet: 'import { alphaService } from "../src/alpha-service"; test("alpha service", () => alphaService());',
        calls: ['alphaService']
      },
      {
        id: 'unrelated-test',
        kind: 'function',
        name: 'unrelatedSpec',
        qualifiedName: 'unrelatedSpec',
        filePath: 'tests/unrelated.test.ts',
        language: 'typescript',
        signature: 'test unrelated behavior',
        sourceSnippet: 'test("unrelated", () => true);',
        calls: []
      }
    ]
  };
}

describe('fast CLI generic snapshot behavior', () => {
  test('ranks nodes from query/token overlap without benchmark task hints', () => {
    const nodes = selectRankedNodes(snapshot().nodes, 'alpha service', 2);

    expect(nodes.map((node) => node.filePath)).toEqual([
      'src/alpha-service.ts',
      'tests/alpha-service.test.ts'
    ]);
  });

  test('broad queries include structural context from files that already matched', () => {
    const fixture = snapshot({ includeStructuralContext: true });
    const node = fixture.nodes.find((item) => item.id === 'alpha')!;
    const fusionNode = toFusionNode(node, fixture.nodes);

    expect(fusionNode.content).toContain('context AlphaServiceRuntime');
    expect(fusionNode.content).not.toContain('AutoSyncPipeline');
  });

  test('impact output is derived from snapshot callers and callees', () => {
    const output = formatFastImpact(snapshot(), { project: '/repo', query: 'alpha service', topk: 10, maxTokens: 8000 });

    expect(output).toContain('seed function alphaService src/alpha-service.ts');
    expect(output).toContain('callee function betaAdapter src/beta-adapter.ts');
    expect(output).toContain('caller function alphaService test tests/alpha-service.test.ts');
    expect(output).not.toContain('callers ');
    expect(output).not.toContain('callees ');
    expect(output).not.toContain('calls ');
    expect(output).not.toContain('runAutoSyncOnce');
    expect(output).not.toContain('AutoSyncPipeline');
  });

  test('callers and callees commands use the same generic graph index', () => {
    const callers = formatFastGraphNavigation(snapshot(), 'callers', { project: '/repo', query: 'beta adapter', topk: 10, maxTokens: 8000 });
    const callees = formatFastGraphNavigation(snapshot(), 'callees', { project: '/repo', query: 'alpha service', topk: 10, maxTokens: 8000 });

    expect(callers).toContain('caller function alphaService src/alpha-service.ts');
    expect(callees).toContain('callee function betaAdapter src/beta-adapter.ts');
    expect(callers).not.toContain('AutoSyncPipeline');
    expect(callees).not.toContain('runAutoSyncOnce');
  });

  test('graph navigation surfaces barrel-file exports when a module re-exports the seed symbol', () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'zincgraph-fast-cli-barrel-'));
    try {
      const indexPath = join(projectPath, 'src/index.ts');
      mkdirSync(dirname(indexPath), { recursive: true });
      writeFileSync(indexPath, [
        'export { runAutoSyncOnce } from "../freshness/auto-sync.js";',
        'export { vectorizeProject } from "../vector/code-to-vectors.js";'
      ].join('\n'));

      const output = formatFastGraphNavigation(snapshot(), 'node', {
        project: projectPath,
        query: 'runAutoSyncOnce',
        topk: 10,
        maxTokens: 8000
      });

      expect(output).toContain('file src/index.ts');
      expect(output).toContain('runAutoSyncOnce');
      expect(output).toContain('vectorizeProject');
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  test('affected tests are scored from changed file symbols and test source text', () => {
    const output = formatFastAffected(snapshot(), { project: '/repo', query: 'src/alpha-service.ts', topk: 10, maxTokens: 8000 });

    expect(output).toContain('tests/alpha-service.test.ts');
    expect(output).not.toContain('tests/unrelated.test.ts');
    expect(output).not.toContain('tests/cli.test.ts');
  });

  test('registry-fast freshness queries read a single manifest sidecar directly', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'zincgraph-fast-cli-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      for (const filePath of [
        'src/freshness/auto-sync.ts',
        'src/freshness/manifest.ts',
        'src/freshness/freshness-gate.ts',
        'src/vector/code-to-vectors.ts'
      ]) {
        const absolutePath = join(projectPath, filePath);
        mkdirSync(dirname(absolutePath), { recursive: true });
        writeFileSync(absolutePath, 'export {};');
      }

      const embeddingProfile = 'local-token-v1:64';
      const chunkerVersion = 'codegraph-node-v3-semantic-bridge';
      const zincgraphPath = join(projectPath, '.zincgraph');
      const manifestPath = join(
        zincgraphPath,
        'manifests',
        `manifest-${createHash('sha256').update(`${embeddingProfile}\0${chunkerVersion}`).digest('hex').slice(0, 16)}.json`
      );

      mkdirSync(dirname(manifestPath), { recursive: true });
      writeFileSync(manifestPath, JSON.stringify({
        version: 1,
        embeddingProfile,
        chunkerVersion,
        entries: [],
        summary: {
          fresh: 7,
          pending: 1,
          stale: 2,
          failed: 0,
          total: 10
        },
        warnings: ['stale files present'],
        isFresh: false
      }, null, 2));

      await main([
        'node',
        'fast-cli',
        'explore',
        'manifest',
        'stale',
        'pending',
        'fresh',
        'freshness',
        '-p',
        projectPath,
        '--topk',
        '10'
      ]);

      expect(log).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(payload.route).toBe('registry-fast');
      expect(payload.freshness).toEqual({
        fresh: 7,
        pending: 1,
        stale: 2,
        failed: 0,
        total: 10,
        isFresh: false,
        warnings: [
          expect.stringContaining('using manifest sidecar'),
          'embedding metadata cache missing while manifest sidecar exists',
          'stale files present'
        ]
      });
    } finally {
      log.mockRestore();
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  test('registry fast capsule exposes exact MCP tool symbols', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'zincgraph-fast-cli-registry-'));
    try {
      const registryPath = join(projectPath, 'src/mcp/tool-registry.ts');
      mkdirSync(dirname(registryPath), { recursive: true });
      writeFileSync(registryPath, 'export const placeholder = true;');

      const capsule = await buildRegistryFastCapsule({
        project: projectPath,
        query: 'zincgraph semantic search tool registry',
        topk: 10,
        maxTokens: 8000
      });

      expect(capsule).not.toBeNull();
      const payload = capsule as { route?: string; nodes?: Array<Record<string, unknown>>; evidence?: string };
      expect(payload.route).toBe('registry-fast');
      expect(payload.nodes?.map((node) => node.qualifiedName)).toEqual(expect.arrayContaining([
        'zincgraph_semantic_search',
        'zincgraph_dedup_check'
      ]));
      expect(payload.evidence).toContain('tool registry');
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  test('registry fast path does not hijack behavior review queries', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'zincgraph-fast-cli-behavior-'));
    try {
      const registryPath = join(projectPath, 'src/mcp/tool-registry.ts');
      mkdirSync(dirname(registryPath), { recursive: true });
      writeFileSync(registryPath, 'export const placeholder = true;');

      const capsule = await buildRegistryFastCapsule({
        project: projectPath,
        query: 'semantic dedup graph review',
        topk: 10,
        maxTokens: 8000
      });

      expect(capsule).toBeNull();
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  test('semantic augment results honor structured path filters', async () => {
    const nodes = [
      {
        id: 'compression-node',
        kind: 'function',
        name: 'createFeedbackAwarePolicy',
        qualifiedName: 'src/compression/ranking-adjuster.ts::createFeedbackAwarePolicy',
        filePath: 'src/compression/ranking-adjuster.ts',
        language: 'typescript',
        signature: 'function createFeedbackAwarePolicy(): DynamicFusionPolicy',
        calls: []
      },
      {
        id: 'noise-node',
        kind: 'function',
        name: 'createVectorDedupSearch',
        qualifiedName: 'src/behavior/dedup-check.ts::createVectorDedupSearch',
        filePath: 'src/behavior/dedup-check.ts',
        language: 'typescript',
        signature: 'function createVectorDedupSearch(): DedupCheckerDependencies["search"]',
        calls: []
      }
    ] satisfies Snapshot['nodes'];

    const result = await readFastSemanticAugments(
      '/repo',
      'which code decides priority ordering when search results are mixed from multiple sources path:src/compression',
      5,
      nodes
    );

    expect(result.vectorHits).toBe(1);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.filePath).toBe('src/compression/ranking-adjuster.ts');
    expect(semanticAugmentMock.openCollection).toHaveBeenCalledTimes(1);
    expect(semanticAugmentMock.query).toHaveBeenCalledTimes(1);
  });

  test('semantic-routing bridge fast path can surface intent-router without vector search', async () => {
    semanticAugmentMock.openCollection.mockClear();
    semanticAugmentMock.query.mockClear();

    const nodes = [
      {
        id: 'compression-node',
        kind: 'function',
        name: 'createFeedbackAwarePolicy',
        qualifiedName: 'src/compression/ranking-adjuster.ts::createFeedbackAwarePolicy',
        filePath: 'src/compression/ranking-adjuster.ts',
        language: 'typescript',
        signature: 'function createFeedbackAwarePolicy(): DynamicFusionPolicy',
        calls: []
      },
      {
        id: 'router-node',
        kind: 'function',
        name: 'parseFusionQuery',
        qualifiedName: 'src/fusion/intent-router.ts::parseFusionQuery',
        filePath: 'src/fusion/intent-router.ts',
        language: 'typescript',
        signature: 'function parseFusionQuery(query: string): ParsedFusionQuery',
        docstring: 'Decide priority ordering when search results are mixed from multiple sources.',
        sourceSnippet: 'export function parseFusionQuery(query: string): ParsedFusionQuery { return routeParsedQuery(query); }',
        calls: ['routeParsedQuery', 'queryTerms']
      }
    ] satisfies Snapshot['nodes'];

    const result = await readFastSemanticAugments(
      '/repo',
      'which code decides priority ordering when search results are mixed from multiple sources path:src/compression',
      5,
      nodes,
      { skipVectorSearch: true }
    );

    expect(result.vectorHits).toBe(0);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.filePath).toBe('src/fusion/intent-router.ts');
    expect(result.nodes[0]?.qualifiedName).toContain('parseFusionQuery');
    expect(result.nodes[0]?.content).toContain('priority ordering');
    expect(semanticAugmentMock.openCollection).not.toHaveBeenCalled();
    expect(semanticAugmentMock.query).not.toHaveBeenCalled();
  });
});
