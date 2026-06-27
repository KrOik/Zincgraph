import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test, vi } from 'vitest';

import { FUSION_RANKING_POLICY, TopoSemanticQueryEngine, compareFusionNodes, routeWeight, zvecFilterFor } from '../../src/fusion/query-engine.js';
import type { FusionNode } from '../../src/fusion/query-engine.js';
import type { FusionCompressionAdapter } from '../../src/compression/fusion-compressor.js';
import type { FreshnessSnapshot } from '../../src/freshness/freshness-gate.js';
import { FusionStore } from '../../src/freshness/fusion-store.js';
import type { CodeGraphSnapshot } from '../../src/vector/code-to-vectors.js';
import type { VectorSearchResult } from '../../src/vector/zvec-adapter.js';
import { DEFAULT_CHUNKER_VERSION } from '../../src/vector/chunker.js';

const snapshot: CodeGraphSnapshot = {
  projectPath: '/tmp/project',
  files: [
    { path: 'src/auth.ts', contentHash: 'hash-auth', language: 'typescript' },
    { path: 'src/token-service.ts', contentHash: 'hash-service', language: 'typescript' }
  ],
  nodes: [
    {
      id: 'node-validate',
      kind: 'function',
      name: 'validateToken',
      qualifiedName: 'src/auth.ts::validateToken',
      filePath: 'src/auth.ts',
      language: 'typescript',
      signature: 'function validateToken(token: string): boolean',
      docstring: 'Token validation for bearer credentials',
      calls: ['decodeJwt']
    },
    {
      id: 'node-class',
      kind: 'class',
      name: 'TokenService',
      qualifiedName: 'src/token-service.ts::TokenService',
      filePath: 'src/token-service.ts',
      language: 'typescript',
      signature: 'class TokenService',
      docstring: 'Coordinates validation workflows',
      calls: []
    },
    {
      id: 'node-import',
      kind: 'function',
      name: 'handleImportType',
      qualifiedName: 'src/auth.ts::handleImportType',
      filePath: 'src/auth.ts',
      language: 'typescript',
      signature: 'function handleImportType(): void',
      docstring: 'Handles import type statements',
      calls: []
    }
  ]
};

const vectorResults: VectorSearchResult[] = [
  {
    id: 'zg-node-validate',
    nodeId: 'node-validate',
    filePath: 'src/auth.ts',
    language: 'typescript',
    kind: 'function',
    qualifiedName: 'src/auth.ts::validateToken',
    contentHash: 'hash-auth',
    chunkerVersion: DEFAULT_CHUNKER_VERSION,
    score: 0.9
  },
  {
    id: 'zg-node-class',
    nodeId: 'node-class',
    filePath: 'src/token-service.ts',
    language: 'typescript',
    kind: 'class',
    qualifiedName: 'src/token-service.ts::TokenService',
    contentHash: 'hash-service',
    chunkerVersion: DEFAULT_CHUNKER_VERSION,
    score: 0.5
  }
];

const storedDocuments = [
  {
    id: 'node-validate',
    nodeId: 'node-validate',
    filePath: 'src/auth.ts',
    embeddingProfile: 'local-token-v1:64',
    chunkerVersion: DEFAULT_CHUNKER_VERSION,
    json: {
      id: 'node-validate',
      nodeId: 'node-validate',
      filePath: 'src/auth.ts',
      language: 'typescript',
      kind: 'function',
      qualifiedName: 'src/auth.ts::validateToken',
      content: 'function validateToken(token: string): boolean\nToken validation for bearer credentials\ncalls decodeJwt',
      contentHash: 'hash-auth',
      chunkerVersion: DEFAULT_CHUNKER_VERSION,
      tokens: ['function', 'validate', 'token', 'validation', 'bearer', 'credential'],
      contentSparse: {},
      embedding: []
    }
  },
  {
    id: 'node-class',
    nodeId: 'node-class',
    filePath: 'src/token-service.ts',
    embeddingProfile: 'local-token-v1:64',
    chunkerVersion: DEFAULT_CHUNKER_VERSION,
    json: {
      id: 'node-class',
      nodeId: 'node-class',
      filePath: 'src/token-service.ts',
      language: 'typescript',
      kind: 'class',
      qualifiedName: 'src/token-service.ts::TokenService',
      content: 'class TokenService\nCoordinates validation workflows',
      contentHash: 'hash-service',
      chunkerVersion: DEFAULT_CHUNKER_VERSION,
      tokens: ['class', 'token', 'service', 'validation'],
      contentSparse: {},
      embedding: []
    }
  }
];

function freshness(overrides: Partial<FreshnessSnapshot> = {}): FreshnessSnapshot {
  return {
    fresh: 2,
    pending: 0,
    stale: 0,
    failed: 0,
    total: 2,
    isFresh: true,
    warnings: [],
    entries: [
      { entryKey: 'a', filePath: 'src/auth.ts', embeddingProfile: 'local-token-v1:64', chunkerVersion: 'v1', docIds: ['node-validate'], contentHash: 'hash-auth', state: 'fresh', updatedAt: 1 },
      { entryKey: 'b', filePath: 'src/token-service.ts', embeddingProfile: 'local-token-v1:64', chunkerVersion: 'v1', docIds: ['node-class'], contentHash: 'hash-service', state: 'fresh', updatedAt: 1 }
    ],
    ...overrides
  };
}

function engine(freshnessSnapshot = freshness()): TopoSemanticQueryEngine {
  return new TopoSemanticQueryEngine('/tmp/project', {
    dependencies: {
      readSnapshot: () => snapshot,
      vectorSearch: async () => vectorResults,
      listVectorDocuments: () => storedDocuments,
      readFreshness: () => freshnessSnapshot
    }
  });
}

