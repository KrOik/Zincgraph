import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test, vi } from 'vitest';

import { FUSION_RANKING_POLICY, TopoSemanticQueryEngine, compareFusionNodes, routeWeight, zvecFilterFor } from '../../src/fusion/query-engine.js';
import type { FusionNode } from '../../src/fusion/query-engine.js';
import type { FusionCompressionAdapter } from '../../src/compression/fusion-compressor.js';
import type { RelevanceScorerAdapter } from '../../src/compression/relevance-scorer.js';
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

function neutralRelevanceScorer() {
  return {
    score: (_query: string, documents: readonly { nodeId: string }[]) =>
      documents.map((document) => ({
        nodeId: document.nodeId,
        score: 0.5,
        bm25Score: 0,
        embeddingScore: 0,
        lexicalScore: 0,
        semanticScore: 0,
        structureScore: 0,
        freshnessScore: 0,
        matchedTerms: [],
        rankFeatures: {
          lexical: 0,
          semantic: 0,
          structure: 0,
          freshness: 0,
          final: 0.5
        },
        rankWeights: {
          lexical: 1,
          semantic: 1,
          structure: 1,
          freshness: 1
        }
      }))
  };
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

  test('explicit anchor bundle queries still consult vector search for supplemental evidence', async () => {
    let vectorSearchCalls = 0;
    const bundleEngine = new TopoSemanticQueryEngine('/tmp/project', {
      dependencies: {
        readSnapshot: () => snapshot,
        vectorSearch: async () => {
          vectorSearchCalls += 1;
          return vectorResults;
        },
        listVectorDocuments: () => storedDocuments,
        readFreshness: () => freshness()
      }
    });

    await bundleEngine.query('src/auth.ts TokenService', { topk: 5 });
    expect(vectorSearchCalls).toBeGreaterThan(0);
  });

  test('exact symbol graph-first queries prefer the root definition over same-file member noise', async () => {
    const exactSnapshot: CodeGraphSnapshot = {
      projectPath: '/tmp/project',
      files: [
        { path: 'superset/commands/sql_lab/execute.py', contentHash: 'execute-hash', language: 'python' },
        { path: 'superset/sql/parse.py', contentHash: 'parse-hash', language: 'python' }
      ],
      nodes: [
        {
          id: 'execute-class',
          kind: 'class',
          name: 'ExecuteSqlCommand',
          qualifiedName: 'superset/commands/sql_lab/execute.py::ExecuteSqlCommand',
          filePath: 'superset/commands/sql_lab/execute.py',
          language: 'python',
          signature: 'class ExecuteSqlCommand',
          docstring: 'render validate sql command',
          calls: []
        },
        {
          id: 'execute-init',
          kind: 'method',
          name: '__init__',
          qualifiedName: 'superset/commands/sql_lab/execute.py::ExecuteSqlCommand::__init__',
          filePath: 'superset/commands/sql_lab/execute.py',
          language: 'python',
          signature: 'def __init__(...)',
          docstring: 'render validate sql command helper',
          calls: []
        },
        {
          id: 'parse-noise',
          kind: 'class',
          name: 'RLSAsSubqueryTransformer',
          qualifiedName: 'superset/sql/parse.py::RLSAsSubqueryTransformer',
          filePath: 'superset/sql/parse.py',
          language: 'python',
          signature: 'class RLSAsSubqueryTransformer',
          docstring: 'validate noise',
          calls: []
        }
      ]
    };
    const exactEngine = new TopoSemanticQueryEngine('/tmp/project', {
      dependencies: {
        readSnapshot: () => exactSnapshot,
        vectorSearch: async () => [],
        listVectorDocuments: () => [],
        readFreshness: () => freshness()
      }
    });

    const capsule = await exactEngine.query('superset/commands/sql_lab/execute.py ExecuteSqlCommand render validate', { topk: 3 });
    expect(capsule.nodes[0]?.nodeId).toBe('execute-class');
    expect(capsule.nodes.map((node) => node.nodeId)).toContain('execute-class');
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

  test('exact class anchors stay ahead of same-class member noise when the class is named', async () => {
    const classSnapshot: CodeGraphSnapshot = {
      projectPath: '/tmp/project',
      files: [{ path: 'superset/commands/sql_lab/execute.py', contentHash: 'hash-execute', language: 'python' }],
      nodes: [
        {
          id: 'node-class',
          kind: 'class',
          name: 'ExecuteSqlCommand',
          qualifiedName: 'superset/commands/sql_lab/execute.py::ExecuteSqlCommand',
          filePath: 'superset/commands/sql_lab/execute.py',
          language: 'python',
          signature: 'class ExecuteSqlCommand',
          docstring: 'wires SQL execution.',
          calls: ['ExecuteSqlCommand::__init__']
        },
        {
          id: 'node-member',
          kind: 'method',
          name: '__init__',
          qualifiedName: 'superset/commands/sql_lab/execute.py::ExecuteSqlCommand::__init__',
          filePath: 'superset/commands/sql_lab/execute.py',
          language: 'python',
          signature: 'def __init__(self, execution_context, query_dao)',
          docstring: 'initializes the command wiring.',
          calls: []
        }
      ]
    };
    const classEngine = new TopoSemanticQueryEngine('/tmp/project', {
      dependencies: {
        readSnapshot: () => classSnapshot,
        vectorSearch: async () => [],
        listVectorDocuments: () => [],
        readFreshness: () => freshness({ entries: [], fresh: 0, total: 0 }),
        relevanceScorer: neutralRelevanceScorer()
      }
    });

    const capsule = await classEngine.query('superset/commands/sql_lab/execute.py ExecuteSqlCommand validate', { topk: 2 });
    expect(capsule.route).toBe('graph-first-filter');
    expect(capsule.nodes[0]?.nodeId).toBe('node-class');
    expect(capsule.nodes.map((node) => node.nodeId)).toContain('node-member');
  });

  test('exact anchors survive rerank even when a relevance scorer prefers same-file member noise', async () => {
    const classSnapshot: CodeGraphSnapshot = {
      projectPath: '/tmp/project',
      files: [
        { path: 'superset/commands/sql_lab/execute.py', contentHash: 'hash-execute', language: 'python' },
        { path: 'superset/sql/parse.py', contentHash: 'hash-parse', language: 'python' }
      ],
      nodes: [
        {
          id: 'node-class',
          kind: 'class',
          name: 'ExecuteSqlCommand',
          qualifiedName: 'superset/commands/sql_lab/execute.py::ExecuteSqlCommand',
          filePath: 'superset/commands/sql_lab/execute.py',
          language: 'python',
          signature: 'class ExecuteSqlCommand',
          docstring: 'wires SQL execution.',
          calls: ['ExecuteSqlCommand::__init__']
        },
        {
          id: 'node-member',
          kind: 'method',
          name: '__init__',
          qualifiedName: 'superset/commands/sql_lab/execute.py::ExecuteSqlCommand::__init__',
          filePath: 'superset/commands/sql_lab/execute.py',
          language: 'python',
          signature: 'def __init__(self, execution_context, query_dao)',
          docstring: 'render validate query render validate query render validate query.',
          calls: ['SqlQueryRenderException']
        },
        {
          id: 'node-noise',
          kind: 'class',
          name: 'RLSAsSubqueryTransformer',
          qualifiedName: 'superset/sql/parse.py::RLSAsSubqueryTransformer',
          filePath: 'superset/sql/parse.py',
          language: 'python',
          signature: 'class RLSAsSubqueryTransformer',
          docstring: 'render validate path noise',
          calls: []
        }
      ]
    };
    const biasedRelevanceScorer: RelevanceScorerAdapter = {
      score: (_query, documents) =>
        documents.map((document) => {
          const score = document.nodeId === 'node-member'
            ? 0.99
            : document.nodeId === 'node-noise'
              ? 0.61
              : 0.05;
          return {
            nodeId: document.nodeId,
            score,
            bm25Score: 0,
            embeddingScore: 0,
            lexicalScore: 0,
            semanticScore: 0,
            structureScore: 0,
            freshnessScore: 0,
            matchedTerms: [],
            rankFeatures: {
              lexical: 0,
              semantic: 0,
              structure: 0,
              freshness: 0,
              final: score
            },
            rankWeights: {
              lexical: 1,
              semantic: 1,
              structure: 1,
              freshness: 1
            }
          };
        })
    };
    const classEngine = new TopoSemanticQueryEngine('/tmp/project', {
      dependencies: {
        readSnapshot: () => classSnapshot,
        vectorSearch: async () => [],
        listVectorDocuments: () => [],
        readFreshness: () => freshness({ entries: [], fresh: 0, total: 0 }),
        relevanceScorer: biasedRelevanceScorer
      }
    });

    const capsule = await classEngine.query(
      'superset/commands/sql_lab/execute.py superset/sql/parse.py ExecuteSqlCommand SqlQueryRenderImpl SqlQueryRenderException render validate',
      { topk: 3 }
    );

    expect(capsule.nodes[0]?.nodeId).toBe('node-class');
    expect(capsule.nodes.map((node) => node.nodeId)).toContain('node-member');
  });

  test('noisy multi-file bundles still surface exact file symbols within the top results', async () => {
    const bundleSnapshot: CodeGraphSnapshot = {
      projectPath: '/tmp/project',
      files: [
        { path: 'airflow-core/src/airflow/api_fastapi/core_api/routes/ui/structure.py', contentHash: 'hash-route', language: 'python' },
        { path: 'airflow-core/src/airflow/api_fastapi/core_api/services/ui/structure.py', contentHash: 'hash-service', language: 'python' },
        { path: 'airflow-core/src/airflow/api_fastapi/core_api/datamodels/ui/structure.py', contentHash: 'hash-model', language: 'python' }
      ],
      nodes: [
        {
          id: 'structure-data',
          kind: 'function',
          name: 'structure_data',
          qualifiedName: 'airflow-core/src/airflow/api_fastapi/core_api/routes/ui/structure.py::structure_data',
          filePath: 'airflow-core/src/airflow/api_fastapi/core_api/routes/ui/structure.py',
          language: 'python',
          signature: 'def structure_data() -> StructureDataResponse',
          docstring: 'structure data structure data bind output assets tasks get dag structure validate upstream downstream',
          sourceSnippet: 'def structure_data(): return get_upstream_assets()',
          calls: ['get_upstream_assets']
        },
        {
          id: 'bind-output-assets',
          kind: 'function',
          name: 'bind_output_assets_to_tasks',
          qualifiedName: 'airflow-core/src/airflow/api_fastapi/core_api/services/ui/structure.py::bind_output_assets_to_tasks',
          filePath: 'airflow-core/src/airflow/api_fastapi/core_api/services/ui/structure.py',
          language: 'python',
          signature: 'def bind_output_assets_to_tasks() -> None',
          docstring: 'bind output assets to tasks structure data get dag structure validate upstream downstream',
          sourceSnippet: 'def bind_output_assets_to_tasks(): return None',
          calls: []
        },
        {
          id: 'get-dag-structure',
          kind: 'function',
          name: 'get_dag_structure',
          qualifiedName: 'airflow-core/src/airflow/api_fastapi/core_api/services/ui/structure.py::get_dag_structure',
          filePath: 'airflow-core/src/airflow/api_fastapi/core_api/services/ui/structure.py',
          language: 'python',
          signature: 'def get_dag_structure() -> dict',
          docstring: 'get dag structure structure data bind output assets validate upstream downstream',
          sourceSnippet: 'def get_dag_structure(): return {}',
          calls: []
        },
        {
          id: 'structure-response',
          kind: 'class',
          name: 'StructureDataResponse',
          qualifiedName: 'airflow-core/src/airflow/api_fastapi/core_api/datamodels/ui/structure.py::StructureDataResponse',
          filePath: 'airflow-core/src/airflow/api_fastapi/core_api/datamodels/ui/structure.py',
          language: 'python',
          signature: 'class StructureDataResponse',
          docstring: 'StructureDataResponse NodeResponse EdgeResponse structure data',
          sourceSnippet: 'class StructureDataResponse: ...',
          calls: []
        },
        {
          id: 'get-upstream-assets',
          kind: 'function',
          name: 'get_upstream_assets',
          qualifiedName: 'airflow-core/src/airflow/api_fastapi/core_api/services/ui/structure.py::get_upstream_assets',
          filePath: 'airflow-core/src/airflow/api_fastapi/core_api/services/ui/structure.py',
          language: 'python',
          signature: 'def get_upstream_assets(asset_expression, entry_node_ref, level=0) -> tuple[list[dict], list[dict]]',
          docstring: 'get upstream assets',
          sourceSnippet: 'def get_upstream_assets(asset_expression, entry_node_ref, level=0): return [], []',
          calls: []
        }
      ]
    };
    const bundleEngine = new TopoSemanticQueryEngine('/tmp/project', {
      dependencies: {
        readSnapshot: () => bundleSnapshot,
        vectorSearch: async () => [],
        listVectorDocuments: () => [],
        readFreshness: () => freshness({ entries: [], fresh: 0, total: 0 }),
        relevanceScorer: neutralRelevanceScorer()
      }
    });

    const capsule = await bundleEngine.query(
      'airflow-core/src/airflow/api_fastapi/core_api/routes/ui/structure.py airflow-core/src/airflow/api_fastapi/core_api/services/ui/structure.py airflow-core/src/airflow/api_fastapi/core_api/datamodels/ui/structure.py StructureDataResponse bind_output_assets_to_tasks get_upstream_assets get_dag_structure structure_data',
      { topk: 3 }
    );

    expect(capsule.route).toBe('graph-first');
    expect(capsule.nodes.slice(0, 3).map((node) => node.nodeId)).toContain('get-upstream-assets');
  });

  test('graphExactMultiplier keeps exact path anchors ahead of same-query noise after rerank', async () => {
    const pathSnapshot: CodeGraphSnapshot = {
      projectPath: '/tmp/project',
      files: [
        { path: 'src/airflow/api_fastapi/core_api/services/public/dag_run.py', contentHash: 'path-exact', language: 'python' },
        { path: 'src/airflow/api_fastapi/core_api/services/public/dag_run_helpers.py', contentHash: 'path-noise', language: 'python' }
      ],
      nodes: [
        {
          id: 'path-exact',
          kind: 'function',
          name: 'perform_clear_dag_run',
          qualifiedName: 'src/airflow/api_fastapi/core_api/services/public/dag_run.py::perform_clear_dag_run',
          filePath: 'src/airflow/api_fastapi/core_api/services/public/dag_run.py',
          language: 'python',
          signature: 'def perform_clear_dag_run() -> None',
          docstring: 'Clear dag runs.',
          calls: ['bulk_clear_dag_run_body']
        },
        {
          id: 'path-noise',
          kind: 'function',
          name: 'perform_clear_dag_run_helper',
          qualifiedName: 'src/airflow/api_fastapi/core_api/services/public/dag_run_helpers.py::perform_clear_dag_run_helper',
          filePath: 'src/airflow/api_fastapi/core_api/services/public/dag_run_helpers.py',
          language: 'python',
          signature: 'def perform_clear_dag_run_helper() -> None',
          docstring: 'perform clear dag run helper perform clear dag run helper perform clear dag run helper',
          calls: ['perform_clear_dag_run']
        }
      ]
    };
    const pathEngine = new TopoSemanticQueryEngine('/tmp/project', {
      dependencies: {
        readSnapshot: () => pathSnapshot,
        vectorSearch: async () => [],
        listVectorDocuments: () => [],
        readFreshness: () => freshness({ entries: [], fresh: 0, total: 0 }),
        relevanceScorer: neutralRelevanceScorer()
      }
    });
    pathEngine.setDynamicPolicy({
      base: FUSION_RANKING_POLICY,
      adjustments: {
        fusionBoostOverrides: {
          graphExactMultiplier: 8
        }
      }
    });

    const capsule = await pathEngine.query('src/airflow/api_fastapi/core_api/services/public/dag_run.py perform_clear_dag_run', { topk: 2 });
    expect(capsule.route).toBe('graph-first-filter');
    expect(capsule.nodes[0]?.nodeId).toBe('path-exact');
    expect(capsule.nodes[1]?.nodeId).toBe('path-noise');
  });

  test('callProximityMultiplier keeps direct neighbors ahead of unrelated distractors after rerank', async () => {
    const proximitySnapshot: CodeGraphSnapshot = {
      projectPath: '/tmp/project',
      files: [
        { path: 'src/airflow/api_fastapi/core_api/services/public/dag_run.py', contentHash: 'path-exact', language: 'python' },
        { path: 'src/airflow/api_fastapi/core_api/services/public/dag_run_helpers.py', contentHash: 'path-noise', language: 'python' },
        { path: 'src/airflow/api_fastapi/core_api/services/public/dag_run_body.py', contentHash: 'path-distractor', language: 'python' }
      ],
      nodes: [
        {
          id: 'path-exact',
          kind: 'function',
          name: 'perform_clear_dag_run',
          qualifiedName: 'src/airflow/api_fastapi/core_api/services/public/dag_run.py::perform_clear_dag_run',
          filePath: 'src/airflow/api_fastapi/core_api/services/public/dag_run.py',
          language: 'python',
          signature: 'def perform_clear_dag_run() -> None',
          docstring: 'Clear dag runs.',
          calls: ['bulk_clear_dag_run_body']
        },
        {
          id: 'path-noise',
          kind: 'function',
          name: 'build_bulk_dag_run_body',
          qualifiedName: 'src/airflow/api_fastapi/core_api/services/public/dag_run_helpers.py::build_bulk_dag_run_body',
          filePath: 'src/airflow/api_fastapi/core_api/services/public/dag_run_helpers.py',
          language: 'python',
          signature: 'def build_bulk_dag_run_body() -> None',
          docstring: 'perform clear dag run helper perform clear dag run helper perform clear dag run helper',
          calls: ['perform_clear_dag_run']
        },
        {
          id: 'path-distractor',
          kind: 'function',
          name: 'build_bulk_dag_run_body',
          qualifiedName: 'src/airflow/api_fastapi/core_api/services/public/dag_run_body.py::build_bulk_dag_run_body',
          filePath: 'src/airflow/api_fastapi/core_api/services/public/dag_run_body.py',
          language: 'python',
          signature: 'def build_bulk_dag_run_body() -> None',
          docstring: 'perform clear dag run helper perform clear dag run helper perform clear dag run helper',
          calls: []
        }
      ]
    };
    const proximityEngine = new TopoSemanticQueryEngine('/tmp/project', {
      dependencies: {
        readSnapshot: () => proximitySnapshot,
        vectorSearch: async () => [],
        listVectorDocuments: () => [],
        readFreshness: () => freshness({ entries: [], fresh: 0, total: 0 }),
        relevanceScorer: neutralRelevanceScorer()
      }
    });
    proximityEngine.setDynamicPolicy({
      base: FUSION_RANKING_POLICY,
      adjustments: {
        fusionBoostOverrides: {
          callProximityMultiplier: 3
        }
      }
    });

    const capsule = await proximityEngine.query('src/airflow/api_fastapi/core_api/services/public/dag_run.py perform_clear_dag_run', { topk: 3 });
    const ids = capsule.nodes.map((node) => node.nodeId);
    expect(ids).toContain('path-exact');
    expect(ids.indexOf('path-noise')).toBeGreaterThan(-1);
    expect(ids.indexOf('path-distractor')).toBeGreaterThan(-1);
    expect(ids.indexOf('path-noise')).toBeLessThan(ids.indexOf('path-distractor'));
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

  test('explicit anchor bundles still consult vector search and keep graph evidence first', async () => {
    let vectorCalls = 0;
    const anchorEngine = new TopoSemanticQueryEngine('/tmp/project', {
      dependencies: {
        readSnapshot: () => snapshot,
        vectorSearch: async () => {
          vectorCalls += 1;
          return vectorResults;
        },
        listVectorDocuments: () => storedDocuments,
        readFreshness: () => freshness({ entries: [], fresh: 0, total: 0 }),
        relevanceScorer: neutralRelevanceScorer()
      }
    });

    const capsule = await anchorEngine.query('src/token-service.ts TokenService', { topk: 2 });

    expect(vectorCalls).toBeGreaterThan(0);
    expect(capsule.nodes[0]?.nodeId).toBe('node-class');
  });

  test('anchor-dense mixed bundles still consult vector search and keep graph evidence first', async () => {
    let vectorCalls = 0;
    const mixedSnapshot: CodeGraphSnapshot = {
      projectPath: '/tmp/project',
      files: [
        { path: 'airbyte-integrations/connectors/source-twilio/components.py', contentHash: 'twilio-components', language: 'python' },
        { path: 'airbyte-integrations/connectors/source-twilio/unit_tests/test_streams.py', contentHash: 'twilio-streams', language: 'python' },
        { path: 'airbyte-integrations/connectors/source-twilio/unit_tests/test_usage_records_404_handling.py', contentHash: 'twilio-usage-tests', language: 'python' }
      ],
      nodes: [
        {
          id: 'twilio-components',
          kind: 'class',
          name: 'TwilioUsageRecordsStateMigration',
          qualifiedName: 'airbyte-integrations/connectors/source-twilio/components.py::TwilioUsageRecordsStateMigration',
          filePath: 'airbyte-integrations/connectors/source-twilio/components.py',
          language: 'python',
          signature: 'class TwilioUsageRecordsStateMigration',
          docstring: 'State migration logic for usage records.',
          calls: ['TwilioStateMigration']
        },
        {
          id: 'twilio-streams',
          kind: 'class',
          name: 'TestIncrementalTwilioStream',
          qualifiedName: 'airbyte-integrations/connectors/source-twilio/unit_tests/test_streams.py::TestIncrementalTwilioStream',
          filePath: 'airbyte-integrations/connectors/source-twilio/unit_tests/test_streams.py',
          language: 'python',
          signature: 'class TestIncrementalTwilioStream',
          docstring: 'test_streams coverage for usage records.',
          calls: ['TwilioUsageRecordsStateMigration']
        },
        {
          id: 'twilio-404',
          kind: 'class',
          name: 'TestUsageRecords404Handling',
          qualifiedName: 'airbyte-integrations/connectors/source-twilio/unit_tests/test_usage_records_404_handling.py::TestUsageRecords404Handling',
          filePath: 'airbyte-integrations/connectors/source-twilio/unit_tests/test_usage_records_404_handling.py',
          language: 'python',
          signature: 'class TestUsageRecords404Handling',
          docstring: 'usage_records 404 handling coverage.',
          calls: ['TwilioUsageRecordsStateMigration']
        }
      ]
    };
    const mixedEngine = new TopoSemanticQueryEngine('/tmp/project', {
      dependencies: {
        readSnapshot: () => mixedSnapshot,
        vectorSearch: async () => {
          vectorCalls += 1;
          return vectorResults;
        },
        listVectorDocuments: () => storedDocuments,
        readFreshness: () => freshness({ entries: [], fresh: 0, total: 0 }),
        relevanceScorer: neutralRelevanceScorer()
      }
    });

    const capsule = await mixedEngine.query('TwilioUsageRecordsStateMigration usage_records test_usage_records_404_handling test_streams TwilioStateMigration', { topk: 3 });

    expect(vectorCalls).toBe(0);
    expect(capsule.route).toBe('graph-first');
    expect(capsule.nodes[0]?.nodeId).toBe('twilio-components');
    expect(capsule.nodes.map((node) => node.nodeId)).toEqual(expect.arrayContaining(['twilio-404', 'twilio-streams']));
  });

  test('path-and-symbol bundles prioritize nested member nodes over enclosing classes', async () => {
    const nestedSnapshot: CodeGraphSnapshot = {
      projectPath: '/tmp/project',
      files: [
        {
          path: 'superset/security/guest_token.py',
          contentHash: 'hash-guest',
          language: 'python'
        }
      ],
      nodes: [
        {
          id: 'guest-class',
          kind: 'class',
          name: 'GuestUser',
          qualifiedName: 'superset/security/guest_token.py::GuestUser',
          filePath: 'superset/security/guest_token.py',
          language: 'python',
          signature: 'class GuestUser',
          docstring: 'Guest user container.',
          calls: []
        },
        {
          id: 'guest-init',
          kind: 'method',
          name: '__init__',
          qualifiedName: 'superset/security/guest_token.py::GuestUser::__init__',
          filePath: 'superset/security/guest_token.py',
          language: 'python',
          signature: 'def __init__(self, user_id: int) -> None',
          docstring: 'Initializes the guest user container.',
          calls: []
        },
        {
          id: 'guest-audit',
          kind: 'function',
          name: 'build_guest_token_audit_payload',
          qualifiedName: 'superset/security/guest_token.py::build_guest_token_audit_payload',
          filePath: 'superset/security/guest_token.py',
          language: 'python',
          signature: 'def build_guest_token_audit_payload(user_id: int) -> dict[str, unknown]',
          docstring: 'Builds guest token audit payloads.',
          calls: []
        }
      ]
    };
    const nestedEngine = new TopoSemanticQueryEngine('/tmp/project', {
      dependencies: {
        readSnapshot: () => nestedSnapshot,
        vectorSearch: async () => [],
        listVectorDocuments: () => [],
        readFreshness: () => freshness({ entries: [], fresh: 0, pending: 0, stale: 0, failed: 0, total: 0 })
      }
    });

    const capsule = await nestedEngine.query('superset/security/guest_token.py GuestUser build_guest_token_audit_payload', { topk: 2 });

    expect(capsule.nodes.map((node) => node.nodeId)).toEqual(['guest-init', 'guest-audit']);
  });

  test('path-and-symbol bundles also prioritize class-qualified members over enclosing classes', async () => {
    const nestedSnapshot: CodeGraphSnapshot = {
      projectPath: '/tmp/project',
      files: [
        {
          path: 'superset/security/guest_token.py',
          contentHash: 'hash-guest',
          language: 'python'
        }
      ],
      nodes: [
        {
          id: 'guest-class',
          kind: 'class',
          name: 'GuestUser',
          qualifiedName: 'GuestUser',
          filePath: 'superset/security/guest_token.py',
          language: 'python',
          signature: 'class GuestUser',
          docstring: 'Guest user container.',
          calls: []
        },
        {
          id: 'guest-init',
          kind: 'method',
          name: '__init__',
          qualifiedName: 'GuestUser::__init__',
          filePath: 'superset/security/guest_token.py',
          language: 'python',
          signature: 'def __init__(self, user_id: int) -> None',
          docstring: 'Initializes the guest user container.',
          calls: []
        }
      ]
    };
    const nestedEngine = new TopoSemanticQueryEngine('/tmp/project', {
      dependencies: {
        readSnapshot: () => nestedSnapshot,
        vectorSearch: async () => [],
        listVectorDocuments: () => [],
        readFreshness: () => freshness({ entries: [], fresh: 0, pending: 0, stale: 0, failed: 0, total: 0 })
      }
    });

    const capsule = await nestedEngine.query('superset/security/guest_token.py GuestUser', { topk: 1 });

    expect(capsule.nodes.map((node) => node.nodeId)).toEqual(['guest-init']);
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
      graphExactMultiplier: 2,
      callProximityMultiplier: 1.8
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
