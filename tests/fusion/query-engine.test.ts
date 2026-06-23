import { describe, expect, test } from 'vitest';

import { FUSION_RANKING_POLICY, TopoSemanticQueryEngine, compareFusionNodes, routeWeight, zvecFilterFor } from '../../src/fusion/query-engine.js';
import type { FusionNode } from '../../src/fusion/query-engine.js';
import type { FusionCompressionAdapter } from '../../src/compression/fusion-compressor.js';
import type { FreshnessSnapshot } from '../../src/freshness/freshness-gate.js';
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

describe('Phase 2 TopoSemanticQueryEngine', () => {
  test('returns graph, vector, and fts evidence for token validation', async () => {
    const capsule = await engine().query('token validation', { topk: 5 });
    const validate = capsule.nodes.find((node) => node.nodeId === 'node-validate');
    expect(validate?.sources).toEqual(expect.arrayContaining(['graph', 'vector', 'fts']));
    expect(capsule.freshness.fresh).toBe(2);
  });

  test('surfaces sibling file symbols for shared-file registry queries', async () => {
    const registrySnapshot: CodeGraphSnapshot = {
      projectPath: '/tmp/project',
      files: [
        { path: 'src/mcp/tool-registry.ts', contentHash: 'hash-registry', language: 'typescript' }
      ],
      nodes: [
        {
          id: 'node-semantic-search',
          kind: 'function',
          name: 'zincgraph_semantic_search',
          qualifiedName: 'zincgraph_semantic_search',
          filePath: 'src/mcp/tool-registry.ts',
          language: 'typescript',
          signature: 'function zincgraph_semantic_search(): void',
          docstring: 'semantic search registry entry',
          calls: []
        },
        {
          id: 'node-dedup-check',
          kind: 'function',
          name: 'zincgraph_dedup_check',
          qualifiedName: 'zincgraph_dedup_check',
          filePath: 'src/mcp/tool-registry.ts',
          language: 'typescript',
          signature: 'function zincgraph_dedup_check(): void',
          docstring: 'dedup registry entry',
          calls: []
        },
        {
          id: 'node-list-tools',
          kind: 'function',
          name: 'listZincgraphTools',
          qualifiedName: 'listZincgraphTools',
          filePath: 'src/mcp/tool-registry.ts',
          language: 'typescript',
          signature: 'function listZincgraphTools(): void',
          docstring: 'registry helper',
          sourceSnippet: [
            "codeGraphTool('zincgraph_explore', 'Explore code with upstream CodeGraph source/call-path context.', {",
            "  query: QUERY_PROPERTY,",
            "  project: PROJECT_PROPERTY,",
            "  maxFiles: { type: 'number', description: 'Maximum files of source context.' }",
            "}, ['query']),",
            "fusionTool('zincgraph_semantic_search', 'Run Zincgraph fusion semantic search.', {",
            "  query: QUERY_PROPERTY,",
            "  project: PROJECT_PROPERTY,",
            "  topk: TOPK_PROPERTY,",
            "  maxTokens: { type: 'number', description: 'Context token budget.' }",
            "}, ['query']),",
            "fusionTool('zincgraph_dedup_check', 'Check whether proposed behavior duplicates existing code semantically.', {",
            "  describe: { type: 'string', description: 'Behavior/functionality to add.' },",
            "  project: PROJECT_PROPERTY,",
            "  threshold: { type: 'number', description: 'Similarity threshold between 0 and 1.' },",
            "  topk: TOPK_PROPERTY",
            "}, ['describe'])"
          ].join('\n'),
          calls: []
        }
      ]
    };
    const registryEngine = new TopoSemanticQueryEngine('/tmp/project', {
      dependencies: {
        readSnapshot: () => registrySnapshot,
        vectorSearch: async () => [],
        listVectorDocuments: () => [],
        readFreshness: () => freshness()
      }
    });

    const capsule = await registryEngine.query('semantic search tool registry', { topk: 3 });
    const registryNode = capsule.nodes.find((node) => node.nodeId === 'node-list-tools');
    expect(registryNode?.fileSymbols).toEqual(expect.arrayContaining(['zincgraph_semantic_search', 'zincgraph_dedup_check']));
    expect(registryNode?.fileSymbols?.slice(0, 2)).toEqual(expect.arrayContaining(['zincgraph_semantic_search', 'zincgraph_dedup_check']));
  });

  test('extracts behavior anchors from source snippets into file symbols', async () => {
    const behaviorSnapshot: CodeGraphSnapshot = {
      projectPath: '/tmp/project',
      files: [
        { path: 'src/behavior/dedup-check.ts', contentHash: 'hash-dedup', language: 'typescript' },
        { path: 'src/behavior/graph-review.ts', contentHash: 'hash-review', language: 'typescript' }
      ],
      nodes: [
        {
          id: 'node-dedup-helper',
          kind: 'function',
          name: 'dedupHelper',
          qualifiedName: 'dedupHelper',
          filePath: 'src/behavior/dedup-check.ts',
          language: 'typescript',
          signature: 'function dedupHelper(): void',
          docstring: 'helper',
          sourceSnippet: [
            'export function runDedupCheck(options: RunDedupCheckOptions): Promise<DedupCheckResult> {',
            '  return checker.check(request);',
            '}'
          ].join('\n'),
          calls: []
        },
        {
          id: 'node-review-helper',
          kind: 'function',
          name: 'reviewHelper',
          qualifiedName: 'reviewHelper',
          filePath: 'src/behavior/graph-review.ts',
          language: 'typescript',
          signature: 'function reviewHelper(): void',
          docstring: 'helper',
          sourceSnippet: [
            'export function analyzeGraphReview(options: AnalyzeGraphReviewOptions): GraphReviewResult {',
            '  return { projectPath: options.projectPath };',
            '}'
          ].join('\n'),
          calls: []
        }
      ]
    };
    const behaviorEngine = new TopoSemanticQueryEngine('/tmp/project', {
      dependencies: {
        readSnapshot: () => behaviorSnapshot,
        vectorSearch: async () => [],
        listVectorDocuments: () => [],
        readFreshness: () => freshness()
      }
    });

    const capsule = await behaviorEngine.query('semantic dedup graph review', { topk: 5 });
    const dedupNode = capsule.nodes.find((node) => node.filePath === 'src/behavior/dedup-check.ts');
    const reviewNode = capsule.nodes.find((node) => node.filePath === 'src/behavior/graph-review.ts');
    expect(dedupNode?.fileSymbols).toEqual(expect.arrayContaining(['runDedupCheck']));
    expect(reviewNode?.fileSymbols).toEqual(expect.arrayContaining(['analyzeGraphReview']));
  });

  test('includes stage-level timing diagnostics', async () => {
    const capsule = await engine().query('token validation', { topk: 5 });
    expect(capsule.diagnostics?.timingsMs.snapshotRead).toBeGreaterThanOrEqual(0);
    expect(capsule.diagnostics?.timingsMs.vectorDocumentLoad).toBeGreaterThanOrEqual(0);
    expect(capsule.diagnostics?.timingsMs.vectorSearch).toBeGreaterThanOrEqual(0);
    expect(capsule.diagnostics?.timingsMs.compression).toBeGreaterThanOrEqual(0);
    expect(capsule.diagnostics?.candidateCounts.output).toBe(capsule.nodes.length);
    expect(capsule.diagnostics?.fullJsonBytes).toBeGreaterThan(0);
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

  test('broad structural query keeps behavior command files ahead of registry noise', async () => {
    const broadSnapshot: CodeGraphSnapshot = {
      projectPath: '/tmp/project',
      files: [
        { path: 'src/behavior/dedup-check.ts', contentHash: 'dedup', language: 'typescript' },
        { path: 'src/behavior/graph-review.ts', contentHash: 'review', language: 'typescript' },
        { path: 'src/mcp/tool-registry.ts', contentHash: 'registry', language: 'typescript' }
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
          sourceSnippet: 'semantic dedup graph review',
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
          sourceSnippet: 'semantic dedup graph review',
          calls: ['GraphReviewAnalyzer']
        },
        {
          id: 'registry',
          kind: 'function',
          name: 'listZincgraphTools',
          qualifiedName: 'src/mcp/tool-registry.ts::listZincgraphTools',
          filePath: 'src/mcp/tool-registry.ts',
          language: 'typescript',
          signature: 'function listZincgraphTools(): ZincgraphToolDefinition[]',
          sourceSnippet: 'zincgraph semantic search tool registry',
          calls: []
        }
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
    expect(capsule.nodes.findIndex((node) => node.nodeId === 'registry')).toBeGreaterThanOrEqual(2);
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

  test('exact graph-first symbol query beats same-score siblings in earlier files', async () => {
    const exactSnapshot: CodeGraphSnapshot = {
      projectPath: '/tmp/project',
      files: [
        { path: 'src/cli.ts', contentHash: 'cli', language: 'typescript' },
        { path: 'src/freshness/auto-sync.ts', contentHash: 'auto-sync', language: 'typescript' }
      ],
      nodes: [
        {
          id: 'sibling',
          kind: 'interface',
          name: 'RunAutoSyncOnceOptions',
          qualifiedName: 'src/cli.ts::RunAutoSyncOnceOptions',
          filePath: 'src/cli.ts',
          language: 'typescript',
          signature: 'interface RunAutoSyncOnceOptions { }',
          docstring: 'options for runAutoSyncOnce',
          calls: []
        },
        {
          id: 'exact',
          kind: 'function',
          name: 'runAutoSyncOnce',
          qualifiedName: 'src/freshness/auto-sync.ts::runAutoSyncOnce',
          filePath: 'src/freshness/auto-sync.ts',
          language: 'typescript',
          signature: 'function runAutoSyncOnce(): void',
          docstring: 'runs auto sync once',
          calls: []
        }
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
    const capsule = await exactEngine.query('runAutoSyncOnce', { topk: 2 });
    expect(capsule.route).toBe('graph-first');
    expect(capsule.nodes.map((node) => node.nodeId)).toEqual(['exact', 'sibling']);
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