function seedStoredDocuments(projectPath: string): void {
  const store = new FusionStore(projectPath);
  try {
    store.upsertVectorDocuments(storedDocuments);
  } finally {
    store.close();
  }
}

describe('Phase 2 TopoSemanticQueryEngine', () => {
  test('returns graph, vector, and fts evidence for token validation', async () => {
    const capsule = await engine().query('token validation', { topk: 5 });
    const validate = capsule.nodes.find((node) => node.nodeId === 'node-validate');
    expect(validate?.sources).toEqual(expect.arrayContaining(['graph', 'vector', 'fts']));
    expect(capsule.freshness.fresh).toBe(2);
  });

  test('deduplicates repeated node hits and boosts combined evidence', async () => {
    const capsule = await engine().query('token validation', { topk: 5 });
    expect(capsule.nodes.filter((node) => node.nodeId === 'node-validate')).toHaveLength(1);
    const validate = capsule.nodes.find((node) => node.nodeId === 'node-validate');
    const service = capsule.nodes.find((node) => node.nodeId === 'node-class');
    expect(validate && service ? validate.score > service.score : false).toBe(true);
  });

  test('applies dynamic policy boosts to later explore results', async () => {
    const boosted = engine();
    boosted.setDynamicPolicy({
      base: FUSION_RANKING_POLICY,
      adjustments: {
        kindBoosts: { class: 20 }
      }
    });

    const capsule = await boosted.query('token validation', { topk: 5 });
    expect(capsule.nodes[0]?.nodeId).toBe('node-class');
  });

  test('invokes the compression adapter when compressResults is provided', async () => {
    let calls = 0;
    const compressionAdapter: FusionCompressionAdapter = {
      compress: async (candidates) => {
        calls += 1;
        return {
          compressedCandidates: candidates.map((candidate) => ({ ...candidate, content: `${candidate.content} [compressed]` })),
          ccrHashes: new Map<string, string>(),
          tokensSaved: 1,
          compressionRatio: 0.5
        };
      },
      retrieve: async () => null,
      getStats: () => ({
        totalCompressions: 0,
        totalTokensBefore: 0,
        totalTokensAfter: 0,
        totalTokensSaved: 0,
        averageCompressionRatio: 0,
        retrievalCount: 0
      })
    };
    const compressionEngine = new TopoSemanticQueryEngine('/tmp/project', {
      dependencies: {
        readSnapshot: () => snapshot,
        vectorSearch: async () => vectorResults,
        listVectorDocuments: () => storedDocuments,
        readFreshness: () => freshness(),
        compressResults: compressionAdapter
      }
    });

    const capsule = await compressionEngine.query('token validation', { topk: 5 });
    expect(calls).toBe(1);
    expect(capsule.nodes.length).toBeGreaterThan(0);
    expect(capsule.nodes.every((node) => node.content.includes('[compressed]'))).toBe(true);
    expect(capsule.documents).toHaveLength(0);
  });

  test('enforces kind filters', async () => {
    const capsule = await engine().query('kind:function import type', { topk: 10 });
    expect(capsule.nodes.length).toBeGreaterThan(0);
    expect(capsule.nodes.every((node) => node.kind === 'function')).toBe(true);
  });

  test('includes freshness warnings and marks stale candidates', async () => {
    const staleFreshness = freshness({
      fresh: 1,
      stale: 1,
      isFresh: false,
      warnings: ['1 files have stale embeddings'],
      entries: [
        { entryKey: 'a', filePath: 'src/auth.ts', embeddingProfile: 'local-token-v1:64', chunkerVersion: 'v1', docIds: ['node-validate'], contentHash: 'hash-auth-2', state: 'stale', updatedAt: 1 },
        { entryKey: 'b', filePath: 'src/token-service.ts', embeddingProfile: 'local-token-v1:64', chunkerVersion: 'v1', docIds: ['node-class'], contentHash: 'hash-service', state: 'fresh', updatedAt: 1 }
      ]
    });
    const capsule = await engine(staleFreshness).query('token validation', { topk: 5 });
    expect(capsule.warnings).toContain('1 files have stale embeddings');
    expect(capsule.nodes.find((node) => node.nodeId === 'node-validate')?.freshnessState).toBe('stale');
  });

  test('reports route and context blocks', async () => {
    const capsule = await engine().query('similar to token validation', { topk: 5, maxTokens: 200 });
    expect(capsule.route).toBe('vector-first');
    expect(capsule.context.blocks.length).toBeGreaterThan(0);
  });

  test('expands priority ordering queries before vector search and routing', async () => {
    let receivedVectorText = '';
    let receivedVectorMode: string | undefined;
    const semanticEngine = new TopoSemanticQueryEngine('/tmp/project', {
      dependencies: {
        readSnapshot: () => snapshot,
        vectorSearch: async (_project, text, _topk, _filters, mode) => {
          receivedVectorText = text;
          receivedVectorMode = mode;
          return vectorResults;
        },
        listVectorDocuments: () => storedDocuments,
        readFreshness: () => freshness()
      }
    });

    const capsule = await semanticEngine.query('which code decides priority ordering when search results are mixed from multiple sources', { topk: 5 });
    expect(capsule.intent).toBe('semantic-ranking');
    expect(capsule.route).toBe('vector-first');
    expect(receivedVectorText).toContain('ranking');
    expect(receivedVectorText).toContain('parse');
    expect(receivedVectorText).toContain('query');
    expect(receivedVectorText).toContain('router');
    expect(receivedVectorMode).toBe('hybrid');
  });

  test('semantic-ranking queries with path filters can bridge to out-of-path router code', async () => {
    const bridgeSnapshot: CodeGraphSnapshot = {
      projectPath: '/tmp/project',
      files: [
        { path: 'src/compression/ranking-adjuster.ts', contentHash: 'bridge-adjuster', language: 'typescript' },
        { path: 'src/compression/relevance-scorer.ts', contentHash: 'bridge-scorer', language: 'typescript' },
        { path: 'src/fusion/intent-router.ts', contentHash: 'bridge-router', language: 'typescript' }
      ],
      nodes: [
        {
          id: 'bridge-adjuster',
          kind: 'function',
          name: 'createFeedbackAwarePolicy',
          qualifiedName: 'src/compression/ranking-adjuster.ts::createFeedbackAwarePolicy',
          filePath: 'src/compression/ranking-adjuster.ts',
          language: 'typescript',
          signature: 'function createFeedbackAwarePolicy(): DynamicFusionPolicy',
          docstring: 'Priority ordering for mixed-source search results',
          calls: []
        },
        {
          id: 'bridge-scorer',
          kind: 'class',
          name: 'RelevanceScorer',
          qualifiedName: 'src/compression/relevance-scorer.ts::RelevanceScorer',
          filePath: 'src/compression/relevance-scorer.ts',
          language: 'typescript',
          signature: 'class RelevanceScorer',
          docstring: 'Semantic ranking and priority ordering',
          calls: []
        },
        {
          id: 'bridge-router',
          kind: 'function',
          name: 'parseFusionQuery',
          qualifiedName: 'src/fusion/intent-router.ts::parseFusionQuery',
          filePath: 'src/fusion/intent-router.ts',
          language: 'typescript',
          signature: 'function parseFusionQuery(query: string): ParsedFusionQuery',
          docstring: 'Priority ordering when search results are mixed from multiple sources',
          calls: []
        }
      ]
    };
    const bridgeVectorResults: VectorSearchResult[] = [
      {
        id: 'bridge-adjuster-vector',
        nodeId: 'bridge-adjuster',
        filePath: 'src/compression/ranking-adjuster.ts',
        language: 'typescript',
        kind: 'function',
        qualifiedName: 'src/compression/ranking-adjuster.ts::createFeedbackAwarePolicy',
        contentHash: 'bridge-adjuster',
        chunkerVersion: DEFAULT_CHUNKER_VERSION,
        score: 0.98
      },
      {
        id: 'bridge-scorer-vector',
        nodeId: 'bridge-scorer',
        filePath: 'src/compression/relevance-scorer.ts',
        language: 'typescript',
        kind: 'class',
        qualifiedName: 'src/compression/relevance-scorer.ts::RelevanceScorer',
        contentHash: 'bridge-scorer',
        chunkerVersion: DEFAULT_CHUNKER_VERSION,
        score: 0.96
      },
      {
        id: 'bridge-router-vector',
        nodeId: 'bridge-router',
        filePath: 'src/fusion/intent-router.ts',
        language: 'typescript',
        kind: 'function',
        qualifiedName: 'src/fusion/intent-router.ts::parseFusionQuery',
        contentHash: 'bridge-router',
        chunkerVersion: DEFAULT_CHUNKER_VERSION,
        score: 0.95
      }
    ];
    const bridgeStoredDocuments = bridgeVectorResults.map((result) => ({
      id: result.nodeId,
      nodeId: result.nodeId,
      filePath: result.filePath,
      embeddingProfile: 'local-token-v1:64',
      chunkerVersion: DEFAULT_CHUNKER_VERSION,
      json: {
        id: result.nodeId,
        nodeId: result.nodeId,
        filePath: result.filePath,
        language: result.language,
        kind: result.kind,
        qualifiedName: result.qualifiedName,
        content: [
          result.qualifiedName,
          result.filePath.includes('intent-router')
            ? 'priority ordering mixed from multiple sources parseFusionQuery routeParsedQuery'
            : 'priority ordering mixed-source search results'
        ].join('\n'),
        contentHash: result.contentHash,
        chunkerVersion: DEFAULT_CHUNKER_VERSION,
        tokens: ['priority', 'ordering', 'mixed', 'sources'],
        contentSparse: {},
        embedding: []
      }
    }));
    const receivedFilters: Array<Record<string, string | undefined>> = [];
    const receivedModes: string[] = [];
    const semanticEngine = new TopoSemanticQueryEngine('/tmp/project', {
      dependencies: {
        readSnapshot: () => bridgeSnapshot,
        vectorSearch: async (_project, _text, _topk, filters, mode) => {
          receivedFilters.push({ ...filters });
          receivedModes.push(mode ?? 'dense');
          if (filters.path) {
            expect(mode).toBe('sparse');
            return bridgeVectorResults.filter((result) => result.filePath.startsWith('src/compression'));
          }
          return bridgeVectorResults.filter((result) => result.filePath === 'src/fusion/intent-router.ts');
        },
        listVectorDocuments: () => bridgeStoredDocuments,
        readFreshness: () => freshness()
      }
    });

    const capsule = await semanticEngine.query('which code decides priority ordering when search results are mixed from multiple sources path:src/compression', { topk: 5 });
    expect(receivedFilters).toHaveLength(1);
    expect(receivedModes).toEqual(['sparse']);
    expect(receivedFilters[0]?.path).toBe('src/compression');
    expect(capsule.intent).toBe('semantic-ranking');
    expect(capsule.route).toBe('graph-first-filter');
    expect(capsule.nodes.map((node) => node.filePath)).toEqual(expect.arrayContaining([
      'src/compression/ranking-adjuster.ts',
      'src/compression/relevance-scorer.ts',
      'src/fusion/intent-router.ts'
    ]));
  });

  test('supports name constraints', async () => {
    const capsule = await engine().search('kind:function name:validate', { topk: 5 });
    expect(capsule.nodes.map((node) => node.nodeId)).toContain('node-validate');
    expect(capsule.nodes.every((node) => node.kind === 'function')).toBe(true);
  });



  test('passes scalar filters into vector search dependencies', async () => {
    let receivedKind: string | undefined;
    const filteredEngine = new TopoSemanticQueryEngine('/tmp/project', {
      dependencies: {
        readSnapshot: () => snapshot,
        vectorSearch: async (_project, _text, _topk, filters) => {
          receivedKind = filters.kind;
          return vectorResults;
        },
        listVectorDocuments: () => storedDocuments,
        readFreshness: () => freshness()
      }
    });
    await filteredEngine.query('kind:function token validation', { topk: 5 });
    expect(receivedKind).toBe('function');
  });

  test('caps graph, vector, and text branch candidate fanout', async () => {
    const budgetSnapshot: CodeGraphSnapshot = {
      projectPath: '/tmp/project',
      files: [
        { path: 'src/graph0.ts', contentHash: 'graph-0', language: 'typescript' },
        { path: 'src/graph1.ts', contentHash: 'graph-1', language: 'typescript' }
      ],
      nodes: [
        { id: 'graph-0', kind: 'function', name: 'alphaGraphA', qualifiedName: 'src/graph0.ts::alphaGraphA', filePath: 'src/graph0.ts', language: 'typescript', signature: 'function alphaGraphA(): void', calls: [] },
        { id: 'graph-1', kind: 'function', name: 'alphaGraphB', qualifiedName: 'src/graph1.ts::alphaGraphB', filePath: 'src/graph1.ts', language: 'typescript', signature: 'function alphaGraphB(): void', calls: [] }
      ]
    };
    const textDocuments = [0, 1].map((index) => ({
      id: `text-${index}`,
      nodeId: `text-${index}`,
      filePath: `src/text${index}.ts`,
      embeddingProfile: 'local-token-v1:64',
      chunkerVersion: DEFAULT_CHUNKER_VERSION,
      json: {
        id: `text-${index}`,
        nodeId: `text-${index}`,
        filePath: `src/text${index}.ts`,
        language: 'typescript',
        kind: 'function',
        qualifiedName: `src/text${index}.ts::alphaText${index}`,
        content: 'alpha lexical branch candidate',
        contentHash: `text-${index}`,
        chunkerVersion: DEFAULT_CHUNKER_VERSION,
        tokens: ['alpha', 'lexical'],
        contentSparse: {},
        embedding: []
      }
    }));
    let receivedVectorTopk = 0;
    const budgetEngine = new TopoSemanticQueryEngine('/tmp/project', {
      dependencies: {
        readSnapshot: () => budgetSnapshot,
        vectorSearch: async (_project, _text, topk) => {
          receivedVectorTopk = topk;
          return [0, 1].map((index) => ({
            id: `zg-vector-${index}`,
            nodeId: `vector-${index}`,
            filePath: `src/vector${index}.ts`,
            language: 'typescript',
            kind: 'function',
            qualifiedName: `src/vector${index}.ts::alphaVector${index}`,
            contentHash: `vector-${index}`,
            chunkerVersion: DEFAULT_CHUNKER_VERSION,
            score: 1 - index * 0.1
          }));
        },
        listVectorDocuments: () => textDocuments,
        readFreshness: () => freshness({ entries: [], fresh: 0, total: 0 })
      }
    });

    const capsule = await budgetEngine.query('alpha', {
      topk: 10,
      candidateBudget: { graph: 1, vector: 1, text: 1, merged: 10 }
    });

    expect(receivedVectorTopk).toBe(1);
    expect(capsule.nodes.filter((node) => node.sources.includes('graph'))).toHaveLength(1);
    expect(capsule.nodes.filter((node) => node.sources.includes('vector'))).toHaveLength(1);
    expect(capsule.nodes.filter((node) => node.sources.includes('fts'))).toHaveLength(1);
  });

  test('fetches only the selected stored vector documents when node-id lookup is available', async () => {
    const requestedNodeIds: string[][] = [];
    const wideSnapshot: CodeGraphSnapshot = {
      projectPath: '/tmp/project',
      files: [
        { path: 'src/auth.ts', contentHash: 'hash-auth', language: 'typescript' },
        { path: 'src/token-service.ts', contentHash: 'hash-service', language: 'typescript' },
        ...Array.from({ length: 8 }, (_value, index) => ({
          path: `src/noise${index}.ts`,
          contentHash: `noise-${index}`,
          language: 'typescript'
        }))
      ],
      nodes: [
        {
          id: 'node-validate',
          kind: 'function',
          name: 'validateToken',
          qualifiedName: 'src/auth.ts::validateToken',
          filePath: 'src/auth.ts',
          language: 'typescript',
          signature: 'function validateToken(token: string): boolean',
          docstring: 'Token validation for bearer credentials',
          calls: ['decodeJwt']
        },
        {
          id: 'node-class',
          kind: 'class',
          name: 'TokenService',
          qualifiedName: 'src/token-service.ts::TokenService',
          filePath: 'src/token-service.ts',
          language: 'typescript',
          signature: 'class TokenService',
          docstring: 'Coordinates validation workflows',
          calls: []
        },
        ...Array.from({ length: 8 }, (_value, index) => ({
          id: `noise-${index}`,
          kind: 'function',
          name: `noiseHelper${index}`,
          qualifiedName: `src/noise${index}.ts::noiseHelper${index}`,
          filePath: `src/noise${index}.ts`,
          language: 'typescript',
          signature: `function noiseHelper${index}(): void`,
          docstring: 'Irrelevant background helper',
          calls: [] as string[]
        }))
      ]
    };

    const optimizedEngine = new TopoSemanticQueryEngine('/tmp/project', {
      dependencies: {
        readSnapshot: () => wideSnapshot,
        vectorSearch: async () => vectorResults,
        getVectorDocumentsByNodeIds: (_project, nodeIds) => {
          requestedNodeIds.push([...nodeIds]);
          return storedDocuments.filter((document) => nodeIds.includes(document.nodeId));
        },
        listVectorDocuments: () => {
          throw new Error('listVectorDocuments should not be used when node-id lookup is available');
        },
        readFreshness: () => freshness()
      }
    });

    const capsule = await optimizedEngine.query('token validation', { topk: 5 });
    expect(requestedNodeIds).toHaveLength(1);
    expect(requestedNodeIds[0]?.length).toBeLessThan(wideSnapshot.nodes.length);
    expect(capsule.nodes.some((node) => node.nodeId === 'node-validate')).toBe(true);
  });

  test('defaults to node-id lookup when custom dependencies omit listVectorDocuments', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'zincgraph-query-engine-node-id-'));
    const getSpy = vi.spyOn(FusionStore.prototype, 'getVectorDocumentsByNodeIds');
    const listSpy = vi.spyOn(FusionStore.prototype, 'listVectorDocuments');

    try {
      seedStoredDocuments(projectPath);

      const optimizedEngine = new TopoSemanticQueryEngine(projectPath, {
        dependencies: {
          readSnapshot: () => snapshot,
          vectorSearch: async () => vectorResults,
          readFreshness: () => freshness()
        }
      });

      const capsule = await optimizedEngine.query('token validation', { topk: 5 });
      expect(getSpy).toHaveBeenCalledTimes(1);
      expect(listSpy).not.toHaveBeenCalled();
      expect(capsule.nodes.some((node) => node.nodeId === 'node-validate')).toBe(true);
    } finally {
      getSpy.mockRestore();
      listSpy.mockRestore();
      rmSync(projectPath, { recursive: true, force: true });
    }
  });



  test('uses vector-first route weighting without deleting graph or fts fusion evidence', async () => {
    const capsule = await engine().query('similar to token validation', { topk: 5 });
    expect(capsule.route).toBe('vector-first');
    expect(capsule.nodes.find((node) => node.nodeId === 'node-validate')?.sources).toEqual(
      expect.arrayContaining(['graph', 'vector', 'fts'])
    );
  });

  test('vector-first route can rank vector evidence above close graph-only evidence', async () => {
    const routeSnapshot: CodeGraphSnapshot = {
      projectPath: '/tmp/project',
      files: [{ path: 'src/graph.ts', contentHash: 'hash-graph', language: 'typescript' }],
      nodes: [
        {
          id: 'node-graph-only',
          kind: 'function',
          name: 'graphOnlyCandidate',
          qualifiedName: 'src/graph.ts::graphOnlyCandidate',
          filePath: 'src/graph.ts',
          language: 'typescript',
          signature: 'function graphOnlyCandidate(): void',
          docstring: 'similar reference',
          calls: []
        }
      ]
    };
    const routeEngine = new TopoSemanticQueryEngine('/tmp/project', {
      dependencies: {
        readSnapshot: () => routeSnapshot,
        vectorSearch: async () => [
          {
            id: 'zg-vector',
            nodeId: 'node-vector-only',
            filePath: 'src/vector.ts',
            language: 'typescript',
            kind: 'function',
            qualifiedName: 'src/vector.ts::vectorOnlyCandidate',
            contentHash: 'hash-vector',
            chunkerVersion: DEFAULT_CHUNKER_VERSION,
            score: 0.4
          }
        ],
        listVectorDocuments: () => [],
        readFreshness: () => freshness({ entries: [], fresh: 0, total: 0 })
      }
    });

    const capsule = await routeEngine.query('similar to target', { topk: 2 });
    expect(capsule.route).toBe('vector-first');
    expect(capsule.nodes.map((node) => node.nodeId)).toEqual(['node-vector-only', 'node-graph-only']);
  });

  test('graph-first route keeps exact graph evidence ahead of close vector evidence', async () => {
    const routeSnapshot: CodeGraphSnapshot = {
      projectPath: '/tmp/project',
      files: [{ path: 'src/auth.ts', contentHash: 'hash-auth', language: 'typescript' }],
      nodes: [
        {
          id: 'node-graph-exact',
          kind: 'function',
          name: 'authenticateUser',
          qualifiedName: 'src/auth.ts::authenticateUser',
          filePath: 'src/auth.ts',
          language: 'typescript',
          signature: 'function authenticateUser(): void',
          docstring: 'authenticates a user',
          calls: []
        }
      ]
    };
    const routeEngine = new TopoSemanticQueryEngine('/tmp/project', {
      dependencies: {
        readSnapshot: () => routeSnapshot,
        vectorSearch: async () => [
          {
            id: 'zg-vector',
            nodeId: 'node-vector-close',
            filePath: 'src/vector.ts',
            language: 'typescript',
            kind: 'function',
            qualifiedName: 'src/vector.ts::vectorCloseCandidate',
            contentHash: 'hash-vector',
            chunkerVersion: DEFAULT_CHUNKER_VERSION,
            score: 1
          }
        ],
        listVectorDocuments: () => [],
        readFreshness: () => freshness({ entries: [], fresh: 0, total: 0 })
      }
    });

    const capsule = await routeEngine.query('authenticateUser', { topk: 2 });
    expect(capsule.route).toBe('graph-first');
    expect(capsule.nodes[0]?.nodeId).toBe('node-graph-exact');
  });

  test('graph-first-filter route preserves path-constrained results', async () => {
    const capsule = await engine().query('path:src/auth token validation', { topk: 5 });
    expect(capsule.route).toBe('graph-first-filter');
    expect(capsule.nodes.length).toBeGreaterThan(0);
    expect(capsule.nodes.every((node) => node.filePath.startsWith('src/auth'))).toBe(true);
  });

  test('filters stale v1 vector and stored-document evidence from fusion results', async () => {
    const staleEngine = new TopoSemanticQueryEngine('/tmp/project', {
      dependencies: {
        readSnapshot: () => ({ projectPath: '/tmp/project', files: [], nodes: [] }),
        vectorSearch: async () => [{
          id: 'zg-old',
          nodeId: 'old-node',
          filePath: 'src/old.ts',
          language: 'typescript',
          kind: 'function',
          qualifiedName: 'src/old.ts::oldNode',
          contentHash: 'old',
          chunkerVersion: 'codegraph-node-v1',
          score: 10
        }],
        listVectorDocuments: () => [{
          id: 'old-node',
          nodeId: 'old-node',
          filePath: 'src/old.ts',
          embeddingProfile: 'local-token-v1:64',
          chunkerVersion: 'codegraph-node-v1',
          json: {
            id: 'old-node',
            nodeId: 'old-node',
            filePath: 'src/old.ts',
            language: 'typescript',
            kind: 'function',
            qualifiedName: 'src/old.ts::oldNode',
            content: 'old stale content',
            contentHash: 'old',
            chunkerVersion: 'codegraph-node-v1',
            tokens: ['old', 'stale'],
            contentSparse: {},
            embedding: []
          }
        }],
        readFreshness: () => freshness({ entries: [], fresh: 0, total: 0 })
      }
    });
    const capsule = await staleEngine.query('old stale', { topk: 5 });
    expect(capsule.nodes).toHaveLength(0);
  });

  test('semantic bridge aliases surface orphan nodes without explicit graph relations', async () => {
    const semanticSnapshot: CodeGraphSnapshot = {
      projectPath: '/tmp/project',
      files: [{ path: 'src/auth.ts', contentHash: 'hash-auth', language: 'typescript' }],
      nodes: [
        {
          id: 'node-orphan',
          kind: 'function',
          name: 'authenticateRequest',
          qualifiedName: 'src/auth.ts::authenticateRequest',
          filePath: 'src/auth.ts',
          language: 'typescript',
          signature: 'function authenticateRequest(request: Request): Response',
          docstring: 'Validates bearer credentials',
          calls: []
        },
        {
          id: 'node-peer',
          kind: 'function',
          name: 'LegacyRouteGuard',
          qualifiedName: 'src/auth.ts::LegacyRouteGuard',
          filePath: 'src/auth.ts',
          language: 'typescript',
          signature: 'function LegacyRouteGuard(): void',
          docstring: 'Compatibility guard used during framework migration',
          calls: []
        }
      ]
    };
    const semanticEngine = new TopoSemanticQueryEngine('/tmp/project', {
      dependencies: {
        readSnapshot: () => semanticSnapshot,
        vectorSearch: async () => [],
        listVectorDocuments: () => [{
          id: 'node-orphan',
          nodeId: 'node-orphan',
          filePath: 'src/auth.ts',
          embeddingProfile: 'local-token-v1:64',
          chunkerVersion: DEFAULT_CHUNKER_VERSION,
          json: {
            id: 'node-orphan',
            nodeId: 'node-orphan',
            filePath: 'src/auth.ts',
            language: 'typescript',
            kind: 'function',
            qualifiedName: 'src/auth.ts::authenticateRequest',
            content: [
              'function authenticateRequest(request: Request): Response',
              'Validates bearer credentials',
              'semantic aliases',
              'LegacyRouteGuard',
              'src/auth.ts::LegacyRouteGuard',
              'semantic neighbors',
              'same-file src/auth.ts::LegacyRouteGuard'
            ].join('\n'),
            contentHash: 'hash-auth',
            chunkerVersion: DEFAULT_CHUNKER_VERSION,
            tokens: ['authenticate', 'request', 'legacy', 'route', 'guard'],
            contentSparse: {},
            embedding: [],
            semanticAliases: ['LegacyRouteGuard', 'src/auth.ts::LegacyRouteGuard'],
            semanticNeighbors: [{
              nodeId: 'node-peer',
              qualifiedName: 'src/auth.ts::LegacyRouteGuard',
              filePath: 'src/auth.ts',
              kind: 'function',
              score: 0.65,
              relationship: 'same-file'
            }]
          }
        }],
        readFreshness: () => freshness({ entries: [], fresh: 0, total: 0 })
      }
    });

    const capsule = await semanticEngine.query('legacy route guard', { topk: 5 });
    const orphan = capsule.nodes.find((node) => node.nodeId === 'node-orphan');
    expect(orphan).toBeDefined();
    expect(orphan?.sources).toEqual(expect.arrayContaining(['graph', 'fts']));
  });

  test('broad behavior query surfaces dedup and graph-review modules without hard-coded task knowledge', async () => {
    const broadSnapshot: CodeGraphSnapshot = {
      projectPath: '/tmp/project',
      files: [
        { path: 'src/behavior/dedup-check.ts', contentHash: 'dedup', language: 'typescript' },
        { path: 'src/behavior/graph-review.ts', contentHash: 'review', language: 'typescript' },
        { path: 'src/behavior/graph-extra.ts', contentHash: 'extra', language: 'typescript' }
      ],
      nodes: [
        {
          id: 'dedup',
          kind: 'function',
          name: 'runDedupCheck',
          qualifiedName: 'src/behavior/dedup-check.ts::runDedupCheck',
          filePath: 'src/behavior/dedup-check.ts',
          language: 'typescript',
          signature: 'function runDedupCheck(options: RunDedupCheckOptions): Promise<DedupCheckResult>',
          sourceSnippet: 'export function runDedupCheck(options) { return checker.check({ description: options.description }); } // semantic duplicate reuse',
          calls: ['DedupChecker.check']
        },
        {
          id: 'review',
          kind: 'function',
          name: 'analyzeGraphReview',
          qualifiedName: 'src/behavior/graph-review.ts::analyzeGraphReview',
          filePath: 'src/behavior/graph-review.ts',
          language: 'typescript',
          signature: 'function analyzeGraphReview(options: AnalyzeGraphReviewOptions): GraphReviewResult',
          sourceSnippet: 'export function analyzeGraphReview(options) { return new GraphReviewAnalyzer().analyze(options); }',
          calls: ['GraphReviewAnalyzer']
        },
        ...Array.from({ length: 4 }, (_, index) => ({
          id: `review-extra-${index}`,
          kind: 'function',
          name: `formatGraphReviewExtra${index}`,
          qualifiedName: `src/behavior/graph-extra.ts::formatGraphReviewExtra${index}`,
          filePath: 'src/behavior/graph-extra.ts',
          language: 'typescript',
          signature: `function formatGraphReviewExtra${index}(): void`,
          sourceSnippet: 'graph review formatting helper',
          calls: [] as string[]
        }))
      ]
    };
    const broadEngine = new TopoSemanticQueryEngine('/tmp/project', {
      dependencies: {
        readSnapshot: () => broadSnapshot,
        vectorSearch: async () => [],
        listVectorDocuments: () => [],
        readFreshness: () => freshness({ entries: [], fresh: 0, total: 0 })
      }
    });
    const capsule = await broadEngine.query('semantic dedup graph review', { topk: 3 });
    expect(capsule.nodes.map((node) => node.nodeId)).toEqual(expect.arrayContaining(['dedup', 'review']));
  });

  test('non-benchmark broad query uses the same path/name/source overlap behavior', async () => {
    const authSnapshot: CodeGraphSnapshot = {
      projectPath: '/tmp/project',
      files: [
        { path: 'src/auth/token.ts', contentHash: 'auth', language: 'typescript' },
        { path: 'src/services/token-validation.ts', contentHash: 'service', language: 'typescript' },
        { path: 'src/ui/button.ts', contentHash: 'ui', language: 'typescript' }
      ],
      nodes: [
        { id: 'auth', kind: 'function', name: 'parseAuthToken', qualifiedName: 'src/auth/token.ts::parseAuthToken', filePath: 'src/auth/token.ts', language: 'typescript', signature: 'function parseAuthToken(token: string): Claims', sourceSnippet: 'auth token parser validates credentials', calls: [] },
        { id: 'service', kind: 'class', name: 'TokenValidationService', qualifiedName: 'src/services/token-validation.ts::TokenValidationService', filePath: 'src/services/token-validation.ts', language: 'typescript', signature: 'class TokenValidationService', sourceSnippet: 'service coordinates token validation workflows', calls: [] },
        { id: 'noise', kind: 'function', name: 'renderButton', qualifiedName: 'src/ui/button.ts::renderButton', filePath: 'src/ui/button.ts', language: 'typescript', signature: 'function renderButton(): void', sourceSnippet: 'unrelated user interface rendering', calls: [] }
      ]
    };
    const authEngine = new TopoSemanticQueryEngine('/tmp/project', {
      dependencies: {
        readSnapshot: () => authSnapshot,
        vectorSearch: async () => [],
        listVectorDocuments: () => [],
        readFreshness: () => freshness({ entries: [], fresh: 0, total: 0 })
      }
    });
    const capsule = await authEngine.query('auth token service validation', { topk: 2 });
    expect(capsule.nodes.map((node) => node.nodeId)).toEqual(expect.arrayContaining(['auth', 'service']));
    expect(capsule.nodes.map((node) => node.nodeId)).not.toContain('noise');
  });

  test('adversarial broad query does not boost unrelated benchmark-like symbols without token overlap', async () => {
    const adversarialSnapshot: CodeGraphSnapshot = {
      projectPath: '/tmp/project',
      files: [
        { path: 'src/cache/eviction-policy.ts', contentHash: 'cache', language: 'typescript' },
        { path: 'src/behavior/dedup-check.ts', contentHash: 'dedup', language: 'typescript' }
      ],
      nodes: [
        { id: 'cache', kind: 'function', name: 'applyCacheEvictionPolicy', qualifiedName: 'src/cache/eviction-policy.ts::applyCacheEvictionPolicy', filePath: 'src/cache/eviction-policy.ts', language: 'typescript', signature: 'function applyCacheEvictionPolicy(): void', sourceSnippet: 'cache eviction policy chooses stale entries', calls: [] },
        { id: 'golden-like', kind: 'function', name: 'runDedupCheck', qualifiedName: 'src/behavior/dedup-check.ts::runDedupCheck', filePath: 'src/behavior/dedup-check.ts', language: 'typescript', signature: 'function runDedupCheck(): void', sourceSnippet: 'semantic dedup graph review golden-like but unrelated to cache', calls: [] }
      ]
    };
    const adversarialEngine = new TopoSemanticQueryEngine('/tmp/project', {
      dependencies: {
        readSnapshot: () => adversarialSnapshot,
        vectorSearch: async () => [],
        listVectorDocuments: () => [],
        readFreshness: () => freshness({ entries: [], fresh: 0, total: 0 })
      }
    });
    const capsule = await adversarialEngine.query('cache eviction policy', { topk: 2 });
    expect(capsule.nodes[0]?.nodeId).toBe('cache');
  });

  test('exact graph-first symbol query still ranks exact match first after broad-query nudge', async () => {
    const exactSnapshot: CodeGraphSnapshot = {
      projectPath: '/tmp/project',
      files: [{ path: 'src/behavior/graph-review.ts', contentHash: 'review', language: 'typescript' }],
      nodes: [
        { id: 'exact', kind: 'function', name: 'analyzeGraphReview', qualifiedName: 'src/behavior/graph-review.ts::analyzeGraphReview', filePath: 'src/behavior/graph-review.ts', language: 'typescript', signature: 'function analyzeGraphReview(): GraphReviewResult', sourceSnippet: 'graph review analyzer', calls: [] },
        { id: 'near', kind: 'function', name: 'formatGraphReview', qualifiedName: 'src/behavior/graph-review.ts::formatGraphReview', filePath: 'src/behavior/graph-review.ts', language: 'typescript', signature: 'function formatGraphReview(): string', sourceSnippet: 'analyze graph review output', calls: [] }
      ]
    };
    const exactEngine = new TopoSemanticQueryEngine('/tmp/project', {
      dependencies: {
        readSnapshot: () => exactSnapshot,
        vectorSearch: async () => [],
        listVectorDocuments: () => [],
        readFreshness: () => freshness({ entries: [], fresh: 0, total: 0 })
      }
    });
    const capsule = await exactEngine.query('analyzeGraphReview', { topk: 2 });
    expect(capsule.route).toBe('graph-first');
    expect(capsule.nodes[0]?.nodeId).toBe('exact');
  });

  test('hybrid route has neutral branch weights', () => {
    expect(routeWeight('hybrid', 'graph')).toBe(1);
    expect(routeWeight('hybrid', 'vector')).toBe(1);
    expect(routeWeight('hybrid', 'fts')).toBe(1);
    expect(routeWeight('graph-first', 'graph')).toBeGreaterThan(routeWeight('graph-first', 'vector'));
    expect(routeWeight('vector-first', 'vector')).toBeGreaterThan(routeWeight('vector-first', 'graph'));
  });



  test('exports explicit fusion ranking policy constants', () => {
    expect(FUSION_RANKING_POLICY.routeWeights['graph-first'].graph).toBe(1.25);
    expect(FUSION_RANKING_POLICY.routeWeights['vector-first'].vector).toBe(1.35);
    expect(FUSION_RANKING_POLICY.routeWeights.hybrid.graph).toBe(1);
    expect(FUSION_RANKING_POLICY.fusionBoosts).toMatchObject({
      multiSourceBonusPerAdditionalSource: 0.25,
      graphExactMultiplier: 1.3,
      callProximityMultiplier: 1.15
    });
    expect(FUSION_RANKING_POLICY.freshnessPenalties).toMatchObject({ stale: 0.8, nonFresh: 0.7 });
    expect(FUSION_RANKING_POLICY.tieBreakers).toEqual([
      'score-desc',
      'filePath-asc',
      'nodeId-asc',
      'qualifiedName-asc'
    ]);
  });

  test('orders equal-score fusion nodes deterministically by file, node, then name', () => {
    const base: Omit<FusionNode, 'nodeId' | 'filePath' | 'qualifiedName'> = {
      language: 'typescript',
      kind: 'function',
      contentHash: 'hash',
      score: 1,
      sources: ['graph'],
      sourceScores: { graph: 1 },
      content: 'content'
    };
    const sorted: FusionNode[] = [
      { ...base, nodeId: 'node-b', filePath: 'src/b.ts', qualifiedName: 'b' },
      { ...base, nodeId: 'node-c', filePath: 'src/a.ts', qualifiedName: 'c' },
      { ...base, nodeId: 'node-a', filePath: 'src/a.ts', qualifiedName: 'a' }
    ].sort(compareFusionNodes);
    expect(sorted.map((node) => node.nodeId)).toEqual(['node-a', 'node-c', 'node-b']);
  });

  test('translates exact scalar filters to a Zvec filter expression', () => {
    expect(zvecFilterFor({ kind: 'function', language: 'typescript', file: "src/a'b.ts" })).toBe(
      "kind = 'function' AND language = 'typescript' AND file_path = 'src/a''b.ts'"
    );
    expect(zvecFilterFor({ path: 'src', name: 'validate' })).toBeUndefined();
  });

  test('uses lexical fts evidence from persisted vector document tokens', async () => {
    const capsule = await engine().query('bearer credentials', { topk: 5 });
    expect(capsule.nodes.find((node) => node.nodeId === 'node-validate')?.sources).toContain('fts');
  });

  test('returns scalar filters in the capsule', async () => {
    const capsule = await engine().query('language:typescript path:src token', { topk: 5 });
    expect(capsule.filters).toMatchObject({ language: 'typescript', path: 'src' });
  });
});
