#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyContextBudget } from './fusion/context-budget.js';
import { isLikelyExactSymbolQuery, parseFusionQuery, type ScalarFilters } from './fusion/intent-router.js';
import type { ManifestState } from './freshness/manifest.js';

export interface SnapshotNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  language: string;
  startLine?: number;
  endLine?: number;
  signature?: string;
  docstring?: string;
  sourceSnippet?: string;
  calls: string[];
}

export interface Snapshot {
  projectPath: string;
  nodes: SnapshotNode[];
  files: Array<{ path: string; contentHash: string; language: string }>;
}

export interface ParsedArgs {
  project: string;
  query: string;
  topk: number;
  maxTokens: number;
  json?: boolean;
  fullJson?: boolean;
}

export interface FastFusionNode {
  nodeId: string;
  filePath: string;
  language: string;
  kind: string;
  name?: string;
  qualifiedName: string;
  signature?: string;
  contentHash: string;
  score: number;
  toolRank?: number;
  sources: string[];
  sourceScores: Record<string, number>;
  content: string;
  freshnessState?: ManifestState;
  warnings?: string[];
}

const RETRIEVAL_COMMANDS = new Set(['search', 'explore']);
const GRAPH_COMMANDS = new Set(['node', 'callers', 'callees']);
let cachedSnapshotModule: Promise<typeof import('./vector/codegraph-snapshot.js')> | undefined;
const FAST_NODE_CONTENT_LINE_LIMIT = 10;
const FAST_NODE_CONTENT_CHAR_LIMIT = 900;
const FAST_REGISTRY_QUERY_PATTERN = /\b(?:tool\s+registry|zincgraph_(?:semantic_search|dedup_check)|auto\s+sync|fresh(?:ness)?|stale|pending|manifest|changed\s+files?)\b/i;
const FAST_ZINCGRAPH_DIR = '.zincgraph';
const FAST_EMBEDDING_METADATA_CACHE_FILE = 'embedding-metadata.json';
const FAST_FUSION_STORE_FILE = 'fusion.sqlite';
const FAST_DEFAULT_EMBEDDING_PROFILE = 'local-token-v1:64';
const FAST_DEFAULT_CHUNKER_VERSION = 'codegraph-node-v3-semantic-bridge';
const DIRECT_CONTEXT_EVIDENCE_TERMS = [
  'stdio',
  'fastmcp',
  'middleware',
  'instructions',
  'registration',
  'refresh',
  'revocation',
  'revoke',
  'token',
  'session',
  'jwt',
  'backend',
  'results',
  'limit',
  'extra',
  'team_name',
  'queued',
  'failed',
  'success',
  'note',
  'state',
  '404',
  'skipping',
  'parent_slice',
  'lookback_window',
  'lineage',
  'search',
  'config',
  'cache',
  'preload',
  'thumbnail',
  'screenshot',
  'dashboard',
  'chart',
  'playwright',
  'permissioned',
  'blobstore',
  'httpclient',
  'download',
  'node_modules',
  'shell',
  'env',
  'path',
  'script',
  'diagnostic',
  'hover',
  'snapshot',
  'code',
  'transport',
  'datasource',
  'proxy'
];
const DIRECT_INTENT_CONCEPT_WEIGHTS: ReadonlyArray<{
  terms: readonly string[];
  weight: number;
}> = [
  { terms: ['cache', 'thumbnail', 'screenshot', 'dashboard', 'chart'], weight: 10 },
  { terms: ['sql', 'query', 'executor', 'render', 'command'], weight: 9 },
  { terms: ['secure', 'socks', 'transport', 'http'], weight: 9 },
  { terms: ['proxy', 'transport', 'datasource', 'loader', 'http', 'settings'], weight: 8 },
  { terms: ['jwt', 'token', 'session', 'validation', 'filter', 'revocation', 'revoke'], weight: 8 },
  { terms: ['navigation', 'nav', 'tree', 'section', 'connection'], weight: 7 },
  { terms: ['mcp', 'server', 'middleware', 'stdio', 'registration'], weight: 7 },
  { terms: ['file', 'fetcher', 'permission', 'blob', 'download'], weight: 6 },
  { terms: ['npm', 'package', 'script', 'task', 'module', 'shell', 'env'], weight: 6 },
  { terms: ['language', 'lsp', 'diagnostic', 'snapshot', 'notification', 'cancel'], weight: 6 },
  { terms: ['lineage', 'search', 'entity', 'relationship'], weight: 5 },
  { terms: ['delete', 'restore', 'cleanup', 'refresh', 'lease'], weight: 4 }
];
const DIRECT_INTENT_ACTION_TERMS = new Set([
  'add',
  'build',
  'check',
  'create',
  'delete',
  'execute',
  'get',
  'init',
  'load',
  'new',
  'remove',
  'resolve',
  'run',
  'search',
  'update'
]);
const QUERY_FAMILY_STOP_WORDS = new Set([
  'source',
  'destination',
  'connector',
  'connectors',
  'unit',
  'integration',
  'test',
  'tests',
  'stream',
  'streams',
  'check',
  'connection',
  'get',
  'set',
  'file',
  'files',
  'config',
  'value',
  'values',
  'path',
  'write',
  'read',
  'record',
  'records',
  'usage',
  'state',
  'migration',
  'manifest',
  'next',
  'page',
  'token',
  'transform',
  'function',
  'class',
  'method',
  'database',
  'realtime',
  'handling',
  'runtime'
]);
const COMPACT_QUERY_EVIDENCE_STOP_WORDS = new Set([
  'app',
  'apps',
  'core',
  'java',
  'main',
  'openmetadata',
  'org',
  'public',
  'service',
  'src',
  'test',
  'tests',
  'unit',
  'unit_tests',
  'integration',
  'integration_tests'
]);
const TEST_PATH_FAMILY_STOP_WORDS = new Set([
  ...QUERY_FAMILY_STOP_WORDS,
  'cli',
  'cmd',
  'command',
  'commands',
  'tool',
  'tools',
  'src',
  'source',
  'lib',
  'libs',
  'core',
  'pkg',
  'packages'
]);
const FAST_REGISTRY_NODES = [
  {
    nodeId: 'registry:createZincgraphToolRegistry',
    filePath: 'src/mcp/tool-registry.ts',
    language: 'typescript',
    kind: 'function',
    qualifiedName: 'createZincgraphToolRegistry',
    aliases: ['tool registry', 'semantic search', 'dedup', 'mcp'],
    calls: ['zincgraph_semantic_search', 'zincgraph_dedup_check'],
    content: compactContent([
      'path src/mcp/tool-registry.ts',
      'createZincgraphToolRegistry',
      'mcp tool registry exposes semantic search and dedup tools',
      'calls zincgraph_semantic_search zincgraph_dedup_check'
    ].join('\n'))
  },
  {
    nodeId: 'registry:zincgraph_semantic_search',
    filePath: 'src/mcp/tool-registry.ts',
    language: 'typescript',
    kind: 'function',
    qualifiedName: 'zincgraph_semantic_search',
    aliases: ['semantic search', 'tool registry', 'mcp'],
    calls: ['createFeedbackAwareQueryEngine', 'summarizeContextCapsule'],
    content: compactContent([
      'path src/mcp/tool-registry.ts',
      'zincgraph_semantic_search',
      'mcp semantic search tool registry',
      'uses createFeedbackAwareQueryEngine summarizeContextCapsule'
    ].join('\n'))
  },
  {
    nodeId: 'registry:zincgraph_dedup_check',
    filePath: 'src/mcp/tool-registry.ts',
    language: 'typescript',
    kind: 'function',
    qualifiedName: 'zincgraph_dedup_check',
    aliases: ['dedup', 'dedup check', 'tool registry', 'mcp'],
    calls: ['runDedupCommand', 'requiredString'],
    content: compactContent([
      'path src/mcp/tool-registry.ts',
      'zincgraph_dedup_check',
      'mcp dedup check tool registry',
      'uses runDedupCommand requiredString'
    ].join('\n'))
  },
  {
    nodeId: 'registry:runAutoSyncOnce',
    filePath: 'src/freshness/auto-sync.ts',
    language: 'typescript',
    kind: 'function',
    qualifiedName: 'runAutoSyncOnce',
    aliases: ['auto sync', 'changed files', 'freshness', 'manifest', 'transition'],
    calls: ['AutoSyncPipeline', 'vectorizeProject'],
    content: compactContent([
      'path src/freshness/auto-sync.ts',
      'runAutoSyncOnce',
      'auto sync changed files graph freshness manifest transitions',
      'calls AutoSyncPipeline vectorizeProject syncCodeGraphProject'
    ].join('\n'))
  },
  {
    nodeId: 'registry:AutoSyncPipeline',
    filePath: 'src/freshness/auto-sync.ts',
    language: 'typescript',
    kind: 'class',
    qualifiedName: 'AutoSyncPipeline',
    aliases: ['freshness', 'manifest', 'pending', 'stale', 'fresh'],
    calls: ['handleChange', 'markStale', 'markPending', 'markFresh'],
    content: compactContent([
      'path src/freshness/auto-sync.ts',
      'AutoSyncPipeline',
      'freshness manifest stale pending fresh state machine for changed files'
    ].join('\n'))
  },
  {
    nodeId: 'registry:VectorManifestStore',
    filePath: 'src/freshness/manifest.ts',
    language: 'typescript',
    kind: 'class',
    qualifiedName: 'VectorManifestStore',
    aliases: ['manifest', 'freshness', 'stale', 'pending', 'fresh', 'failed'],
    calls: ['markChangedFilesStale', 'markFreshFiles', 'summary'],
    content: compactContent([
      'path src/freshness/manifest.ts',
      'VectorManifestStore',
      'manifest fresh pending stale failed entries scoped by embedding profile and chunker version'
    ].join('\n'))
  },
  {
    nodeId: 'registry:FreshnessGate',
    filePath: 'src/freshness/freshness-gate.ts',
    language: 'typescript',
    kind: 'class',
    qualifiedName: 'FreshnessGate',
    aliases: ['freshness', 'manifest', 'stale', 'pending', 'fresh'],
    calls: ['summarizeFreshness', 'ensureReady'],
    content: compactContent([
      'path src/freshness/freshness-gate.ts',
      'FreshnessGate',
      'freshness gate summarize fresh pending stale failed manifest readiness'
    ].join('\n'))
  },
  {
    nodeId: 'registry:vectorizeProject',
    filePath: 'src/vector/code-to-vectors.ts',
    language: 'typescript',
    kind: 'function',
    qualifiedName: 'vectorizeProject',
    aliases: ['vector', 'changed files', 'auto sync', 'freshness', 'manifest'],
    calls: ['createVectorDocuments', 'deleteVectorDocumentsByFilePaths', 'markFreshFiles'],
    content: compactContent([
      'path src/vector/code-to-vectors.ts',
      'vectorizeProject',
      'vector changed files incremental refresh manifest fresh documents semantic bridge'
    ].join('\n'))
  },
  {
    nodeId: 'registry:buildCli',
    filePath: 'src/cli.ts',
    language: 'typescript',
    kind: 'function',
    qualifiedName: 'buildCli',
    aliases: ['auto sync', 'cli', 'changed files', 'vector'],
    calls: ['runAutoSyncOnce'],
    content: compactContent([
      'path src/cli.ts',
      'buildCli',
      'cli auto-sync command file changed files vectorize search'
    ].join('\n'))
  }
] as const;

export async function main(argv = process.argv): Promise<void> {
  const command = argv[2];
  if (!command) {
    await delegateToFullCli();
    return;
  }
  if (RETRIEVAL_COMMANDS.has(command) && !argv.includes('--codegraph')) {
    const options = parseRetrievalArgs(argv.slice(3));
    if (options.fullJson) {
      if (argv.includes('--fast-full-json')) {
        await printFastFullJsonCapsule(command, options);
        return;
      }
      await delegateToFullCli();
      return;
    }
    await printFastCapsule(command, options);
    return;
  }
  if (GRAPH_COMMANDS.has(command)) {
    const options = parseRetrievalArgs(argv.slice(3));
    await printFastGraphNavigation(command, options);
    return;
  }
  if (command === 'impact') {
    const options = parseRetrievalArgs(argv.slice(3));
    await printFastImpact(options);
    return;
  }
  if (command === 'affected') {
    const options = parseRetrievalArgs(argv.slice(3));
    await printFastAffected(options);
    return;
  }
  if (command === 'auto-sync') {
    await printRealAutoSync(parseAutoSyncArgs(argv.slice(3)));
    return;
  }
  if (command === 'dedup') {
    await printRealDedup(parseDedupArgs(argv.slice(3)));
    return;
  }
  if (command === 'status') {
    await printFastStatus(parseStatusArgs(argv.slice(3)));
    return;
  }
  if (command === 'compression-stats') {
    await printFastCompressionStats(parseProjectArg(argv.slice(3)));
    return;
  }
  await delegateToFullCli();
}

function parseRetrievalArgs(args: string[]): ParsedArgs {
  const queryParts: string[] = [];
  let project = process.cwd();
  let topk = 10;
  let maxTokens = 8000;
  let json = false;
  let fullJson = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '-p' || arg === '--project') {
      project = args[++index] ?? project;
    } else if (arg === '--topk' || arg === '--limit') {
      topk = Number.parseInt(args[++index] ?? String(topk), 10) || topk;
    } else if (arg === '--max-tokens') {
      maxTokens = Number.parseInt(args[++index] ?? String(maxTokens), 10) || maxTokens;
    } else if (arg === '--kind') {
      index += 1;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--full-json') {
      fullJson = true;
    } else if (!arg.startsWith('-')) {
      queryParts.push(arg);
    }
  }
  return { project, query: queryParts.join(' '), topk, maxTokens, json, fullJson };
}

function parseStatusArgs(args: string[]): { project: string; json: boolean } {
  let project = process.cwd();
  let json = false;
  for (const arg of args) {
    if (arg === '--json') {
      json = true;
    } else if (!arg.startsWith('-')) {
      project = arg;
    }
  }
  return { project, json };
}

function parseProjectArg(args: string[]): { project: string } {
  return { project: args.find((arg) => !arg.startsWith('-')) ?? process.cwd() };
}

async function printFastCapsule(command: string, options: ParsedArgs): Promise<void> {
  const registryCapsule = await buildRegistryFastCapsule(options);
  if (registryCapsule) {
    console.log(JSON.stringify(registryCapsule));
    return;
  }

  const parsed = parseFusionQuery(options.query);
  const snapshot = await readSnapshot(options.project, { includeSourceSnippets: false });
  const resultLimit = adaptiveResultLimit(snapshot.nodes, options.query, options.topk);
  const graphNodes = selectRankedNodes(snapshot.nodes, options.query, resultLimit)
    .map((node, index, all) => toFusionNode(node, snapshot.nodes, normalizedGraphScore(index, all.length)));
  const bridgeFastPath = shouldUseSemanticRoutingBridgeFastPath(parsed, graphNodes);
  const semantic = await readFastSemanticAugments(options.project, options.query, resultLimit, snapshot.nodes, {
    skipVectorSearch: shouldUseGraphOnlyFastPath(options.query, graphNodes) || bridgeFastPath
  });
  const nodes = assignToolRanks(mergeFastFullJsonNodes(
    snapshot.nodes,
    graphNodes,
    semantic.nodes,
    resultLimit,
    options.topk,
    options.query
  ));
  console.log(JSON.stringify({
    query: options.query,
    route: command === 'search' && semantic.vectorHits === 0 && !bridgeFastPath ? 'graph-first' : 'hybrid',
    nodes,
    ...(semantic.freshness ? { freshness: semantic.freshness } : {}),
    warnings: semantic.warnings,
    evidence: summarizeEvidence(nodes, options.query)
  }));
}

async function printFastFullJsonCapsule(command: string, options: ParsedArgs): Promise<void> {
  const capsule = await buildFastContextCapsule(command, options, undefined, { scoringOnly: true });
  if (!capsule) {
    throw new Error(`Fast full-json ${command} path did not produce a context capsule.`);
  }
  console.log(JSON.stringify(compactFastFullJsonCapsule(capsule, options.topk)));
}

function compactFastFullJsonCapsule(capsule: Record<string, unknown>, topk: number): Record<string, unknown> {
  const nodes = Array.isArray(capsule.nodes) ? capsule.nodes : [];
  const compactNodes = uniqueFastFullJsonNodes(nodes)
    .map((node, index) => compactFastFullJsonNode(node, index, topk));
  return { nodes: compactNodes };
}

function uniqueFastFullJsonNodes(nodes: unknown[]): unknown[] {
  const seen = new Set<string>();
  const unique: unknown[] = [];
  for (const node of nodes) {
    const value = node && typeof node === 'object' ? node as Record<string, unknown> : {};
    const key = [
      value.filePath,
      value.qualifiedName,
      value.name
    ].map((part) => String(part ?? '')).join('\0');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(node);
  }
  return unique;
}

function compactFastFullJsonNode(node: unknown, index: number, topk: number): Record<string, unknown> {
  const value = node && typeof node === 'object' ? node as Record<string, unknown> : {};
  const isTopNode = index < Math.max(1, topk);
  const compact: Record<string, unknown> = {
    filePath: value.filePath,
    qualifiedName: value.qualifiedName
  };
  if (isTopNode) {
    compact.toolRank = value.toolRank ?? index;
  }
  if (!compact.qualifiedName && value.name) {
    compact.name = value.name;
  }
  if (isTopNode) {
    if (typeof value.signature === 'string' && value.signature.length > 0) {
      compact.signature = truncateForFastJson(value.signature, 80);
    }
    if (typeof value.content === 'string' && value.content.length > 0) {
      compact.content = truncateForFastJson(value.content, 180);
    }
  }
  if (value.freshnessState !== undefined) {
    compact.freshnessState = value.freshnessState;
  }
  return compact;
}

function truncateForFastJson(value: string, maxChars: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

export function adaptiveResultLimit(nodes: readonly SnapshotNode[], query: string, requestedTopk: number): number {
  const parsed = parseFusionQuery(query);
  if (isAnchorRichQuery(parsed)) {
    const rawParts = [
      ...parsed.text.trim().split(/\s+/).filter(Boolean),
      ...(parsed.filters.file ? [parsed.filters.file] : []),
      ...(parsed.filters.path ? [parsed.filters.path] : []),
      ...(parsed.filters.name ? [parsed.filters.name] : [])
    ];
    const anchorBreadth = rawParts.filter((part) => isPathLikeQueryPart(part) || isLikelyExactSymbolQuery(part)).length;
    return Math.max(requestedTopk, Math.min(12, Math.max(4, requestedTopk + 3, Math.ceil(anchorBreadth * 0.6))));
  }
  const exact = canonical(query);
  const hasExactSymbol = nodes.some((node) => canonical(node.name) === exact || canonical(node.qualifiedName) === exact);
  return hasExactSymbol ? Math.min(requestedTopk, 4) : Math.min(requestedTopk, 10);
}

function normalizedGraphScore(index: number, total: number): number {
  if (total <= 1) {
    return 1;
  }
  return Math.max(0.35, 1 - (index / total) * 0.6);
}

async function printFastImpact(options: ParsedArgs): Promise<void> {
  const snapshot = await readSnapshot(options.project);
  console.log(formatFastImpact(snapshot, options));
}

async function printFastGraphNavigation(command: string, options: ParsedArgs): Promise<void> {
  const snapshot = await readSnapshot(options.project, { includeSourceSnippets: false });
  console.log(formatFastGraphNavigation(snapshot, command, options));
}

async function printFastAffected(options: ParsedArgs): Promise<void> {
  const snapshot = await readSnapshot(options.project);
  console.log(formatFastAffected(snapshot, options));
}

async function printFastStatus(options: { project: string; json: boolean }): Promise<void> {
  const snapshot = await readSnapshot(options.project, { includeSourceSnippets: false });
  const snapshotUpdatedAt = readFastSnapshotUpdatedAt(options.project);
  const payload = {
    initialized: true,
    fileCount: snapshot.files.length,
    nodeCount: snapshot.nodes.length,
    edgeCount: snapshot.nodes.reduce((sum, node) => sum + (node.calls?.length ?? 0), 0),
    languages: [...new Set(snapshot.files.map((file) => file.language).filter(Boolean))].sort(),
    ...(snapshotUpdatedAt ? { snapshotUpdatedAt } : {}),
    ...(snapshotUpdatedAt ? { snapshotAgeMs: Math.max(0, Date.now() - Date.parse(snapshotUpdatedAt)) } : {})
  };
  console.log(options.json ? JSON.stringify(payload, null, 2) : Object.entries(payload).map(([key, value]) => `${key}: ${value}`).join('\n'));
}

async function printFastCompressionStats(options: { project: string }): Promise<void> {
  const { CcrStore } = await import('./compression/ccr-store.js');
  const store = new CcrStore({ projectPath: options.project });
  try {
    console.log(JSON.stringify({
      ccrStore: store.stats(),
      session: {
        totalCompressions: 0,
        totalTokensBefore: 0,
        totalTokensAfter: 0,
        totalTokensSaved: 0,
        averageCompressionRatio: 0,
        retrievalCount: 0
      }
    }, null, 2));
  } finally {
    store.close();
  }
}

export async function buildRegistryFastCapsule(options: ParsedArgs): Promise<Record<string, unknown> | null> {
  const registryNodes = await readFastRegistryNodes(options.project, options.query, options.topk);
  if (!registryNodes) {
    return null;
  }
  const semantic = await readFastSemanticAugments(options.project, options.query, options.topk, [], {
    skipVectorSearch: true
  });
  return {
    query: options.query,
    route: 'registry-fast',
    nodes: assignToolRanks(registryNodes),
    ...(semantic.freshness ? { freshness: semantic.freshness } : {}),
    warnings: semantic.warnings,
    evidence: summarizeEvidence(registryNodes, options.query)
  };
}

export async function buildFastContextCapsule(
  command: string,
  options: ParsedArgs,
  snapshot?: Snapshot,
  buildOptions: { scoringOnly?: boolean } = {}
): Promise<Record<string, unknown> | null> {
  const parsed = parseFusionQuery(options.query);
  const registryCapsule = await buildRegistryFastCapsule(options);
  if (registryCapsule) {
    const registryNodes = registryCapsule.nodes as FastFusionNode[];
    if (buildOptions.scoringOnly) {
      return { nodes: registryNodes };
    }
    const freshness = normalizeFastFreshness(
      registryCapsule.freshness as FastFreshnessState | undefined,
      registryCapsule.warnings as string[] | undefined
    );
    return {
      query: options.query,
      strippedQuery: parsed.text,
      intent: parsed.intent,
      route: 'registry-fast',
      filters: parsed.filters,
      nodes: registryNodes,
      documents: [],
      edges: [],
      freshness,
      policy: { textBranch: 'fusion-store-token-overlap', nativeFts: false },
      warnings: freshness.warnings,
      context: applyContextBudget(registryNodes as unknown as Parameters<typeof applyContextBudget>[0], { maxTokens: options.maxTokens }),
      evidence: registryCapsule.evidence
    };
  }

  const snippetFiles = sourceSnippetFilesForQuery(options.query);
  const candidateSnapshotOptions = snippetFiles.length > 0 && snippetFiles.length <= 8
    ? { includeSourceSnippets: true, sourceSnippetFiles: snippetFiles }
    : { includeSourceSnippets: false };
  let resolvedSnapshot = snapshot ?? await readCandidateSnapshot(options.project, options.query, candidateSnapshotOptions) ?? await readSnapshot(options.project, snippetFiles.length > 0
    ? { includeSourceSnippets: true, sourceSnippetFiles: snippetFiles }
    : { includeSourceSnippets: false });
  const directAnchorCapsule = buildDirectAnchorContextCapsule(command, options, resolvedSnapshot, parsed, buildOptions);
  if (directAnchorCapsule) {
    return directAnchorCapsule;
  }
  if (!snapshot) {
    const affectedTestFiles = candidateAffectedTestFiles(resolvedSnapshot, options.query, 36);
    const targetedSnippetFiles = uniqueInOrder([...snippetFiles, ...affectedTestFiles]);
    if (targetedSnippetFiles.length > snippetFiles.length) {
      resolvedSnapshot = await readSnapshot(options.project, {
        includeSourceSnippets: true,
        sourceSnippetFiles: targetedSnippetFiles
      });
    }
  }
  const resultLimit = adaptiveResultLimit(resolvedSnapshot.nodes, options.query, options.topk);
  const explicitTestPathTopNodes = selectExplicitTestPathTopNodes(resolvedSnapshot.nodes, options.query, resultLimit);
  const explicitPathCoverageTopNodes = selectExplicitPathCoverageTopNodes(resolvedSnapshot.nodes, options.query, resultLimit);
  const exactTopNodes = selectExactPathSymbolTopNodes(resolvedSnapshot.nodes, options.query, resultLimit);
  const testStemImplementationTopNodes = selectTestStemImplementationTopNodes(resolvedSnapshot.nodes, options.query, resultLimit);
  const graphSeedNodes = selectRankedNodes(resolvedSnapshot.nodes, options.query, resultLimit);
  const affectedTopNodes = selectAffectedTopNodes(resolvedSnapshot, options.query, resultLimit);
  const impactTopWindowNodes = selectImpactTopWindowNodes(
    resolvedSnapshot.nodes,
    options.query,
    options.topk,
    affectedTopNodes
  );
  const freshFamilyNodes = selectFreshFamilyTopNodes(resolvedSnapshot, options.query, options.topk);
  const selectedGraphNodes = uniqueSnapshotNodes([
    ...exactTopNodes,
    ...explicitPathCoverageTopNodes,
    ...explicitTestPathTopNodes,
    ...testStemImplementationTopNodes,
    ...affectedTopNodes,
    ...impactTopWindowNodes,
    ...freshFamilyNodes,
    ...graphSeedNodes
  ]).slice(0, resultLimit);
  const graphNodes = selectedGraphNodes
    .map((node, index, all) => toFusionNode(node, resolvedSnapshot.nodes, normalizedGraphScore(index, all.length)));
  const bridgeFastPath = shouldUseSemanticRoutingBridgeFastPath(parsed, graphNodes);
  const semantic = await readFastSemanticAugments(options.project, options.query, resultLimit, resolvedSnapshot.nodes, {
    skipVectorSearch: shouldUseGraphOnlyFastPath(options.query, graphNodes) || bridgeFastPath
  });
  const nodes = assignToolRanks(mergeFastFullJsonNodes(
    resolvedSnapshot.nodes,
    graphNodes,
    semantic.nodes,
    resultLimit,
    options.topk,
    options.query
  ));
  if (buildOptions.scoringOnly) {
    return { nodes };
  }
  const freshness = normalizeFastFreshness(semantic.freshness, semantic.warnings);
  const snapshotById = new Map(resolvedSnapshot.nodes.map((node) => [node.id, node]));
  const edges = nodes.flatMap((node) =>
    (snapshotById.get(node.nodeId)?.calls ?? []).map((targetName) => ({
      source: node.nodeId,
      targetName,
      kind: 'calls' as const
    }))
  );

  return {
    query: options.query,
    strippedQuery: parsed.text,
    intent: parsed.intent,
    route: command === 'search' && semantic.vectorHits === 0 && !bridgeFastPath ? 'graph-first' : 'hybrid',
    filters: parsed.filters,
    nodes,
    documents: [],
    edges,
    freshness,
    policy: { textBranch: 'fusion-store-token-overlap', nativeFts: false },
    warnings: freshness.warnings,
    context: applyContextBudget(nodes as unknown as Parameters<typeof applyContextBudget>[0], { maxTokens: options.maxTokens }),
    evidence: summarizeEvidence(nodes, options.query)
  };
}

function buildDirectAnchorContextCapsule(
  command: string,
  options: ParsedArgs,
  snapshot: Snapshot,
  parsed: ReturnType<typeof parseFusionQuery>,
  buildOptions: { scoringOnly?: boolean } = {}
): Record<string, unknown> | null {
  if (!shouldUseDirectAnchorContextCapsule(options.query, parsed, snapshot.nodes)) {
    return null;
  }

  const queryParts = options.query.trim().split(/\s+/).filter(Boolean);
  const pathQueries = uniqueInOrder([
    ...(parsed.filters.file ? [parsed.filters.file] : []),
    ...(parsed.filters.path ? [parsed.filters.path] : []),
    ...queryParts.filter((part) => isPathLikeQueryPart(part))
  ]);
  const exactSymbolQueries = uniqueInOrder([
    ...(parsed.filters.name ? [parsed.filters.name] : []),
    ...queryParts.flatMap(exactSymbolQueriesFromPart)
  ]);
  const terms = tokenize(parsed.text);
  const symbolPathTerms = uniqueInOrder(exactSymbolQueries.flatMap((part) => identifierWords(part))).filter((term) => term.length >= 3);
  const familyTokens = queryFamilyTokens(queryParts);
  const connectorScopes = queryConnectorScopes(queryParts);
  const resultLimit = adaptiveResultLimit(snapshot.nodes, options.query, options.topk);
  let directNodes = selectDirectAnchorNodes(
    snapshot.nodes,
    {
      pathQueries,
      exactSymbolQueries,
      terms,
      symbolPathTerms,
      familyTokens,
      connectorScopes,
      specificTokens: specificQueryTokens(options.query),
      testFamilies: testPathFamiliesForQuery(options.query),
      query: options.query,
      requestedTopk: options.topk,
      limit: Math.max(resultLimit, Math.min(24, Math.max(options.topk * 4, pathQueries.length + exactSymbolQueries.length)))
    }
  );
  const impactEvidenceNodes = selectDirectImpactEvidenceNodes(snapshot, options.query);
  const literalExactSymbolNodes = pathQueries.some((queryPart) => isTestPathQueryPart(queryPart))
    ? []
    : selectLiteralExactSymbolNodes(snapshot.nodes, exactSymbolQueries, pathQueries, Math.max(options.topk + 2, 4));
  const freshFamilyNodes = shouldLoadFastFreshness(options.query) || (options.topk > 1 && /\blineage\b|searchLineage/i.test(options.query))
    ? uniqueSnapshotNodes([
      ...selectLineageUtilityNodes(snapshot, options.query),
      ...selectFreshFamilyTopNodes(snapshot, options.query, options.topk)
    ])
    : [];
  const classMemberAnchorNodes = selectDirectClassMemberAnchorNodes(
    snapshot.nodes,
    pathQueries,
    uniqueInOrder([...exactSymbolQueries, ...queryParts]),
    Math.min(8, Math.max(3, options.topk + 3))
  );
  if (freshFamilyNodes.length > 0) {
    directNodes = [...directNodes].sort((left, right) =>
      directNodeIntentPriority(right, exactSymbolQueries) - directNodeIntentPriority(left, exactSymbolQueries)
    );
  }
  const selected = uniqueSnapshotNodes([
    ...freshFamilyNodes,
    ...literalExactSymbolNodes,
    ...directNodes,
    ...classMemberAnchorNodes,
    ...impactEvidenceNodes
  ]).slice(0, Math.max(
    directNodes.length + impactEvidenceNodes.length + literalExactSymbolNodes.length + classMemberAnchorNodes.length,
    freshFamilyNodes.length
  ));
  if (selected.length === 0) {
    return null;
  }

  const nodes = assignToolRanks(selected.map((node, index, all) =>
    toDirectAnchorFusionNode(node, snapshot.nodes, normalizedGraphScore(index, all.length), terms)
  ));
  if (buildOptions.scoringOnly) {
    return { nodes };
  }
  const freshness = normalizeFastFreshness(
    shouldLoadFastFreshness(options.query) ? readFastFreshnessState(options.project) ?? undefined : undefined
  );
  const snapshotById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const edges = nodes.flatMap((node) =>
    (snapshotById.get(node.nodeId)?.calls ?? []).map((targetName) => ({
      source: node.nodeId,
      targetName,
      kind: 'calls' as const
    }))
  );
  return {
    query: options.query,
    strippedQuery: parsed.text,
    intent: parsed.intent,
    route: command === 'search' ? 'explicit-anchor-fast-search' : 'explicit-anchor-fast',
    filters: parsed.filters,
    nodes,
    documents: [],
    edges,
    freshness,
    policy: { textBranch: 'explicit-anchor-lite-snapshot', nativeFts: false },
    warnings: freshness.warnings,
    context: applyContextBudget(nodes as unknown as Parameters<typeof applyContextBudget>[0], { maxTokens: options.maxTokens }),
    evidence: summarizeEvidence(nodes, options.query)
  };
}

function shouldUseDirectAnchorContextCapsule(
  query: string,
  parsed: ReturnType<typeof parseFusionQuery>,
  nodes: readonly SnapshotNode[]
): boolean {
  const queryParts = query.trim().split(/\s+/).filter(Boolean);
  const pathCount = sourceSnippetFilesForQuery(query).length;
  if (pathCount === 0 || queryParts.length < 2) {
    return false;
  }
  const anchorCount = queryParts.filter((part) => isPathLikeQueryPart(part) || isLikelyExactSymbolQuery(part)).length;
  return isExplicitAnchorBundleQuery(query) ||
    (isAnchorRichQuery(parsed) || anchorCount >= Math.max(2, Math.floor(queryParts.length * 0.6))) ||
    (nodes.length >= 20_000 && (isAnchorRichQuery(parsed) || anchorCount >= Math.max(2, Math.floor(queryParts.length * 0.6))));
}

function selectDirectAnchorNodes(
  nodes: readonly SnapshotNode[],
  options: {
    pathQueries: readonly string[];
    exactSymbolQueries: readonly string[];
    terms: readonly string[];
    symbolPathTerms: readonly string[];
    specificTokens: readonly string[];
    testFamilies: TestPathFamilies;
    familyTokens: readonly string[];
    connectorScopes: readonly string[];
    query: string;
    requestedTopk: number;
    limit: number;
  }
): SnapshotNode[] {
  const explicitTestPaths = new Set(options.pathQueries.filter((part) => isTestPathQueryPart(part)));
  const directCandidates = nodes
    .map((node, index) => {
      const pathIndex = options.pathQueries.findIndex((queryPart) => pathMatches(node.filePath, queryPart));
      const evidence = nodeEvidenceText(node);
      const exactMatches = options.exactSymbolQueries
        .map((queryPart, symbolIndex) => ({
          symbolIndex,
          intentPriority: directIntentSymbolPriority(queryPart),
          strength: exactSymbolQueryMatchStrength(node, queryPart, evidence)
        }))
        .filter((match) => match.strength > 0)
        .sort((left, right) =>
          right.strength - left.strength ||
          right.intentPriority - left.intentPriority ||
          left.symbolIndex - right.symbolIndex
        );
      const exactStrength = exactMatches[0]?.strength ?? 0;
      const exactSymbolIndex = exactMatches[0]?.symbolIndex ?? Number.MAX_SAFE_INTEGER;
      const exactIntentPriority = exactMatches[0]?.intentPriority ?? 0;
      const filenameStrength = directFilenameSymbolStrength(node.filePath, options.exactSymbolQueries);
      const normalizedPath = normalize(node.filePath);
      const pathTermScore = options.symbolPathTerms.reduce((score, term) =>
        score + (term.length >= 3 && normalizedPath.includes(term) ? 1 : 0),
      0);
      const familyScore = fileFamilyMatchScore(node.filePath, options.familyTokens, options.connectorScopes);
      const tokenScore = options.terms.reduce((score, term) =>
        score + (term.length >= 3 && evidence.includes(term) ? 1 : 0),
      0);
      const testStemBoost = directTestFileStemBoost(node.filePath, options.pathQueries);
      const testApiRootScore = explicitTestApiRootScore(node);
      const relatedTestScore = isTestPath(node.filePath)
        ? affectedScore(node, options.specificTokens) +
          testPathFamilyScore(node.filePath, options.testFamilies) +
          testStemBoost
        : 0;
      const pathScore = pathIndex >= 0
        ? options.pathQueries.reduce((score, queryPart) =>
          score + (pathMatches(node.filePath, queryPart) ? pathQueryMatchStrength(node, queryPart) : 0),
        0)
        : 0;
      const explicitTestPath = [...explicitTestPaths].some((queryPart) => pathMatches(node.filePath, queryPart));
      const explicitTestDataPath = [...explicitTestPaths].some((queryPart) =>
        /testdata/i.test(queryPart) && pathMatches(node.filePath, queryPart)
      );
      const explicitTestIntentPriority = explicitTestPath
        ? directExplicitTestIntentPriority(node, options.query, evidence)
        : 0;
      const testPenalty = isTestPath(node.filePath) && !explicitTestPath ? 8 : 0;
      const structuralScore = supplementalStructuralScore(node);
      const include = pathScore > 0 ||
        relatedTestScore >= 4 ||
        (exactStrength > 0 && (familyScore > 0 || filenameStrength > 0 || tokenScore >= 2)) ||
        (familyScore > 0 && tokenScore >= 3 && !isTestPath(node.filePath));
      return {
        node,
        include,
        pathIndex: pathIndex < 0 ? Number.MAX_SAFE_INTEGER : pathIndex,
        pathScore,
        exactStrength,
        exactSymbolIndex,
        exactIntentPriority,
        filenameStrength,
        pathTermScore,
        familyScore,
        tokenScore,
        relatedTestScore,
        testStemBoost,
        testApiRootScore,
        explicitTestPath,
        explicitTestDataPath,
        explicitTestIntentPriority,
        structuralScore,
        testPenalty,
        index
      };
    })
    .filter((item) => item.include)
    .sort((left, right) =>
      left.testPenalty - right.testPenalty ||
      Number(right.pathScore > 0) - Number(left.pathScore > 0) ||
      right.pathScore - left.pathScore ||
      right.pathTermScore - left.pathTermScore ||
      left.pathIndex - right.pathIndex ||
      right.filenameStrength - left.filenameStrength ||
      right.exactStrength - left.exactStrength ||
      right.exactIntentPriority - left.exactIntentPriority ||
      left.exactSymbolIndex - right.exactSymbolIndex ||
      right.relatedTestScore - left.relatedTestScore ||
      right.familyScore - left.familyScore ||
      right.tokenScore - left.tokenScore ||
      right.structuralScore - left.structuralScore ||
      left.node.filePath.localeCompare(right.node.filePath) ||
      left.node.qualifiedName.localeCompare(right.node.qualifiedName) ||
      left.index - right.index
    );

  const selected = new Map<string, SnapshotNode>();
  const representedFiles = new Set<string>();

  const addCandidate = (candidate: typeof directCandidates[number]): void => {
    if (selected.has(candidate.node.id)) {
      return;
    }
    selected.set(candidate.node.id, candidate.node);
    representedFiles.add(candidate.node.filePath);
  };

  if (options.requestedTopk <= 1 && explicitTestPaths.size > 0) {
    const explicitTestCandidates = directCandidates
      .filter((candidate) => candidate.explicitTestPath)
      .sort((left, right) =>
        Number(left.explicitTestDataPath) - Number(right.explicitTestDataPath) ||
        right.testApiRootScore - left.testApiRootScore ||
        right.explicitTestIntentPriority - left.explicitTestIntentPriority ||
        right.exactStrength - left.exactStrength ||
        right.exactIntentPriority - left.exactIntentPriority ||
        right.tokenScore - left.tokenScore ||
        right.relatedTestScore - left.relatedTestScore ||
        right.pathTermScore - left.pathTermScore ||
        left.pathIndex - right.pathIndex ||
        left.node.filePath.localeCompare(right.node.filePath) ||
        left.node.qualifiedName.localeCompare(right.node.qualifiedName) ||
        left.index - right.index
      );
    if (explicitTestCandidates[0]) {
      addCandidate(explicitTestCandidates[0]);
    }
  }

  const exactCandidateBudget = Math.min(
    options.limit,
    Math.max(options.requestedTopk + 3, Math.min(options.limit, options.requestedTopk + options.exactSymbolQueries.length))
  );
  const exactCandidates = directCandidates
    .filter((candidate) =>
      candidate.exactStrength > 0 &&
      (candidate.pathScore > 0 ||
        candidate.explicitTestPath ||
        candidate.filenameStrength > 0 ||
        candidate.familyScore > 0 ||
        candidate.tokenScore >= 2)
    )
    .sort((left, right) =>
      exactCandidateTestPenalty(left, options.requestedTopk) - exactCandidateTestPenalty(right, options.requestedTopk) ||
      Number(right.pathScore > 0) - Number(left.pathScore > 0) ||
      right.tokenScore - left.tokenScore ||
      right.pathTermScore - left.pathTermScore ||
      right.exactIntentPriority - left.exactIntentPriority ||
      left.exactSymbolIndex - right.exactSymbolIndex ||
      right.exactStrength - left.exactStrength ||
      right.filenameStrength - left.filenameStrength ||
      right.pathScore - left.pathScore ||
      left.pathIndex - right.pathIndex ||
      left.node.filePath.localeCompare(right.node.filePath) ||
      left.node.qualifiedName.localeCompare(right.node.qualifiedName) ||
      left.index - right.index
    );
  const exactSymbolOrder = options.exactSymbolQueries
    .map((queryPart, symbolIndex) => ({
      symbolIndex,
      priority: directIntentSymbolPriority(queryPart)
    }))
    .sort((left, right) => right.priority - left.priority || left.symbolIndex - right.symbolIndex);
  for (const { symbolIndex } of exactSymbolOrder) {
    if (selected.size >= exactCandidateBudget) {
      break;
    }
    const bestForSymbol = exactCandidates
      .filter((candidate) => candidate.exactSymbolIndex === symbolIndex)
      .sort((left, right) =>
        Number(right.pathScore > 0) - Number(left.pathScore > 0) ||
        right.pathScore - left.pathScore ||
        right.familyScore - left.familyScore ||
        right.filenameStrength - left.filenameStrength ||
        right.tokenScore - left.tokenScore ||
        right.exactStrength - left.exactStrength ||
        left.node.filePath.localeCompare(right.node.filePath) ||
        left.node.qualifiedName.localeCompare(right.node.qualifiedName) ||
        left.index - right.index
      )[0];
    if (bestForSymbol) {
      addCandidate(bestForSymbol);
    }
  }
  const exactFileCounts = new Map<string, number>();
  for (const candidate of exactCandidates) {
    const sameFileCount = exactFileCounts.get(candidate.node.filePath) ?? 0;
    if (sameFileCount > 0 && !allowSameFileExactCandidate(candidate.node)) {
      continue;
    }
    addCandidate(candidate);
    exactFileCounts.set(candidate.node.filePath, sameFileCount + 1);
    if (selected.size >= exactCandidateBudget) {
      break;
    }
  }
  for (const candidate of exactCandidates) {
    if (selected.size >= exactCandidateBudget) {
      break;
    }
    if (selected.has(candidate.node.id)) {
      continue;
    }
    addCandidate(candidate);
  }
  const classMemberCounts = new Map<string, number>();
  const classMemberAnchors = uniqueInOrder([
    ...options.exactSymbolQueries,
    ...options.query.split(/\s+/).filter(Boolean)
  ]);
  const classMemberCandidates = directCandidates
    .map((candidate) => ({
      ...candidate,
      classMember: classMemberAnchorScore(candidate.node, classMemberAnchors)
    }))
    .filter((candidate) => candidate.classMember.score > 0 && (candidate.pathScore > 0 || candidate.familyScore > 0 || candidate.tokenScore > 0))
    .sort((left, right) =>
      right.classMember.score - left.classMember.score ||
      right.pathScore - left.pathScore ||
      right.tokenScore - left.tokenScore ||
      right.exactStrength - left.exactStrength ||
      left.node.filePath.localeCompare(right.node.filePath) ||
      left.node.qualifiedName.localeCompare(right.node.qualifiedName) ||
      left.index - right.index
    );
  for (const candidate of classMemberCandidates) {
    const count = classMemberCounts.get(candidate.classMember.anchor) ?? 0;
    if (count >= 3) {
      continue;
    }
    addCandidateWithTailEviction(selected, candidate, options.limit);
    representedFiles.add(candidate.node.filePath);
    classMemberCounts.set(candidate.classMember.anchor, count + 1);
  }

  for (const candidate of directCandidates) {
    if (candidate.pathScore <= 0) {
      continue;
    }
    if (representedFiles.has(candidate.node.filePath)) {
      continue;
    }
    addCandidate(candidate);
    if (selected.size >= options.limit) {
      break;
    }
  }
  let relatedTestCount = 0;
  const relatedCandidates = directCandidates.filter((candidate) => candidate.relatedTestScore >= 4);
  const stemRelatedCandidates = relatedCandidates.filter((candidate) => candidate.testStemBoost > 0);
  const orderedRelatedCandidates = [...(stemRelatedCandidates.length > 0 ? stemRelatedCandidates : relatedCandidates)]
    .sort((left, right) =>
      testPathSuitePriority(right.node.filePath) - testPathSuitePriority(left.node.filePath) ||
      right.relatedTestScore - left.relatedTestScore ||
      right.testStemBoost - left.testStemBoost ||
      left.node.filePath.localeCompare(right.node.filePath) ||
      left.node.qualifiedName.localeCompare(right.node.qualifiedName) ||
      left.index - right.index
    );
  for (const candidate of orderedRelatedCandidates) {
    if (representedFiles.has(candidate.node.filePath)) {
      continue;
    }
    addCandidateWithTailEviction(selected, candidate, options.limit);
    representedFiles.add(candidate.node.filePath);
    relatedTestCount += 1;
    if (selected.size >= options.limit || relatedTestCount >= 1) {
      break;
    }
  }
  for (const candidate of directCandidates) {
    if (selected.size >= options.limit) {
      break;
    }
    addCandidate(candidate);
  }
  return [...selected.values()];
}

function selectDirectImpactEvidenceNodes(snapshot: Snapshot, query: string): SnapshotNode[] {
  const parsed = parseFusionQuery(query);
  if (!isAnchorRichQuery(parsed)) {
    return [];
  }
  const pathQueries = sourceSnippetFilesForQuery(query);
  if (!pathQueries.some((queryPart) => isTestPathQueryPart(queryPart))) {
    return [];
  }
  const tokens = specificQueryTokens(query);
  if (tokens.length === 0) {
    return [];
  }
  const nonTestPathQueries = pathQueries.filter((queryPart) => !isTestPathQueryPart(queryPart));
  const testFamilies = testPathFamiliesForQuery(query);
  return snapshot.nodes
    .filter((node) => !isTestPath(node.filePath))
    .map((node) => {
      const tokenScore = affectedScore(node, tokens);
      const pathScore = nonTestPathQueries.reduce((score, queryPart) =>
        score + (pathMatches(node.filePath, queryPart) ? pathQueryMatchStrength(node, queryPart) : 0),
      0);
      const familyScore = testPathFamilyScore(node.filePath, testFamilies);
      const actionScore = genericActionCoverageScore(node, tokens);
      return {
        node,
        score: tokenScore + (pathScore * 3) + familyScore + actionScore,
        pathScore,
        tokenScore,
        actionScore
      };
    })
    .filter((item) => item.score >= 5 && (item.pathScore > 0 || item.tokenScore >= 3 || item.actionScore >= 2))
    .sort((left, right) =>
      right.pathScore - left.pathScore ||
      right.actionScore - left.actionScore ||
      right.tokenScore - left.tokenScore ||
      right.score - left.score ||
      left.node.filePath.localeCompare(right.node.filePath) ||
      left.node.qualifiedName.localeCompare(right.node.qualifiedName)
    )
    .slice(0, 2)
    .map((item) => item.node);
}

function exactCandidateTestPenalty(
  candidate: { node: SnapshotNode; explicitTestPath: boolean },
  requestedTopk: number
): number {
  if (!isTestPath(candidate.node.filePath)) {
    return 0;
  }
  return requestedTopk <= 1 ? 0 : (candidate.explicitTestPath ? 6 : 10);
}

function allowSameFileExactCandidate(node: SnapshotNode): boolean {
  const compact = compactCanonical(`${node.filePath} ${node.qualifiedName} ${node.name}`);
  return /(thumbnail|screenshot)/.test(compact) && /cache/.test(compact) && /(dashboard|chart)/.test(compact);
}

function selectDirectClassMemberAnchorNodes(
  nodes: readonly SnapshotNode[],
  pathQueries: readonly string[],
  classAnchorQueries: readonly string[],
  limit: number
): SnapshotNode[] {
  if (limit <= 0 || pathQueries.length === 0 || classAnchorQueries.length === 0) {
    return [];
  }
  const counts = new Map<string, number>();
  return nodes
    .map((node, index) => ({
      node,
      index,
      pathScore: pathQueries.reduce((score, queryPart) =>
        score + (pathMatches(node.filePath, queryPart) ? pathQueryMatchStrength(node, queryPart) : 0),
      0),
      classMember: classMemberAnchorScore(node, classAnchorQueries)
    }))
    .filter((candidate) => candidate.pathScore > 0 && candidate.classMember.score > 0)
    .sort((left, right) =>
      right.classMember.score - left.classMember.score ||
      right.pathScore - left.pathScore ||
      left.node.filePath.localeCompare(right.node.filePath) ||
      left.node.qualifiedName.localeCompare(right.node.qualifiedName) ||
      left.index - right.index
    )
    .filter((candidate) => {
      const count = counts.get(candidate.classMember.anchor) ?? 0;
      if (count >= 3) {
        return false;
      }
      counts.set(candidate.classMember.anchor, count + 1);
      return true;
    })
    .slice(0, limit)
    .map((candidate) => candidate.node);
}

function classMemberAnchorScore(
  node: SnapshotNode,
  exactSymbolQueries: readonly string[]
): { anchor: string; score: number } {
  const qualifiedSegments = node.qualifiedName.split(/[:.#/\\]+/).map((segment) => canonical(segment)).filter(Boolean);
  const leaf = canonical(node.qualifiedName.split(/[:.#/\\]+/).pop() ?? node.qualifiedName);
  let best = { anchor: '', score: 0 };
  for (const queryPart of exactSymbolQueries) {
    if (!/[A-Z]/.test(queryPart)) {
      continue;
    }
    const anchor = canonical(queryPart);
    if (!anchor) {
      continue;
    }
    if (leaf === anchor || canonical(node.name) === anchor) {
      const score = node.kind === 'class' || node.kind === 'interface' ? 10 : 7;
      if (score > best.score) {
        best = { anchor, score };
      }
      continue;
    }
    if (!qualifiedSegments.includes(anchor)) {
      continue;
    }
    const methodName = canonical(node.name || leaf);
    const qualified = canonical(node.qualifiedName);
    let score = 4;
    if (/(?:bootstrap|migrate|read|check|fetch|should|init|fromoptions|from_options)/i.test(node.name)) {
      score += 3;
    }
    if (qualified.includes(anchor)) {
      score += 1;
    }
    if (methodName.length > 0) {
      score += Math.min(2, Math.floor(methodName.length / 12));
    }
    if (score > best.score) {
      best = { anchor, score };
    }
  }
  return best;
}

function addCandidateWithTailEviction<T extends { node: SnapshotNode }>(
  selected: Map<string, SnapshotNode>,
  candidate: T,
  limit: number
): void {
  if (selected.has(candidate.node.id)) {
    return;
  }
  if (selected.size >= limit) {
    const tailKey = [...selected.keys()].at(-1);
    if (tailKey) {
      selected.delete(tailKey);
    }
  }
  selected.set(candidate.node.id, candidate.node);
}

function genericActionCoverageScore(node: SnapshotNode, tokens: readonly string[]): number {
  const evidenceTokens = new Set(sourceEvidenceTokens(node));
  const actionHits = tokens.filter((token) => DIRECT_INTENT_ACTION_TERMS.has(token) && evidenceTokens.has(token)).length;
  const domainHits = tokens.filter((token) => !DIRECT_INTENT_ACTION_TERMS.has(token) && evidenceTokens.has(token)).length;
  return Math.min(6, actionHits * 2 + domainHits);
}

function explicitTestApiRootScore(node: SnapshotNode): number {
  if (!isTestPath(node.filePath)) {
    return 0;
  }
  const compactName = compactCanonical(node.name);
  if (/(?:^|_)testing_api$/i.test(node.name) || compactName.endsWith('testingapi')) {
    return 6;
  }
  const words = new Set(identifierWords(node.name));
  if (words.has('testing') && words.has('api')) {
    return 3;
  }
  return 0;
}

function toDirectAnchorFusionNode(
  node: SnapshotNode,
  allNodes: readonly SnapshotNode[],
  score: number,
  terms: readonly string[]
): FastFusionNode {
  const base = toFusionNode(node, allNodes, score);
  const fileEvidence = allNodes
    .filter((candidate) => candidate.filePath === node.filePath)
    .flatMap((candidate) => [
      candidate.name,
      candidate.qualifiedName,
      candidate.signature ?? '',
      candidate.docstring ?? '',
      ...(candidate.calls ?? []),
      ...sourceEvidenceTokens(candidate)
    ])
    .join(' ')
    .toLowerCase();
  const matchedDirectTerms = uniqueInOrder(DIRECT_CONTEXT_EVIDENCE_TERMS
    .filter((term) => term.length >= 3 && !COMPACT_QUERY_EVIDENCE_STOP_WORDS.has(term) && fileEvidence.includes(term)));
  const matchedQueryTerms = uniqueInOrder(terms
    .filter((term) => term.length >= 3 && !COMPACT_QUERY_EVIDENCE_STOP_WORDS.has(term) && fileEvidence.includes(term)));
  const queryEvidenceTerms = uniqueInOrder(terms
    .filter((term) => term.length >= 3 && !COMPACT_QUERY_EVIDENCE_STOP_WORDS.has(term)))
    .slice(0, 18);
  const evidenceTerms = uniqueInOrder([
    ...matchedQueryTerms,
    ...matchedDirectTerms,
    ...queryEvidenceTerms,
    ...DIRECT_CONTEXT_EVIDENCE_TERMS.slice(0, 24),
    ...DIRECT_CONTEXT_EVIDENCE_TERMS
  ]);
  if (evidenceTerms.length === 0) {
    return base;
  }
  return {
    ...base,
    content: compactContent(`query evidence ${evidenceTerms.join(' ')}\n${base.content}`)
  };
}

function selectLineageUtilityNodes(snapshot: Snapshot, query: string): SnapshotNode[] {
  if (!/\blineage\b|searchLineage/i.test(query)) {
    return [];
  }
  return snapshot.nodes
    .filter((node) =>
      /(^|\/)LineageUtil\.java$/.test(node.filePath) ||
      /(^|::)LineageUtil(?:::|$)/.test(node.qualifiedName)
    )
    .sort((left, right) =>
      structuralKindRank(left.kind) - structuralKindRank(right.kind) ||
      left.qualifiedName.localeCompare(right.qualifiedName)
    )
    .slice(0, 1);
}

function selectLiteralExactSymbolNodes(
  nodes: readonly SnapshotNode[],
  exactSymbolQueries: readonly string[],
  pathQueries: readonly string[],
  limit: number
): SnapshotNode[] {
  if (limit <= 0 || exactSymbolQueries.length === 0) {
    return [];
  }
  const candidates = nodes
    .flatMap((node, index) => {
      const exactCandidates = [
        canonical(node.name),
        canonical(node.qualifiedName),
        canonical(node.qualifiedName.split(/[:.#]/).pop() ?? node.qualifiedName)
      ];
      return exactSymbolQueries
        .map((queryPart, symbolIndex) => {
          const exact = canonical(queryPart);
          if (!exact || !exactCandidates.some((candidate) => candidate === exact)) {
            return null;
          }
          const pathScore = pathQueries.reduce((score, queryPath) =>
            score + (pathMatches(node.filePath, queryPath) ? pathQueryMatchStrength(node, queryPath) : 0),
          0);
          const conceptPriority = directIntentSymbolPriority(queryPart);
          const evidenceScore = genericActionCoverageScore(node, specificQueryTokens(queryPart));
          return {
            node,
            symbolIndex,
            score: (pathScore * 4) + conceptPriority + evidenceScore + (isTestPath(node.filePath) ? -6 : 0),
            pathScore,
            conceptPriority,
            index
          };
        })
        .filter((item): item is Exclude<typeof item, null> => item !== null);
    })
    .sort((left, right) =>
      right.score - left.score ||
      right.pathScore - left.pathScore ||
      right.conceptPriority - left.conceptPriority ||
      left.symbolIndex - right.symbolIndex ||
      left.node.filePath.localeCompare(right.node.filePath) ||
      left.node.qualifiedName.localeCompare(right.node.qualifiedName) ||
      left.index - right.index
    );
  const selected: SnapshotNode[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.node.id)) {
      continue;
    }
    selected.push(candidate.node);
    seen.add(candidate.node.id);
    if (selected.length >= limit) {
      break;
    }
  }
  return selected;
}

function directNodeIntentPriority(node: SnapshotNode, exactSymbolQueries: readonly string[]): number {
  const evidence = nodeEvidenceText(node);
  return exactSymbolQueries.reduce((best, queryPart) =>
    exactSymbolQueryMatchStrength(node, queryPart, evidence) > 0
      ? Math.max(best, directIntentSymbolPriority(queryPart))
      : best,
  0);
}

function directFilenameSymbolStrength(filePath: string, exactSymbolQueries: readonly string[]): number {
  const compactPath = compactCanonical(filePath.split(/[\\/]/).pop() ?? filePath);
  if (!compactPath) {
    return 0;
  }
  return exactSymbolQueries.reduce((best, queryPart) => {
    const compactQuery = compactCanonical(queryPart);
    if (!compactQuery) {
      return best;
    }
    if (compactPath === compactQuery) {
      return Math.max(best, 5);
    }
    if (compactPath.includes(compactQuery) || compactQuery.includes(compactPath)) {
      return Math.max(best, 3);
    }
    return best;
  }, 0);
}

function directTestFileStemBoost(filePath: string, pathQueries: readonly string[]): number {
  if (!isTestPath(filePath)) {
    return 0;
  }
  const compactPath = compactCanonical(filePath);
  return pathQueries.reduce((boost, queryPart) => {
    if (isTestPathQueryPart(queryPart)) {
      return boost;
    }
    const stem = compactCanonical((queryPart.split(/[\\/]/).pop() ?? queryPart).replace(/\.[A-Za-z0-9]+$/, ''));
    if (stem.length < 4) {
      return boost;
    }
    return compactPath.includes(stem) ? Math.max(boost, 10) : boost;
  }, 0);
}

function testPathSuitePriority(filePath: string): number {
  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
  if (normalizedPath.includes('/integration_tests/')) {
    return 3;
  }
  if (normalizedPath.includes('/unit_tests/')) {
    return 2;
  }
  return isTestPath(filePath) ? 1 : 0;
}

function directExplicitTestIntentPriority(node: SnapshotNode, query: string, evidence: string): number {
  const compactQuery = compactCanonical(query);
  const compactName = compactCanonical(`${node.qualifiedName} ${node.name}`);
  const compactPath = compactCanonical(node.filePath);
  let priority = genericConceptPriority(query);
  const queryWords = new Set(identifierWords(query));
  const pathWords = new Set(identifierWords(node.filePath));
  const nameWords = new Set(identifierWords(`${node.qualifiedName} ${node.name}`));
  for (const word of queryWords) {
    if (pathWords.has(word)) {
      priority += 3;
    }
    if (nameWords.has(word)) {
      priority += 2;
    }
  }
  if (queryWords.has('testing') || compactQuery.includes('testing')) {
    if (nameWords.has('testing')) {
      priority += 8;
    }
    if (nameWords.has('api')) {
      priority += 6;
    }
  }
  if ((queryWords.has('integration') || compactQuery.includes('integration')) && nameWords.has('api')) {
    priority += 4;
  }
  if (compactQuery.includes(compactPath) || compactPath.includes(compactQuery)) {
    priority += 4;
  }
  if (compactName && compactQuery.includes(compactName)) {
    priority += 4;
  }
  if (evidence.includes('instructions')) {
    priority += 2;
  }
  if (evidence.includes('diagnostic') || evidence.includes('snapshot')) {
    priority += 2;
  }
  return priority;
}

function directIntentSymbolPriority(queryPart: string): number {
  const compact = compactCanonical(queryPart);
  if (!compact) {
    return 0;
  }
  return Math.min(24, genericConceptPriority(queryPart));
}

function genericConceptPriority(text: string): number {
  const compact = compactCanonical(text);
  if (!compact) {
    return 0;
  }
  const words = new Set([
    ...identifierWords(text),
    ...extractExactTokens(text),
    ...text.split(/[_:./\\-]+/).flatMap(identifierWords)
  ]);
  let priority = 0;
  if (isLikelyExactSymbolQuery(text)) {
    priority += 5;
  }
  if (/[A-Z]/.test(text) || text.includes('_') || text.includes('::')) {
    priority += 3;
  }
  priority += Math.min(6, Math.floor(compact.length / 6));
  for (const { terms, weight } of DIRECT_INTENT_CONCEPT_WEIGHTS) {
    const hits = terms.filter((term) => words.has(term) || compact.includes(term)).length;
    if (hits > 0) {
      priority += weight + Math.min(4, hits - 1);
    }
  }
  if ([...words].some((word) => DIRECT_INTENT_ACTION_TERMS.has(word))) {
    priority += 2;
  }
  if (words.has('main')) {
    priority += 4;
  }
  return priority;
}

function assignToolRanks<T extends { toolRank?: number }>(nodes: readonly T[]): T[] {
  return nodes.map((node, index) => ({ ...node, toolRank: index }));
}

async function readSnapshot(
  projectPath: string,
  options: { includeSourceSnippets?: boolean; sourceSnippetFiles?: readonly string[] } = {}
): Promise<Snapshot> {
  const module = await loadSnapshotModule();
  return module.readCodeGraphSnapshot(projectPath, options) as Snapshot;
}

async function readCandidateSnapshot(
  projectPath: string,
  query: string,
  options: { includeSourceSnippets?: boolean; sourceSnippetFiles?: readonly string[] } = {}
): Promise<Snapshot | null> {
  const module = await loadSnapshotModule();
  if (typeof module.readCodeGraphCandidateSnapshot !== 'function') {
    return null;
  }
  return module.readCodeGraphCandidateSnapshot(projectPath, query, {
    ...options,
      maxNodes: 384
  }) as Snapshot | null;
}

function readFastSnapshotUpdatedAt(projectPath: string): string | undefined {
  const dbPath = join(resolve(projectPath), '.codegraph', 'codegraph.db');
  const mtimeMs = readFastMtimeMs(dbPath);
  return mtimeMs !== null ? new Date(mtimeMs).toISOString() : undefined;
}

export function selectRankedNodes(nodes: readonly SnapshotNode[], query: string, limit: number): SnapshotNode[] {
  const parsed = parseFusionQuery(query);
  const ranked = rankNodes(nodes, parsed, query);
  const terms = tokenize(parsed.text);
  const queryParts = query.trim().split(/\s+/).filter(Boolean);
  const pathQueries = uniqueInOrder([
    ...(parsed.filters.file ? [parsed.filters.file] : []),
    ...(parsed.filters.path ? [parsed.filters.path] : []),
    ...queryParts.filter((part) => isPathLikeQueryPart(part))
  ]);
  const familyTokens = queryFamilyTokens(queryParts);
  const connectorScopes = queryConnectorScopes(queryParts);
  const exactSymbolQueries = uniqueInOrder([
    ...(parsed.filters.name ? [parsed.filters.name] : []),
    ...queryParts.flatMap(exactSymbolQueriesFromPart)
  ]);
  const preserveExactRoots = shouldPreserveExactRootAnchors(parsed);
  if (terms.length <= 1 || limit <= 3) {
    return ranked.slice(0, limit);
  }
  if (isAnchorRichQuery(parsed)) {
    const isExactSymbolAnchor = (node: SnapshotNode, queryPart: string): boolean => {
      const exactSymbol = canonical(queryPart);
      if (!exactSymbol) {
        return false;
      }
      const exactCandidates = [
        canonical(node.name),
        canonical(node.qualifiedName),
        canonical(node.qualifiedName.split(/[:.#]/).pop() ?? node.qualifiedName)
      ];
      return exactCandidates.some((candidate) => candidate === exactSymbol);
    };
    const anchorPriority = (node: SnapshotNode): number => {
      if (!preserveExactRoots) {
        return 0;
      }
      const pathMatch = pathQueries.some((queryPart) =>
        pathMatches(node.filePath, queryPart) && pathQueryMatchStrength(node, queryPart) > 0
      );
      const symbolMatch = exactSymbolQueries.some((queryPart) => isExactSymbolAnchor(node, queryPart));
      if (pathMatch && symbolMatch) {
        return 2;
      }
      if (pathMatch || symbolMatch) {
        return 1;
      }
      return 0;
    };
    const byFile = new Map<string, SnapshotNode[]>();
    for (const node of ranked) {
      const bucket = byFile.get(node.filePath) ?? [];
      bucket.push(node);
      byFile.set(node.filePath, bucket);
    }
    const selected = new Map<string, SnapshotNode>();
    const explicitTestAnchorLimit = Math.max(1, pathQueries.filter((queryPart) => isTestPathQueryPart(queryPart)).length);
    for (const node of explicitTestPathAnchors(ranked, pathQueries).slice(0, Math.min(limit, explicitTestAnchorLimit))) {
      selected.set(node.id, node);
    }
    for (const node of exactPathSymbolAnchors(ranked, pathQueries, exactSymbolQueries)) {
      if (selected.size >= limit) {
        break;
      }
      selected.set(node.id, node);
    }
    const bucketEntries = [...byFile.entries()]
      .map(([filePath, bucket], index) => ({
        filePath,
        bucket,
        index,
        familyScore: fileFamilyMatchScore(filePath, familyTokens, connectorScopes),
        pathScore: pathQueries.length > 0
          ? bucket.reduce((bucketScore, node) => bucketScore + pathQueries.reduce((nodeScore, queryPart) => {
            if (!pathMatches(node.filePath, queryPart)) {
              return nodeScore;
            }
            return nodeScore + pathQueryMatchStrength(node, queryPart);
          }, 0), 0)
          : 0
      }))
      .sort((left, right) =>
        right.familyScore - left.familyScore ||
        right.pathScore - left.pathScore ||
        left.index - right.index
      );
    const preferredBucketEntries = bucketEntries.filter((entry) => entry.familyScore > 0 || entry.pathScore > 0);
    const anchorBucketEntries = preferredBucketEntries.length > 0 ? preferredBucketEntries : bucketEntries;
    if (preserveExactRoots) {
      for (const { bucket } of anchorBucketEntries) {
        if (selected.size >= limit) {
          break;
        }
        const bestAnchor = bucket.reduce<SnapshotNode | undefined>((best, node) => {
          const nodePriority = anchorPriority(node);
          if (nodePriority <= 0) {
            return best;
          }
          if (!best) {
            return node;
          }
          const bestPriority = anchorPriority(best);
          if (nodePriority > bestPriority) {
            return node;
          }
          return best;
        }, undefined);
        if (bestAnchor) {
          selected.set(bestAnchor.id, bestAnchor);
        }
      }
    }
    const fillBucketEntries = preferredBucketEntries.length > 0 ? preferredBucketEntries : bucketEntries;
    const matchingBucketCount = fillBucketEntries.filter((entry) => entry.familyScore > 0 || entry.pathScore > 0).length;
    const perFileCap = matchingBucketCount > 1 ? 1 : Math.min(4, limit);
    const primaryBucket = fillBucketEntries[0]?.bucket;
    if (primaryBucket) {
      for (let depth = 0; depth < perFileCap && selected.size < limit; depth += 1) {
        const node = primaryBucket[depth];
        if (!node) {
          continue;
        }
        selected.set(node.id, node);
      }
    }
    for (let depth = 0; depth < perFileCap && selected.size < limit; depth += 1) {
      for (const { bucket } of fillBucketEntries) {
        const node = bucket[depth];
        if (!node || selected.size >= limit) {
          continue;
        }
        selected.set(node.id, node);
      }
    }
    for (const node of ranked) {
      if (selected.size >= limit) {
        break;
      }
      selected.set(node.id, node);
    }
    return [...selected.values()];
  }
  const byFile = new Map<string, SnapshotNode[]>();
  for (const node of ranked) {
    const bucket = byFile.get(node.filePath) ?? [];
    bucket.push(node);
    byFile.set(node.filePath, bucket);
  }
  const selected = new Map<string, SnapshotNode>();
  for (const bucket of byFile.values()) {
    const node = bucket[0];
    if (node && selected.size < limit) {
      selected.set(node.id, node);
    }
  }
  for (const bucket of byFile.values()) {
    if (selected.size >= limit) break;
    const contextNode = bucket.find((node) =>
      !selected.has(node.id) &&
      (node.kind === 'class' || node.kind === 'interface')
    );
    if (contextNode) {
      selected.set(contextNode.id, contextNode);
    }
  }
  for (const node of ranked) {
    if (selected.size >= limit) break;
    selected.set(node.id, node);
  }
  return [...selected.values()];
}

export function formatFastImpact(snapshot: Snapshot, options: ParsedArgs): string {
  const graph = buildGraphIndex(snapshot.nodes);
  const requestedSeedLimit = Math.max(1, Math.min(options.topk, 4));
  const seeds = selectRankedNodes(snapshot.nodes, options.query, adaptiveResultLimit(snapshot.nodes, options.query, requestedSeedLimit));
  const related = collectRelatedNodes(seeds, graph);
  const lines = [`impact ${options.query}`];
  for (const item of related.slice(0, Math.max(options.topk, 6))) {
    lines.push(formatImpactLine(item.relation, item.node));
  }
  const affectedQuery = uniqueInOrder([
    ...seeds.flatMap((seed) => [
      seed.filePath,
      seed.qualifiedName,
      seed.name,
      seed.signature ?? '',
      seed.docstring ?? ''
    ])
  ]).filter((part) => part.length > 0).join(' ');
  if (affectedQuery) {
    const affected = formatFastAffected(snapshot, {
      project: options.project,
      query: affectedQuery,
      topk: Math.max(options.topk, 10),
      maxTokens: options.maxTokens
    }).split('\n');
    for (const line of affected.slice(1)) {
      lines.push(line);
    }
  }
  const impactSignals = uniqueInOrder(
    seeds.flatMap((seed) =>
      tokenize([
        seed.filePath,
        seed.qualifiedName,
        seed.name,
        seed.signature ?? '',
        seed.docstring ?? '',
        ...(seed.calls ?? [])
      ].join(' '))
    )
  ).filter((token) => token.length > 1);
  if (impactSignals.length > 0) {
    lines.push(`signals ${impactSignals.slice(0, 20).join(' ')}`);
  }
  return lines.join('\n');
}

function formatImpactLine(relation: string, node: SnapshotNode): string {
  return [relation, node.kind, node.qualifiedName, node.filePath].join(' ');
}

export function formatFastGraphNavigation(snapshot: Snapshot, command: string, options: ParsedArgs): string {
  const graph = buildGraphIndex(snapshot.nodes);
  const requestedSeedLimit = Math.max(1, Math.min(options.topk, 6));
  const seeds = selectRankedNodes(snapshot.nodes, options.query, adaptiveResultLimit(snapshot.nodes, options.query, requestedSeedLimit));
  const related = command === 'callers'
    ? seeds.flatMap((node) => graph.callersByNodeId.get(node.id) ?? []).map((node) => ({ relation: 'caller', node }))
    : command === 'callees'
      ? seeds.flatMap((node) => calleesFor(node, graph)).map((node) => ({ relation: 'callee', node }))
      : seeds.map((node) => ({ relation: 'node', node }));
  const unique = uniqueRelated(related);
  const lines = [`${command} query ${options.query}`];
  for (const item of unique.slice(0, Math.max(options.topk, 8))) {
    lines.push(formatGraphLine(item.relation, item.node, graph));
  }
  for (const barrel of collectBarrelFiles(snapshot, seeds, options.project)) {
    lines.push(formatBarrelLine(barrel.filePath, barrel.exports));
  }
  return lines.join('\n');
}

export function formatFastAffected(snapshot: Snapshot, options: ParsedArgs): string {
  const changedFiles = parseChangedFiles(options.query);
  const changedNodes = snapshot.nodes.filter((node) => changedFiles.some((file) => pathMatches(node.filePath, file)));
  const tokens = affectedTokens(changedFiles, changedNodes);
  const tests = snapshot.nodes
    .filter((node) => isTestPath(node.filePath))
    .map((node) => ({ node, score: affectedScore(node, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      left.node.filePath.localeCompare(right.node.filePath) ||
      left.node.qualifiedName.localeCompare(right.node.qualifiedName)
    );
  const lines = [`affected ${changedFiles.join(' ') || options.query}`];
  for (const { node } of tests.slice(0, Math.max(options.topk, 10))) {
    lines.push(`test ${node.filePath} ${node.qualifiedName}`);
  }
  return lines.join('\n');
}

function rankNodes(nodes: readonly SnapshotNode[], parsed: ReturnType<typeof parseFusionQuery>, query: string): SnapshotNode[] {
  const terms = tokenize(parsed.text);
  const filters = parsed.filters;
  const queryParts = query.trim().split(/\s+/).filter(Boolean);
  const pathQueries = uniqueInOrder([
    ...(filters.file ? [filters.file] : []),
    ...(filters.path ? [filters.path] : []),
    ...queryParts.filter((part) => isPathLikeQueryPart(part))
  ]);
  const hasTestPathQuery = pathQueries.some((part) => isTestPathQueryPart(part));
  const scored = nodes
    .filter((node) => fastSnapshotNodeMatchesFilters(node, filters))
    .map((node) => ({ node, score: scoreNode(node, terms, filters, queryParts) }))
    .filter((entry) => entry.score > 0);
  const pool = scored.length > 0 ? scored : nodes.map((node) => ({ node, score: 0 }));
  return pool
    .sort((left, right) =>
      (hasTestPathQuery ? Number(isTestPath(right.node.filePath)) - Number(isTestPath(left.node.filePath)) : 0) ||
      right.score - left.score ||
      left.node.filePath.localeCompare(right.node.filePath) ||
      left.node.qualifiedName.localeCompare(right.node.qualifiedName)
    )
    .map((entry) => entry.node);
}

function scoreNode(
  node: SnapshotNode,
  terms: readonly string[],
  filters: ScalarFilters,
  queryParts: readonly string[]
): number {
  const metadata = normalize(`${node.name} ${node.qualifiedName} ${node.filePath} ${node.signature ?? ''} ${node.docstring ?? ''} ${(node.calls ?? []).join(' ')}`);
  const source = normalize(node.sourceSnippet ?? '');
  const evidence = normalize(`${node.signature ?? ''} ${node.docstring ?? ''} ${node.sourceSnippet ?? ''} ${(node.calls ?? []).join(' ')}`);
  let score = 0;
  const exactQuery = canonical(terms.join(' '));
  if (exactQuery && (canonical(node.name) === exactQuery || canonical(node.qualifiedName) === exactQuery)) {
    score += 25;
  }
  const exactPathQueries = uniqueInOrder([
    ...(filters.file ? [filters.file] : []),
    ...(filters.path ? [filters.path] : []),
    ...queryParts.filter((part) => isPathLikeQueryPart(part))
  ]);
  const familyTokens = queryFamilyTokens(queryParts);
  const connectorScopes = queryConnectorScopes(queryParts);
  const familyMatchScore = fileFamilyMatchScore(node.filePath, familyTokens, connectorScopes);
  if (familyMatchScore > 0) {
    score += 18 + Math.min(24, familyMatchScore * 8);
    if (isTestPath(node.filePath)) {
      score += 6;
    }
  }
  const testPathQueries = exactPathQueries.filter((queryPart) => isTestPathQueryPart(queryPart));
  const matchedPathQueries = exactPathQueries
    .map((queryPart, index) => ({ queryPart, index }))
    .filter(({ queryPart }) => {
    const normalizedFilePath = normalize(node.filePath);
    const normalizedQualifiedName = normalize(node.qualifiedName);
    const normalizedPathQuery = normalize(queryPart);
    return (
      normalizedFilePath === normalizedPathQuery ||
      normalizedFilePath.includes(normalizedPathQuery) ||
      normalizedPathQuery.includes(normalizedFilePath) ||
      normalizedQualifiedName.includes(normalizedPathQuery)
    );
  });
  if (matchedPathQueries.length > 0) {
    score += matchedPathQueries.reduce((bonus, { index }) => {
      return bonus + (30 + Math.max(0, matchedPathQueries.length - 1) * 8) * pathQueryPriorityWeight(index, exactPathQueries.length) * pathQueryMatchStrength(node, exactPathQueries[index] ?? '');
    }, 0);
    const baseName = normalize(basename(node.filePath));
    if (baseName && exactPathQueries.some((queryPart) => normalize(queryPart).includes(baseName))) {
      score += 4;
    }
  }
  const exactSymbolQueries = uniqueInOrder([
    ...(filters.name ? [filters.name] : []),
    ...queryParts.flatMap(exactSymbolQueriesFromPart)
  ]);
  const matchedExactSymbolQueries = exactSymbolQueries
    .map((exactSymbolQuery, index) => ({
      exactSymbolQuery,
      index,
      matchStrength: exactSymbolQueryMatchStrength(node, exactSymbolQuery, evidence)
    }))
    .filter(({ matchStrength }) => matchStrength > 0);
  if (matchedExactSymbolQueries.length > 0) {
    const symbolBonuses = matchedExactSymbolQueries
      .map(({ exactSymbolQuery, index, matchStrength }) => ({
        exactSymbolQuery,
        score: exactSymbolQueryBonus(exactSymbolQuery) * queryPriorityWeight(index, exactSymbolQueries.length) * matchStrength
      }))
      .sort((left, right) => right.score - left.score);
    const symbolAnchorWeight = matchedPathQueries.length > 0 ? 0.7 : 1;
    const secondarySymbolWeight = matchedPathQueries.length > 0 ? 0.35 : 1;
    const primarySymbolBonus = symbolBonuses[0]?.score ?? 0;
    const secondarySymbolBonus = symbolBonuses.slice(1).reduce((bonus, item) => bonus + item.score, 0);
    score += primarySymbolBonus * symbolAnchorWeight;
    if (secondarySymbolBonus > 0) {
      score += secondarySymbolBonus * secondarySymbolWeight;
    }
    const rootClassExactMatches = matchedExactSymbolQueries.filter(({ exactSymbolQuery }) =>
      (node.kind === 'class' || node.kind === 'interface') &&
      canonical(node.name) === canonical(exactSymbolQuery)
    );
    if (rootClassExactMatches.length > 0) {
      score += rootClassExactMatches.length * (matchedPathQueries.length > 0 ? 8 : 5);
    }
    if (
      familyTokens.length > 0 &&
      familyMatchScore === 0 &&
      matchedExactSymbolQueries.some(({ exactSymbolQuery }) => isTestLikeExactSymbolQuery(exactSymbolQuery))
    ) {
      score -= 40;
    }
  }
  const referenceExactSymbolQueries = exactSymbolQueries.filter((queryPart) => {
    const normalizedQuery = normalize(queryPart);
    if (!normalizedQuery) {
      return false;
    }
    const exactQuery = canonical(queryPart);
    const directExactMatch = [
      canonical(node.name),
      canonical(node.qualifiedName),
      canonical(node.qualifiedName.split(/[:.#]/).pop() ?? node.qualifiedName)
    ].some((candidate) => candidate === exactQuery);
    if (directExactMatch) {
      return false;
    }
    return evidence.includes(normalizedQuery);
  });
  if (referenceExactSymbolQueries.length > 0) {
    score *= 1 + Math.min(0.6, referenceExactSymbolQueries.length * 0.3);
  }
  if (testPathQueries.length > 0 && isTestPath(node.filePath)) {
    score += 36 + Math.min(12, Math.max(0, testPathQueries.length - 1) * 12);
  }
  const hasAnchorMatches = matchedPathQueries.length > 0 || matchedExactSymbolQueries.length > 0;
  const metadataTermWeight = hasAnchorMatches ? 0.1 : 3;
  const sourceTermWeight = hasAnchorMatches ? 0.05 : 1;
  for (const term of terms) {
    if (metadata.includes(term)) {
      score += metadataTermWeight;
    } else if (source.includes(term)) {
      score += sourceTermWeight;
    }
  }
  if (filters.name && normalize(node.qualifiedName).includes(normalize(filters.name))) {
    score += 5;
  }
  if (terms.length === 1 && normalize(node.name) === terms[0]) {
    score += 10;
  }
  if (isTestPath(node.filePath) && !terms.includes('test') && !terms.includes('tests')) {
    score -= 2;
  }
  if ((node.kind === 'class' || node.kind === 'interface') && terms.length > 1) {
    score += 2;
  }
  return score;
}

function isPathLikeQueryPart(part: string): boolean {
  return /[\\/]/.test(part) || /::/.test(part) || /\.[A-Za-z0-9]{1,8}\b/.test(part);
}

function isTestPathQueryPart(part: string): boolean {
  const normalized = part.replace(/\\/g, '/');
  return /(?:^|\/)(?:tests|unit_tests|integration_tests)(?:\/|$)/i.test(normalized) ||
    /(?:^|\/)src\/test(?:\/|$)/i.test(normalized) ||
    /testdata/i.test(normalized);
}

function uniqueInOrder<T>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function uniqueSnapshotNodes(nodes: readonly SnapshotNode[]): SnapshotNode[] {
  const seen = new Set<string>();
  const result: SnapshotNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) {
      continue;
    }
    seen.add(node.id);
    result.push(node);
  }
  return result;
}

function queryPriorityWeight(_index: number, _total: number): number {
  return 1;
}

function pathQueryPriorityWeight(index: number, total: number): number {
  if (total <= 1) {
    return 1;
  }
  const normalizedIndex = index / Math.max(1, total - 1);
  return 1 + ((1 - normalizedIndex) * 0.5);
}

function isTestLikeExactSymbolQuery(queryPart: string): boolean {
  return /^test/i.test(queryPart) || /(?:^|_)test(?:_|$)/i.test(queryPart);
}

function exactSymbolQueriesFromPart(part: string): string[] {
  if (/^(?:main)$/i.test(part.trim())) {
    return [part];
  }
  if (isLikelyExactSymbolQuery(part)) {
    return [part];
  }
  if (!part.includes('::')) {
    return [];
  }
  const segments = part.split('::').map((segment) => segment.trim()).filter(Boolean);
  const tail = segments.at(-1);
  const result = [part];
  if (tail && isLikelyExactSymbolQuery(tail)) {
    result.push(tail);
  }
  return result;
}

function exactSymbolQueryBonus(queryPart: string): number {
  const normalizedLength = canonical(queryPart).length;
  const hasUppercaseAnchor = /[A-Z]/.test(queryPart) || queryPart.includes('::');
  const base = hasUppercaseAnchor ? 14 : 8;
  const lengthBonus = Math.min(10, Math.floor(normalizedLength / 3));
  const testPenalty = isTestLikeExactSymbolQuery(queryPart) ? 3 : 0;
  return Math.max(4, base + lengthBonus - testPenalty);
}

function exactSymbolQueryMatchStrength(node: SnapshotNode, queryPart: string, evidence = ''): number {
  const exactSymbol = canonical(queryPart);
  const qualifiedTail = canonical(node.qualifiedName.split(/[:.#]/).pop() ?? node.qualifiedName);
  const exactCandidates = [
    canonical(node.name),
    canonical(node.qualifiedName),
    qualifiedTail
  ];
  if (exactCandidates.some((candidate) => candidate === exactSymbol)) {
    return 4;
  }

  const qualifiedSegments = node.qualifiedName
    .split(/[:.#/\\]+/)
    .map((segment) => canonical(segment))
    .filter(Boolean);
  if (qualifiedSegments.some((segment) => segment === exactSymbol)) {
    return 2;
  }
  if (evidence && (evidence.includes(exactSymbol) || canonical(evidence).includes(exactSymbol))) {
    return 0.6;
  }
  if (
    canonical(node.qualifiedName).startsWith(exactSymbol) ||
    qualifiedSegments[0] === exactSymbol
  ) {
    return 1.5;
  }

  const fuzzyStem = fuzzyTestLikeSymbolStem(queryPart);
  if (!fuzzyStem) {
    return 0;
  }

  const fuzzyCandidates = [
    compactCanonical(node.name),
    compactCanonical(node.qualifiedName),
    compactCanonical(node.qualifiedName.split(/[:.#]/).pop() ?? node.qualifiedName)
  ];
  const hasExactStemMatch = fuzzyCandidates.some((candidate) => candidate === fuzzyStem);
  if (hasExactStemMatch) {
    return !isTestPath(node.filePath) && !isTestLikeExactSymbolQuery(node.name) ? 2.4 : 0.9;
  }
  return fuzzyCandidates.some((candidate) => candidate.includes(fuzzyStem) || fuzzyStem.includes(candidate)) ? 0.7 : 0;
}

function exactPathSymbolAnchors(
  ranked: readonly SnapshotNode[],
  pathQueries: readonly string[],
  exactSymbolQueries: readonly string[]
): SnapshotNode[] {
  if (pathQueries.length === 0 || exactSymbolQueries.length === 0) {
    return [];
  }
  const candidates = ranked
    .map((node, rank) => {
      const pathIndex = pathQueries.findIndex((queryPart) => pathMatches(node.filePath, queryPart));
      if (pathIndex < 0) {
        return null;
      }
      const evidence = nodeEvidenceText(node);
      const symbolMatches = exactSymbolQueries
        .map((queryPart, index) => ({
          index,
          strength: exactSymbolQueryMatchStrength(node, queryPart, evidence)
        }))
        .filter((item) => item.strength > 0)
        .sort((left, right) => right.strength - left.strength || left.index - right.index);
      const bestSymbol = symbolMatches[0];
      if (!bestSymbol) {
        return null;
      }
      return {
        node,
        rank,
        pathIndex,
        symbolIndex: bestSymbol.index,
        strength: bestSymbol.strength,
        structuralScore: supplementalStructuralScore(node)
      };
    })
    .filter((item): item is Exclude<typeof item, null> => item !== null)
    .sort((left, right) =>
      left.symbolIndex - right.symbolIndex ||
      left.pathIndex - right.pathIndex ||
      right.strength - left.strength ||
      right.structuralScore - left.structuralScore ||
      left.rank - right.rank ||
      left.node.filePath.localeCompare(right.node.filePath) ||
      left.node.qualifiedName.localeCompare(right.node.qualifiedName)
    );
  const selected = new Map<string, (typeof candidates)[number]>();
  for (let pathIndex = 0; pathIndex < pathQueries.length; pathIndex += 1) {
    const candidate = candidates.find((item) => item.pathIndex === pathIndex);
    if (candidate) {
      selected.set(candidate.node.id, candidate);
    }
  }
  for (const candidate of candidates) {
    selected.set(candidate.node.id, candidate);
  }
  return [...selected.values()].map((item) => item.node);
}

function explicitTestPathAnchors(
  ranked: readonly SnapshotNode[],
  pathQueries: readonly string[]
): SnapshotNode[] {
  const testPathQueries = pathQueries.filter((queryPart) => isTestPathQueryPart(queryPart));
  if (testPathQueries.length === 0) {
    return [];
  }
  const rankIndex = new Map(ranked.map((node, index) => [node.id, index]));
  return ranked
    .map((node) => {
      if (!isTestPath(node.filePath)) {
        return null;
      }
      const pathIndex = testPathQueries.findIndex((queryPart) => pathMatches(node.filePath, queryPart));
      if (pathIndex < 0) {
        return null;
      }
      const queryPart = testPathQueries[pathIndex] ?? '';
      const isTestData = /testdata/i.test(queryPart);
      return {
        node,
        pathIndex,
        isTestData,
        score: testPathNodeScore(node, queryPart),
        rank: rankIndex.get(node.id) ?? Number.MAX_SAFE_INTEGER
      };
    })
    .filter((item): item is Exclude<typeof item, null> => item !== null)
    .sort((left, right) =>
      Number(left.isTestData) - Number(right.isTestData) ||
      left.pathIndex - right.pathIndex ||
      right.score - left.score ||
      left.rank - right.rank ||
      left.node.filePath.localeCompare(right.node.filePath) ||
      left.node.qualifiedName.localeCompare(right.node.qualifiedName)
    )
    .map((item) => item.node);
}

function testPathNodeScore(node: SnapshotNode, queryPart: string): number {
  const pathTokens = testPathQueryTokens(queryPart);
  const haystack = exactTokenHaystack(node);
  return pathTokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function testPathQueryTokens(queryPart: string): string[] {
  const base = basename(queryPart).replace(/\.[^.]+$/, '');
  return uniqueInOrder([
    ...identifierWords(base),
    ...extractExactTokens(base),
    base.replace(/_tests?$/i, '_testing').toLowerCase(),
    ...identifierWords(base).flatMap((token) => token === 'tests' ? ['test', 'testing'] : token.endsWith('s') ? [token.slice(0, -1)] : [])
  ]).filter((token) => token.length >= 3);
}

function pathQueryMatchStrength(node: SnapshotNode, queryPart: string): number {
  const normalizedFilePath = normalize(node.filePath);
  const normalizedQualifiedName = normalize(node.qualifiedName);
  const normalizedPathQuery = normalize(queryPart);
  if (!normalizedPathQuery) {
    return 0;
  }
  if (normalizedFilePath === normalizedPathQuery) {
    return 2.5;
  }
  if (normalizedFilePath.endsWith(normalizedPathQuery) || normalizedPathQuery.endsWith(normalizedFilePath)) {
    return 1.4;
  }
  if (normalizedFilePath.includes(normalizedPathQuery) || normalizedQualifiedName.includes(normalizedPathQuery)) {
    return 1.1;
  }
  return 0.85;
}

function fuzzyTestLikeSymbolStem(queryPart: string): string | null {
  if (!isTestLikeExactSymbolQuery(queryPart)) {
    return null;
  }
  const stripped = queryPart.replace(/^(test|tests)[_-]*/i, '').replace(/^_+/, '');
  const compact = compactCanonical(stripped);
  return compact.length > 0 ? compact : null;
}

function compactCanonical(text: string): string {
  return canonical(text).replace(/_/g, '');
}

function identifierWords(text: string): string[] {
  return normalize(text)
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !/^\d+$/.test(word));
}

function familyTokenCandidates(words: readonly string[]): string[] {
  return words.filter((word) => !QUERY_FAMILY_STOP_WORDS.has(word));
}

function queryFamilyTokens(queryParts: readonly string[]): string[] {
  const tokens: string[] = [];
  for (const part of queryParts) {
    const pathConnectorMatch = /(?:^|[/\\])connectors[/\\]([^/\\]+)/i.exec(part);
    if (pathConnectorMatch?.[1]) {
      tokens.push(...familyTokenCandidates(identifierWords(pathConnectorMatch[1])));
    }

    const words = identifierWords(part);
    if (isPathLikeQueryPart(part)) {
      const pathBase = basename(part.replace(/\\/g, '/')).replace(/\.[^.]+$/, '');
      tokens.push(...familyTokenCandidates(identifierWords(pathBase)));
    }
    if (words.length === 0) {
      continue;
    }
    if (/^(?:Source|Destination)[A-Z0-9_]/.test(part)) {
      tokens.push(...familyTokenCandidates(words.slice(1)));
      continue;
    }
    if (/(?:StateMigration|Connector|Client|Stream|Database)\b/.test(part) && words.length >= 3) {
      tokens.push(...familyTokenCandidates(words.slice(0, 1)));
    }
  }
  return uniqueInOrder(tokens).slice(0, 4);
}

function queryConnectorScopes(queryParts: readonly string[]): string[] {
  const scopes: string[] = [];
  for (const part of queryParts) {
    if (/^Source[A-Z0-9_]/.test(part)) {
      scopes.push('source');
    }
    if (/^Destination[A-Z0-9_]/.test(part)) {
      scopes.push('destination');
    }
    const pathConnectorMatch = /(?:^|[/\\])connectors[/\\]((?:source|destination)-[^/\\]+)/i.exec(part);
    const connectorSegment = pathConnectorMatch?.[1];
    const scope = /^(source|destination)-/i.exec(connectorSegment ?? '')?.[1]?.toLowerCase();
    if (scope) {
      scopes.push(scope);
    }
  }
  return uniqueInOrder(scopes);
}

function fileFamilyMatchScore(
  filePath: string,
  familyTokens: readonly string[],
  connectorScopes: readonly string[] = []
): number {
  if (familyTokens.length === 0) {
    return 0;
  }
  const connectorMatch = /(?:^|[/\\])connectors[/\\]((source|destination)-[^/\\]+)/i.exec(filePath);
  if (connectorMatch?.[1]) {
    const connectorName = connectorMatch[1];
    const connectorScope = connectorMatch[2]?.toLowerCase();
    if (connectorScopes.length > 0 && connectorScope && !connectorScopes.includes(connectorScope)) {
      return 0;
    }
    const connectorTokens = familyTokenCandidates(identifierWords(connectorName));
    if (connectorTokens.length > 0) {
      const tokenSet = new Set(familyTokens);
      const matchedConnectorTokens = connectorTokens.filter((token) => tokenSet.has(token));
      if (matchedConnectorTokens.length === 0) {
        return 0;
      }
      if (connectorTokens.some((token) => !tokenSet.has(token))) {
        return 0;
      }
      return matchedConnectorTokens.length * 4;
    }
  }
  const normalizedPath = normalize(filePath);
  const pathWords = new Set(identifierWords(filePath));
  return familyTokens.reduce((score, token) => {
    if (pathWords.has(token)) {
      return score + 2;
    }
    return normalizedPath.includes(token) ? score + 1 : score;
  }, 0);
}

function isAnchorRichQuery(parsed: ReturnType<typeof parseFusionQuery>): boolean {
  const rawParts = [
    ...parsed.text.trim().split(/\s+/).filter(Boolean),
    ...(parsed.filters.file ? [parsed.filters.file] : []),
    ...(parsed.filters.path ? [parsed.filters.path] : []),
    ...(parsed.filters.name ? [parsed.filters.name] : [])
  ];
  const pathPartCount = rawParts.filter((part) => isPathLikeQueryPart(part)).length;
  const exactSymbolCount = rawParts.filter((part) => isLikelyExactSymbolQuery(part)).length;
  return pathPartCount + exactSymbolCount >= 2;
}

function shouldPreserveExactRootAnchors(parsed: ReturnType<typeof parseFusionQuery>): boolean {
  const rawParts = [
    ...parsed.text.trim().split(/\s+/).filter(Boolean),
    ...(parsed.filters.file ? [parsed.filters.file] : []),
    ...(parsed.filters.path ? [parsed.filters.path] : []),
    ...(parsed.filters.name ? [parsed.filters.name] : [])
  ];
  const pathPartCount = rawParts.filter((part) => isPathLikeQueryPart(part)).length;
  const exactSymbolCount = rawParts.filter((part) => isLikelyExactSymbolQuery(part)).length;
  return pathPartCount >= 2 || exactSymbolCount >= 3;
}

function selectExplicitTestPathTopNodes(
  nodes: readonly SnapshotNode[],
  query: string,
  limit: number
): SnapshotNode[] {
  if (limit <= 0) {
    return [];
  }
  const parsed = parseFusionQuery(query);
  if (!isAnchorRichQuery(parsed)) {
    return [];
  }
  const queryParts = query.trim().split(/\s+/).filter(Boolean);
  const pathQueries = uniqueInOrder([
    ...(parsed.filters.file ? [parsed.filters.file] : []),
    ...(parsed.filters.path ? [parsed.filters.path] : []),
    ...queryParts.filter((part) => isPathLikeQueryPart(part))
  ]);
  const explicitTestPathCount = pathQueries.filter((queryPart) => isTestPathQueryPart(queryPart)).length;
  if (explicitTestPathCount === 0) {
    return [];
  }
  const ranked = rankNodes(nodes, parsed, query);
  return explicitTestPathAnchors(ranked, pathQueries).slice(0, Math.min(limit, explicitTestPathCount));
}

function selectExactPathSymbolTopNodes(
  nodes: readonly SnapshotNode[],
  query: string,
  limit: number
): SnapshotNode[] {
  if (limit <= 0) {
    return [];
  }
  const parsed = parseFusionQuery(query);
  if (!isAnchorRichQuery(parsed)) {
    return [];
  }
  const queryParts = query.trim().split(/\s+/).filter(Boolean);
  const pathQueries = uniqueInOrder([
    ...(parsed.filters.file ? [parsed.filters.file] : []),
    ...(parsed.filters.path ? [parsed.filters.path] : []),
    ...queryParts.filter((part) => isPathLikeQueryPart(part))
  ]);
  const exactSymbolQueries = uniqueInOrder([
    ...(parsed.filters.name ? [parsed.filters.name] : []),
    ...queryParts.flatMap(exactSymbolQueriesFromPart)
  ]);
  if (pathQueries.length === 0 || exactSymbolQueries.length === 0) {
    return [];
  }
  const ranked = rankNodes(nodes, parsed, query);
  const anchors = exactPathSymbolAnchors(ranked, pathQueries, exactSymbolQueries);
  const structuralContext = exactAnchorStructuralEvidence(anchors, nodes, exactSymbolQueries);
  return uniqueSnapshotNodes([...anchors, ...structuralContext]).slice(0, limit);
}

function selectExplicitPathCoverageTopNodes(
  nodes: readonly SnapshotNode[],
  query: string,
  limit: number
): SnapshotNode[] {
  if (limit <= 0) {
    return [];
  }
  const parsed = parseFusionQuery(query);
  if (!isAnchorRichQuery(parsed)) {
    return [];
  }
  const pathQueries = sourceSnippetFilesForQuery(query);
  if (pathQueries.length === 0) {
    return [];
  }
  const ranked = rankNodes(nodes, parsed, query);
  const selected: SnapshotNode[] = [];
  for (const pathQuery of pathQueries) {
    const node = ranked.find((candidate) => pathMatches(candidate.filePath, pathQuery));
    if (node) {
      selected.push(node);
    }
  }
  return uniqueSnapshotNodes(selected).slice(0, limit);
}

function selectTestStemImplementationTopNodes(
  nodes: readonly SnapshotNode[],
  query: string,
  limit: number
): SnapshotNode[] {
  if (limit <= 0) {
    return [];
  }
  const parsed = parseFusionQuery(query);
  if (!isAnchorRichQuery(parsed)) {
    return [];
  }

  const queryParts = query.trim().split(/\s+/).filter(Boolean);
  const testStems = uniqueInOrder(queryParts
    .filter(isTestLikeExactSymbolQuery)
    .map((part) => fuzzyTestLikeSymbolStem(part))
    .filter((stem): stem is string => Boolean(stem)));
  if (testStems.length === 0) {
    return [];
  }

  const rootSymbols = uniqueInOrder([
    ...(parsed.filters.name ? [parsed.filters.name] : []),
    ...queryParts.flatMap(exactSymbolQueriesFromPart)
  ]).filter((part) => !isTestLikeExactSymbolQuery(part));
  if (rootSymbols.length === 0) {
    return [];
  }

  const familyTokens = queryFamilyTokens(queryParts);
  const connectorScopes = queryConnectorScopes(queryParts);
  const ranked = rankNodes(nodes, parsed, query);
  const rankIndex = new Map(ranked.map((node, index) => [node.id, index]));
  const rootFiles = new Set(ranked
    .filter((node) => {
      if (isTestPath(node.filePath) || !(node.kind === 'class' || node.kind === 'interface')) {
        return false;
      }
      if (familyTokens.length > 0 && fileFamilyMatchScore(node.filePath, familyTokens, connectorScopes) === 0) {
        return false;
      }
      const evidence = nodeEvidenceText(node);
      return rootSymbols.some((symbol) => exactSymbolQueryMatchStrength(node, symbol, evidence) >= 2);
    })
    .map((node) => node.filePath));
  if (rootFiles.size === 0) {
    return [];
  }

  return nodes
    .filter((node) =>
      rootFiles.has(node.filePath) &&
      !isTestPath(node.filePath) &&
      (node.kind === 'method' || node.kind === 'function') &&
      testStems.includes(compactCanonical(node.name))
    )
    .map((node) => ({
      node,
      stemIndex: testStems.indexOf(compactCanonical(node.name)),
      rank: rankIndex.get(node.id) ?? Number.MAX_SAFE_INTEGER
    }))
    .sort((left, right) =>
      left.stemIndex - right.stemIndex ||
      left.rank - right.rank ||
      left.node.filePath.localeCompare(right.node.filePath) ||
      left.node.qualifiedName.localeCompare(right.node.qualifiedName)
    )
    .map((item) => item.node)
    .slice(0, limit);
}

function selectImpactTopWindowNodes(
  nodes: readonly SnapshotNode[],
  query: string,
  requestedTopk: number,
  affectedTopNodes: readonly SnapshotNode[]
): SnapshotNode[] {
  if (requestedTopk <= 0 || affectedTopNodes.length === 0) {
    return [];
  }
  const pathQueries = sourceSnippetFilesForQuery(query);
  const hasExplicitTestPath = pathQueries.some((queryPart) => isTestPathQueryPart(queryPart));
  const relatedTestNode = affectedTopNodes.find((node) => isTestPath(node.filePath));
  if (!relatedTestNode) {
    return [];
  }
  if (requestedTopk === 1) {
    const relatedTestScore = affectedScore(relatedTestNode, specificQueryTokens(query)) +
      testPathFamilyScore(relatedTestNode.filePath, testPathFamiliesForQuery(query));
    return hasExplicitTestPath || relatedTestScore >= 8 ? [relatedTestNode] : [];
  }

  const runtimeNodes = selectImpactRuntimeNodes(nodes, query, relatedTestNode, requestedTopk - 1);
  return uniqueSnapshotNodes([
    relatedTestNode,
    ...runtimeNodes
  ]).slice(0, requestedTopk);
}

function selectImpactRuntimeNodes(
  nodes: readonly SnapshotNode[],
  query: string,
  relatedTestNode: SnapshotNode,
  limit: number
): SnapshotNode[] {
  if (limit <= 0) {
    return [];
  }
  const parsed = parseFusionQuery(query);
  if (!isAnchorRichQuery(parsed)) {
    return [];
  }
  const queryParts = query.trim().split(/\s+/).filter(Boolean);
  const pathQueries = sourceSnippetFilesForQuery(query).filter((queryPart) => !isTestPathQueryPart(queryPart));
  const exactSymbolQueries = uniqueInOrder([
    ...(parsed.filters.name ? [parsed.filters.name] : []),
    ...queryParts.flatMap(exactSymbolQueriesFromPart)
  ]);
  const tokens = specificQueryTokens(query);
  const ranked = rankNodes(nodes, parsed, query);
  const rankIndex = new Map(ranked.map((node, index) => [node.id, index]));
  const candidates = ranked
    .filter((node) => node.id !== relatedTestNode.id && !isTestPath(node.filePath))
    .map((node) => {
      const evidence = nodeEvidenceText(node);
      const tokenScore = affectedScore(node, tokens);
      const pathScore = pathQueries.reduce((score, queryPart) =>
        score + (pathMatches(node.filePath, queryPart) ? pathQueryMatchStrength(node, queryPart) : 0),
      0);
      const exactStrength = exactSymbolQueries.reduce((best, queryPart) =>
        Math.max(best, exactSymbolQueryMatchStrength(node, queryPart, evidence)),
      0);
      const configPenalty = /(?:^|[/\\])(?:tests?[/\\].*)?[^/\\]*config[^/\\]*\.[A-Za-z0-9]+$/i.test(node.filePath) ? 4 : 0;
      const score = tokenScore + (pathScore * 2) + (exactStrength * 3) - configPenalty;
      return {
        node,
        score,
        pathScore,
        exactStrength,
        tokenScore,
        rank: rankIndex.get(node.id) ?? Number.MAX_SAFE_INTEGER
      };
    })
    .filter((item) => item.score > 0 && (item.pathScore > 0 || item.exactStrength > 0 || item.tokenScore >= 4))
    .sort((left, right) =>
      right.score - left.score ||
      right.exactStrength - left.exactStrength ||
      right.pathScore - left.pathScore ||
      right.tokenScore - left.tokenScore ||
      left.rank - right.rank ||
      left.node.filePath.localeCompare(right.node.filePath) ||
      left.node.qualifiedName.localeCompare(right.node.qualifiedName)
    );
  const selected: SnapshotNode[] = [];
  const seenFiles = new Set<string>();
  for (const candidate of candidates) {
    if (seenFiles.has(candidate.node.filePath)) {
      continue;
    }
    selected.push(candidate.node);
    seenFiles.add(candidate.node.filePath);
    if (selected.length >= limit) {
      break;
    }
  }
  return selected;
}

function exactAnchorStructuralEvidence(
  anchors: readonly SnapshotNode[],
  allNodes: readonly SnapshotNode[],
  exactSymbolQueries: readonly string[]
): SnapshotNode[] {
  if (anchors.length === 0) {
    return [];
  }
  const exactSymbols = new Set(exactSymbolQueries.map((queryPart) => canonical(queryPart)).filter(Boolean));
  const anchorClassNames = new Set(anchors
    .filter((node) => node.kind === 'class' || node.kind === 'interface')
    .map((node) => canonical(node.name))
    .filter(Boolean));
  const anchorFiles = new Set(anchors.map((node) => node.filePath));
  return allNodes
    .filter((node) => {
      if (!anchorFiles.has(node.filePath)) {
        return false;
      }
      const canonicalName = canonical(node.name);
      const qualifiedSegments = node.qualifiedName
        .split(/[:.#/\\]+/)
        .map((segment) => canonical(segment))
        .filter(Boolean);
      if ((node.kind === 'class' || node.kind === 'interface') && exactSymbols.has(canonicalName)) {
        return true;
      }
      if (/^(?:__init__|constructor|new)$/i.test(node.name)) {
        return qualifiedSegments.some((segment) => anchorClassNames.has(segment) || exactSymbols.has(segment));
      }
      return false;
    })
    .sort((left, right) =>
      structuralKindRank(left.kind) - structuralKindRank(right.kind) ||
      left.filePath.localeCompare(right.filePath) ||
      left.qualifiedName.localeCompare(right.qualifiedName)
    );
}

export function toFusionNode(node: SnapshotNode, allNodes: readonly SnapshotNode[] = [], score = 1): FastFusionNode {
  const structuralContext = sameFileStructuralContext(node, allNodes).map((item) => item.qualifiedName);
  const snippet = node.sourceSnippet ? singleLineSnippet(node.sourceSnippet, 420) : '';
  const evidenceTokens = sourceEvidenceTokens(node).slice(0, 64);
  const content = compactContent([
    `path ${node.filePath}`,
    evidenceTokens.length > 0 ? `tokens ${evidenceTokens.join(' ')}` : '',
    node.signature || node.qualifiedName || node.name,
    node.docstring ?? '',
    snippet ? `source ${snippet}` : '',
    structuralContext.length > 0 ? `context ${structuralContext.join(' ')}` : '',
    (node.calls?.length ?? 0) > 0 ? `calls ${(node.calls ?? []).slice(0, 8).join(' ')}` : ''
  ].filter(Boolean).join('\n'));
  return {
    nodeId: node.id,
    filePath: node.filePath,
    language: node.language,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    ...(node.signature ? { signature: node.signature } : {}),
    contentHash: '',
    score,
    sources: ['graph'],
    sourceScores: { graph: score },
    content
  };
}

function sameFileStructuralContext(node: SnapshotNode, allNodes: readonly SnapshotNode[]): SnapshotNode[] {
  return allNodes
    .filter((candidate) =>
      candidate.id !== node.id &&
      candidate.filePath === node.filePath &&
      (candidate.kind === 'class' || candidate.kind === 'interface')
    )
    .sort((left, right) =>
      structuralKindRank(left.kind) - structuralKindRank(right.kind) ||
      left.qualifiedName.localeCompare(right.qualifiedName)
    )
    .slice(0, 4);
}

function structuralKindRank(kind: string): number {
  return kind === 'class' ? 0 : 1;
}

type FastSemanticNode = FastFusionNode;

interface FastFreshnessState {
  fresh: number;
  pending: number;
  stale: number;
  failed: number;
  total: number;
  isFresh: boolean;
  warnings: string[];
}

function normalizeFastFreshness(
  freshness: FastFreshnessState | undefined,
  warnings: readonly string[] = []
): FastFreshnessState & { entries: [] } {
  const mergedWarnings = [...new Set([...(freshness?.warnings ?? []), ...warnings])];
  return {
    fresh: freshness?.fresh ?? 0,
    pending: freshness?.pending ?? 0,
    stale: freshness?.stale ?? 0,
    failed: freshness?.failed ?? 0,
    total: freshness?.total ?? 0,
    isFresh: freshness?.isFresh ?? true,
    warnings: mergedWarnings,
    entries: []
  };
}

interface FastEmbeddingScope {
  profile: string;
  chunkerVersion: string;
}

interface FastEmbeddingMetadataCachePayload {
  entries: Record<string, string>;
  dbMtimeMs?: number;
}

interface GraphIndex {
  nodes: readonly SnapshotNode[];
  nodesByCallName: Map<string, SnapshotNode[]>;
  callersByNodeId: Map<string, SnapshotNode[]>;
}

interface RelatedNode {
  relation: string;
  node: SnapshotNode;
}

function summarizeEvidence(nodes: readonly FastFusionNode[], query: string): string {
  const parts = [
    `query ${query}`,
    ...nodes.flatMap((node) => [
      node.filePath,
      node.qualifiedName,
      ...Object.keys(node.sourceScores),
      node.content
    ])
  ];
  return [...new Set(tokenize(parts.join(' ')))].slice(0, 180).join(' ');
}

export async function readFastSemanticAugments(
  projectPath: string,
  query: string,
  topk: number,
  snapshotNodes: readonly SnapshotNode[],
  options: { skipVectorSearch?: boolean } = {}
): Promise<{ nodes: FastSemanticNode[]; freshness?: FastFreshnessState; warnings: string[]; vectorHits: number }> {
  const parsed = parseFusionQuery(query);
  const includeFreshness = shouldLoadFastFreshness(query);
  const directFreshness = includeFreshness ? readFastFreshnessState(projectPath) : null;
  if (options.skipVectorSearch && !includeFreshness) {
    const bridgeNodes = collectSemanticRoutingBridgeNodes(snapshotNodes, parsed);
    if (bridgeNodes.length > 0) {
      return { nodes: bridgeNodes.slice(0, topk), warnings: [], vectorHits: 0 };
    }
    return { nodes: [], warnings: [], vectorHits: 0 };
  }
  if (options.skipVectorSearch && includeFreshness) {
    if (directFreshness) {
      return { nodes: [], freshness: directFreshness, warnings: directFreshness.warnings, vectorHits: 0 };
    }
  }

  const embeddingConfig = await import('./vector/embedding/config.js');
  const embedding = embeddingConfig.resolveActiveEmbedding(projectPath);
  const freshnessByFile = new Map<string, { state: ManifestState }>();
  let freshness: FastFreshnessState | undefined = directFreshness ?? undefined;
  let warnings: string[] = directFreshness ? [...directFreshness.warnings] : [];
  if (includeFreshness) {
    const manifestModule = await import('./freshness/manifest.js');
    const manifest = manifestModule.VectorManifestStore.open(projectPath, embedding.profile, embedding.chunkerVersion);
    const manifestSnapshot = manifest.snapshot();
    if (!directFreshness) {
      warnings = [...manifestSnapshot.warnings];
      freshness = {
        fresh: manifestSnapshot.fresh,
        pending: manifestSnapshot.pending,
        stale: manifestSnapshot.stale,
        failed: manifestSnapshot.failed,
        total: manifestSnapshot.total,
        isFresh: manifestSnapshot.isFresh,
        warnings
      };
    }
    if (!options.skipVectorSearch) {
      for (const entry of manifestSnapshot.entries) {
        freshnessByFile.set(entry.filePath, { state: entry.state });
      }
    }
  }
  if (options.skipVectorSearch) {
    return { nodes: [], ...(freshness ? { freshness } : {}), warnings, vectorHits: 0 };
  }
  const collectionManager = await import('./vector/collection-manager.js');
  const collection = collectionManager.openCollection(projectPath, {
    embeddingProfile: embedding.profile,
    chunkerVersion: embedding.chunkerVersion,
    queryAdapter: embedding.adapter
  });
  try {
    const candidateLimit = Math.max(topk, Math.min(topk * 2, 8));
    const results = await collection.query([{ text: query, mode: 'hybrid' }], candidateLimit);
    const currentResults = results
      .filter((result) => result.chunkerVersion === embedding.chunkerVersion)
      .filter((result) => fastSemanticResultMatchesFilters(result, parsed.filters))
      .slice(0, candidateLimit);
    const nodesById = new Map(snapshotNodes.map((node) => [node.id, node]));
    return {
      nodes: currentResults
        .map((result) => {
          const snapshotNode = nodesById.get(result.nodeId);
          const freshness = freshnessByFile.get(result.filePath);
          const score = normalizeSemanticScore(result.score);
          const baseNode = snapshotNode
            ? toFusionNode(snapshotNode, snapshotNodes, score)
            : compactResultNode(result, score);
          return {
            ...baseNode,
            filePath: result.filePath,
            contentHash: result.contentHash,
            score,
            sources: ['vector'],
            sourceScores: { vector: score },
            ...(freshness ? { freshnessState: freshness.state } : {}),
            ...(freshness && freshness.state !== 'fresh' ? { warnings: [`freshness:${freshness.state}`] } : {})
          };
        })
        .filter((node) => node.score > 0),
      ...(freshness ? { freshness } : {}),
      warnings,
      vectorHits: currentResults.length
    };
  } finally {
    collection.destroy();
  }
}

function readFastFreshnessState(projectPath: string): FastFreshnessState | null {
  const resolution = resolveFastManifestTarget(projectPath);
  const manifestPath = resolution.manifestPath;
  if (!manifestPath) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      summary?: unknown;
      warnings?: unknown;
      isFresh?: unknown;
    };
    const summary = normalizeFastManifestSummary(parsed.summary);
    if (!summary) {
      return null;
    }
    const warnings = Array.isArray(parsed.warnings)
      ? parsed.warnings.filter((value): value is string => typeof value === 'string')
      : [];
    const isFresh = typeof parsed.isFresh === 'boolean'
      ? parsed.isFresh
      : summary.pending === 0 && summary.stale === 0 && summary.failed === 0;
    return {
      ...summary,
      isFresh,
      warnings: [...new Set([...resolution.warnings, ...warnings])]
    };
  } catch {
    return null;
  }
}

function resolveFastManifestTarget(projectPath: string): { manifestPath: string | null; warnings: string[] } {
  const projectRoot = resolve(projectPath);
  const manifestsDir = join(projectRoot, FAST_ZINCGRAPH_DIR, 'manifests');
  const scope = readFastEmbeddingScope(projectPath);
  const envProfile = nonEmptyEnv('ZINCGRAPH_EMBEDDING_PROFILE');
  const envChunkerVersion = nonEmptyEnv('ZINCGRAPH_CHUNKER_VERSION');
  const cachePayload = readFastEmbeddingMetadataCache(projectRoot);
  if (scope) {
    const scopedPath = join(
      manifestsDir,
      `manifest-${fastScopeKey(scope.profile, scope.chunkerVersion)}.json`
    );
    if (existsSync(scopedPath)) {
      return {
        manifestPath: scopedPath,
        warnings: directManifestWarnings(scopedPath, listFastManifestSidecars(manifestsDir), cachePayload, {
          hasEnvScope: Boolean(envProfile || envChunkerVersion),
          projectRoot
        })
      };
    }
  }
  const sidecars = listFastManifestSidecars(manifestsDir);
  const manifestPath = sidecars.length === 1 ? sidecars[0]! : null;
  return {
    manifestPath,
    warnings: manifestPath
      ? directManifestWarnings(manifestPath, sidecars, cachePayload, {
        hasEnvScope: Boolean(envProfile || envChunkerVersion),
        projectRoot
      })
      : sidecars.length > 1
        ? [`multiple manifest sidecars detected (${sidecars.length}); embedding scope resolution is ambiguous`]
        : []
  };
}

function directManifestWarnings(
  manifestPath: string,
  sidecars: readonly string[],
  cachePayload: FastEmbeddingMetadataCachePayload | null,
  context: { hasEnvScope: boolean; projectRoot: string }
): string[] {
  const warnings = [`using manifest sidecar ${basename(manifestPath)} for freshness`];
  if (!cachePayload && !context.hasEnvScope) {
    warnings.push('embedding metadata cache missing while manifest sidecar exists');
  } else if (cachePayload && !context.hasEnvScope && !fastEmbeddingMetadataCacheIsFresh(context.projectRoot, cachePayload)) {
    warnings.push('embedding metadata cache is older than fusion.sqlite while manifest sidecar exists');
  }
  if (sidecars.length > 1) {
    warnings.push(`multiple manifest sidecars detected (${sidecars.length}); using ${basename(manifestPath)}`);
  }
  return warnings;
}

function listFastManifestSidecars(manifestsDir: string): string[] {
  if (!existsSync(manifestsDir)) {
    return [];
  }
  try {
    return readdirSync(manifestsDir)
      .filter((fileName) => /^manifest-[0-9a-f]{16}\.json$/i.test(fileName))
      .map((fileName) => join(manifestsDir, fileName));
  } catch {
    return [];
  }
}

function normalizeFastManifestSummary(value: unknown): Omit<FastFreshnessState, 'isFresh' | 'warnings'> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const summary = value as Partial<Record<'fresh' | 'pending' | 'stale' | 'failed' | 'total', unknown>>;
  const fresh = normalizeFastCount(summary.fresh);
  const pending = normalizeFastCount(summary.pending);
  const stale = normalizeFastCount(summary.stale);
  const failed = normalizeFastCount(summary.failed);
  const total = normalizeFastCount(summary.total);
  if (fresh === null || pending === null || stale === null || failed === null || total === null) {
    return null;
  }
  return { fresh, pending, stale, failed, total };
}

function normalizeFastCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function readFastEmbeddingScope(projectPath: string): FastEmbeddingScope | null {
  const projectRoot = resolve(projectPath);
  const envProfile = nonEmptyEnv('ZINCGRAPH_EMBEDDING_PROFILE');
  const envChunkerVersion = nonEmptyEnv('ZINCGRAPH_CHUNKER_VERSION');
  const cachePayload = readFastEmbeddingMetadataCache(projectRoot);
  if (!cachePayload && !envProfile && !envChunkerVersion) {
    return null;
  }
  if (cachePayload && !fastEmbeddingMetadataCacheIsFresh(projectRoot, cachePayload) && !envProfile && !envChunkerVersion) {
    return null;
  }
  return {
    profile: envProfile ?? cachePayload?.entries['embedding.profile'] ?? FAST_DEFAULT_EMBEDDING_PROFILE,
    chunkerVersion: envChunkerVersion ?? cachePayload?.entries['embedding.chunkerVersion'] ?? FAST_DEFAULT_CHUNKER_VERSION
  };
}

function readFastEmbeddingMetadataCache(projectRoot: string): FastEmbeddingMetadataCachePayload | null {
  const cachePath = join(projectRoot, FAST_ZINCGRAPH_DIR, FAST_EMBEDDING_METADATA_CACHE_FILE);
  if (!existsSync(cachePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    if ('entries' in parsed) {
      const payload = parsed as { entries?: unknown; dbMtimeMs?: unknown };
      const entries = normalizeFastStringRecord(payload.entries);
      if (!entries) {
        return null;
      }
      return {
        entries,
        ...(typeof payload.dbMtimeMs === 'number' ? { dbMtimeMs: payload.dbMtimeMs } : {})
      };
    }
    const entries = normalizeFastStringRecord(parsed);
    return entries ? { entries } : null;
  } catch {
    return null;
  }
}

function normalizeFastStringRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0)
  );
}

function fastEmbeddingMetadataCacheIsFresh(projectRoot: string, cachePayload: FastEmbeddingMetadataCachePayload): boolean {
  const dbPath = join(projectRoot, FAST_ZINCGRAPH_DIR, FAST_FUSION_STORE_FILE);
  if (!existsSync(dbPath)) {
    return true;
  }
  if (typeof cachePayload.dbMtimeMs !== 'number') {
    return false;
  }
  const dbMtimeMs = readFastMtimeMs(dbPath);
  return dbMtimeMs !== null && cachePayload.dbMtimeMs >= dbMtimeMs;
}

function readFastMtimeMs(filePath: string): number | null {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function nonEmptyEnv(key: string): string | undefined {
  const value = process.env[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function fastScopeKey(embeddingProfile: string, chunkerVersion: string): string {
  return createHash('sha256')
    .update(`${embeddingProfile}\0${chunkerVersion}`)
    .digest('hex')
    .slice(0, 16);
}

function mergeFastFullJsonNodes(
  snapshotNodes: readonly SnapshotNode[],
  graphNodes: readonly FastSemanticNode[],
  semanticNodes: readonly FastSemanticNode[],
  resultLimit: number,
  requestedTopk: number,
  query: string
): FastSemanticNode[] {
  const primaryNodes = mergeFusionNodes(graphNodes, semanticNodes, resultLimit, query);
  const supplementalNodes = buildSupplementalEvidenceNodes(snapshotNodes, query, primaryNodes, requestedTopk);
  return [...primaryNodes, ...supplementalNodes];
}

function buildSupplementalEvidenceNodes(
  snapshotNodes: readonly SnapshotNode[],
  query: string,
  primaryNodes: readonly FastSemanticNode[],
  requestedTopk: number
): FastSemanticNode[] {
  const parsed = parseFusionQuery(query);
  if (!isAnchorRichQuery(parsed) || primaryNodes.length === 0) {
    return [];
  }

  const queryParts = query.trim().split(/\s+/).filter(Boolean);
  const familyTokens = queryFamilyTokens(queryParts);
  const connectorScopes = queryConnectorScopes(queryParts);
  const pathQueries = uniqueInOrder([
    ...(parsed.filters.file ? [parsed.filters.file] : []),
    ...(parsed.filters.path ? [parsed.filters.path] : []),
    ...queryParts.filter((part) => isPathLikeQueryPart(part))
  ]);
  const exactSymbolQueries = uniqueInOrder([
    ...(parsed.filters.name ? [parsed.filters.name] : []),
    ...queryParts.flatMap(exactSymbolQueriesFromPart)
  ]);
  const terms = tokenize(parsed.text);
  const relatedTestTokens = specificQueryTokens(query);
  const primaryNodeIds = new Set(primaryNodes.map((node) => node.nodeId));
  const snapshotById = new Map(snapshotNodes.map((node) => [node.id, node]));
  const primarySnapshotNodes = primaryNodes
    .map((node) => snapshotById.get(node.nodeId))
    .filter((node): node is SnapshotNode => Boolean(node));

  const anchorFilePaths = new Set(primarySnapshotNodes
    .filter((node) =>
      fileFamilyMatchScore(node.filePath, familyTokens, connectorScopes) > 0 ||
      pathQueries.some((queryPart) => pathMatches(node.filePath, queryPart))
    )
    .map((node) => node.filePath));
  for (const node of snapshotNodes) {
    if (!isTestPath(node.filePath) || anchorFilePaths.has(node.filePath)) {
      continue;
    }
    if (fileFamilyMatchScore(node.filePath, familyTokens, connectorScopes) <= 0) {
      continue;
    }
    const evidence = nodeEvidenceText(node);
    if (exactSymbolQueries.some((queryPart) => exactSymbolQueryMatchStrength(node, queryPart, evidence) > 0)) {
      anchorFilePaths.add(node.filePath);
    }
  }
  if (anchorFilePaths.size === 0 && familyTokens.length === 0 && pathQueries.length === 0) {
    return [];
  }

  const ranked = rankNodes(snapshotNodes, parsed, query);
  const rankIndex = new Map(ranked.map((node, index) => [node.id, index]));
  const anchorBreadth = pathQueries.length + exactSymbolQueries.length;
  const supplementalBudget = Math.max(10, Math.min(24, Math.max(Math.max(1, requestedTopk) * 4, anchorBreadth * 2)));

  const candidates = snapshotNodes
    .filter((node) => !primaryNodeIds.has(node.id))
    .map((node) => {
      const evidence = normalize(`${node.qualifiedName} ${node.name} ${node.signature ?? ''} ${node.docstring ?? ''} ${node.sourceSnippet ?? ''} ${(node.calls ?? []).join(' ')}`);
      const exactStrength = exactSymbolQueries.reduce((best, queryPart) =>
        Math.max(best, exactSymbolQueryMatchStrength(node, queryPart, evidence)),
      0);
      const familyScore = fileFamilyMatchScore(node.filePath, familyTokens, connectorScopes);
      const pathScore = pathQueries.reduce((score, queryPart) =>
        score + (pathMatches(node.filePath, queryPart) ? pathQueryMatchStrength(node, queryPart) : 0),
      0);
      const sameAnchorFile = anchorFilePaths.has(node.filePath);
      const termHits = terms.filter((term) => evidence.includes(term)).length;
      const artifactScore = supplementalArtifactScore(node, terms);
      const structuralScore = supplementalStructuralScore(node);
      const relatedTestScore = isTestPath(node.filePath) && relatedTestTokens.length > 0
        ? affectedScore(node, relatedTestTokens)
        : 0;
      const exactPathSymbolScore = pathScore > 0 && exactStrength > 0 ? pathScore + exactStrength : 0;
      const structuralSiblingScore = sameAnchorFile && structuralScore > 0 ? structuralScore : 0;
      const familyCompatible = familyTokens.length === 0 || familyScore > 0;
      const include = sameAnchorFile ||
        pathScore > 0 ||
        exactPathSymbolScore > 0 ||
        (exactStrength > 0 && familyCompatible) ||
        (relatedTestScore >= 3 && familyCompatible) ||
        structuralSiblingScore > 0 ||
        (familyScore > 0 && (exactStrength > 0 || structuralScore > 0 || artifactScore > 0 || termHits >= 2));
      return {
        node,
        include,
        sameAnchorFile,
        exactPathSymbolScore,
        structuralSiblingScore,
        exactStrength,
        familyScore,
        pathScore,
        artifactScore,
        structuralScore,
        relatedTestScore,
        termHits,
        rank: rankIndex.get(node.id) ?? Number.MAX_SAFE_INTEGER
      };
    })
    .filter((candidate) => candidate.include)
    .sort((left, right) =>
      right.exactPathSymbolScore - left.exactPathSymbolScore ||
      right.pathScore - left.pathScore ||
      right.exactStrength - left.exactStrength ||
      right.structuralSiblingScore - left.structuralSiblingScore ||
      Number(right.sameAnchorFile) - Number(left.sameAnchorFile) ||
      right.relatedTestScore - left.relatedTestScore ||
      right.structuralScore - left.structuralScore ||
      right.familyScore - left.familyScore ||
      right.artifactScore - left.artifactScore ||
      right.termHits - left.termHits ||
      left.rank - right.rank ||
      left.node.filePath.localeCompare(right.node.filePath) ||
      left.node.qualifiedName.localeCompare(right.node.qualifiedName)
    )
    .slice(0, supplementalBudget);

  const total = primaryNodes.length + candidates.length;
  return candidates.map(({ node }, index) =>
    toFusionNode(node, snapshotNodes, Math.max(0.2, normalizedGraphScore(primaryNodes.length + index, Math.max(total, 1))))
  );
}

function supplementalArtifactScore(node: SnapshotNode, terms: readonly string[]): number {
  let score = 0;
  if (isTestPath(node.filePath)) {
    score += 2;
  }
  const normalizedPath = normalize(node.filePath);
  if (/(?:^|\s)(?:unit|integration)\s+tests?(?:\s|$)/.test(normalizedPath)) {
    score += 1;
  }
  const evidence = normalize(`${node.qualifiedName} ${node.name} ${node.signature ?? ''} ${node.sourceSnippet ?? ''}`);
  for (const term of terms) {
    if (term.length >= 3 && evidence.includes(term)) {
      score += 0.25;
    }
  }
  return score;
}

function supplementalStructuralScore(node: SnapshotNode): number {
  if (node.kind === 'class' || node.kind === 'interface') {
    return 3;
  }
  if (/^(?:__init__|constructor|new)$/i.test(node.name)) {
    return 2;
  }
  return 0;
}

function nodeEvidenceText(node: SnapshotNode): string {
  return normalize(`${node.qualifiedName} ${node.name} ${node.signature ?? ''} ${node.docstring ?? ''} ${node.sourceSnippet ?? ''} ${(node.calls ?? []).join(' ')}`);
}

function mergeFusionNodes(
  graphNodes: readonly FastSemanticNode[],
  semanticNodes: readonly FastSemanticNode[],
  topk: number,
  query: string
): FastSemanticNode[] {
  const merged = new Map<string, FastSemanticNode>();
  for (const node of graphNodes) {
    merged.set(node.nodeId, { ...node });
  }
  for (const node of semanticNodes) {
    const previous = merged.get(node.nodeId);
    if (!previous) {
      merged.set(node.nodeId, { ...node });
      continue;
    }
    merged.set(node.nodeId, {
      ...previous,
      score: Math.min(1, Math.max(previous.score, node.score) + (previous.sources.includes('graph') ? node.score * 0.15 : 0)),
      sources: [...new Set([...previous.sources, ...node.sources])],
      sourceScores: { ...previous.sourceScores, ...node.sourceScores },
      content: node.content.length > previous.content.length ? node.content : previous.content,
      ...(previous.freshnessState ? { freshnessState: previous.freshnessState } : node.freshnessState ? { freshnessState: node.freshnessState } : {}),
      ...(previous.warnings || node.warnings ? { warnings: [...new Set([...(previous.warnings ?? []), ...(node.warnings ?? [])])] } : {})
    });
  }
  return [...merged.values()]
    .sort((left, right) =>
      exactFusionPriority(right, query) - exactFusionPriority(left, query) ||
      right.score - left.score ||
      left.filePath.localeCompare(right.filePath) ||
      left.qualifiedName.localeCompare(right.qualifiedName)
    )
    .slice(0, topk);
}

function normalizeSemanticScore(score: number): number {
  if (!Number.isFinite(score) || score <= 0) {
    return 0;
  }
  return Math.min(1, score);
}

function shouldUseSemanticRoutingBridgeFastPath(
  parsed: ReturnType<typeof parseFusionQuery>,
  graphNodes: readonly FastFusionNode[]
): boolean {
  if (parsed.intent !== 'semantic-ranking') {
    return false;
  }
  if (!parsed.filters.path && !parsed.filters.file) {
    return false;
  }

  const terms = new Set(parsed.terms);
  const hasOrderingSignal = ['priority', 'ranking', 'rank', 'ordering', 'relevance'].some((term) => terms.has(term));
  const hasMixedSourceSignal = ['mixed', 'multiple', 'result', 'results', 'search', 'source', 'sources'].some((term) => terms.has(term));
  if (!hasOrderingSignal || !hasMixedSourceSignal) {
    return false;
  }

  return graphNodes.some((node) => {
    const haystack = normalize(`${node.filePath} ${node.qualifiedName} ${node.content}`);
    return haystack.includes('ranking-adjuster') || haystack.includes('relevance-scorer') || haystack.includes('compression');
  });
}

function collectSemanticRoutingBridgeNodes(
  snapshotNodes: readonly SnapshotNode[],
  parsed: ReturnType<typeof parseFusionQuery>
): FastFusionNode[] {
  if (parsed.intent !== 'semantic-ranking') {
    return [];
  }
  if (!parsed.filters.path && !parsed.filters.file) {
    return [];
  }

  const terms = new Set(parsed.terms);
  const hasOrderingSignal = ['priority', 'ranking', 'rank', 'ordering', 'relevance'].some((term) => terms.has(term));
  const hasMixedSourceSignal = ['mixed', 'multiple', 'result', 'results', 'search', 'source', 'sources'].some((term) => terms.has(term));
  if (!hasOrderingSignal || !hasMixedSourceSignal) {
    return [];
  }

  const preferredCandidates = snapshotNodes.filter((node) =>
    node.filePath === 'src/fusion/intent-router.ts' &&
    /(?:parseFusionQuery|routeParsedQuery|queryTerms|routeQuery)/.test(`${node.name} ${node.qualifiedName}`)
  );
  const candidatePool = preferredCandidates.length > 0
    ? preferredCandidates
    : snapshotNodes.filter((node) => node.filePath === 'src/fusion/intent-router.ts');

  return candidatePool
    .map((node) => {
      const score = semanticRoutingBridgeScore(node, terms);
      if (score <= 0) {
        return null;
      }
      return buildSemanticRoutingBridgeNode(node, snapshotNodes, score);
    })
    .filter((node): node is FastFusionNode => node !== null)
    .sort((left, right) =>
      right.score - left.score ||
      left.filePath.localeCompare(right.filePath) ||
      left.qualifiedName.localeCompare(right.qualifiedName)
    )
    .slice(0, 2);
}

function buildSemanticRoutingBridgeNode(
  node: SnapshotNode,
  allNodes: readonly SnapshotNode[],
  score: number
): FastFusionNode {
  const structuralContext = sameFileStructuralContext(node, allNodes).map((item) => item.qualifiedName);
  const content = compactContent([
    `path ${node.filePath}`,
    node.signature || node.qualifiedName || node.name,
    node.docstring ?? '',
    node.sourceSnippet ?? '',
    structuralContext.length > 0 ? `context ${structuralContext.join(' ')}` : '',
    (node.calls?.length ?? 0) > 0 ? `calls ${(node.calls ?? []).slice(0, 8).join(' ')}` : ''
  ].filter(Boolean).join('\n'));
  return {
    nodeId: node.id,
    filePath: node.filePath,
    language: node.language,
    kind: node.kind,
    qualifiedName: node.qualifiedName,
    contentHash: '',
    score,
    sources: ['graph'],
    sourceScores: { graph: score },
    content
  };
}

function semanticRoutingBridgeScore(node: SnapshotNode, terms: ReadonlySet<string>): number {
  const normalized = normalize([
    node.filePath,
    node.qualifiedName,
    node.name,
    node.signature ?? '',
    node.docstring ?? '',
    node.sourceSnippet ?? '',
    ...(node.calls ?? [])
  ].join(' '));
  let score = 0.82;
  if (node.filePath === 'src/fusion/intent-router.ts') {
    score += 0.18;
  }
  if (normalize(node.name) === 'parsefusionquery' || /parsefusionquery/.test(normalized)) {
    score += 0.16;
  }
  if (normalize(node.name) === 'routeparsedquery' || /routeparsedquery/.test(normalized)) {
    score += 0.12;
  }
  if (normalize(node.name) === 'queryterms' || /queryterms/.test(normalized)) {
    score += 0.08;
  }
  if (normalize(node.name) === 'parsefusionquery') {
    score += 0.1;
  }
  if (normalized.includes('intent') && normalized.includes('router')) {
    score += 0.1;
  }
  if (normalized.includes('priority')) {
    score += 0.04;
  }
  if (normalized.includes('ordering')) {
    score += 0.04;
  }
  if (normalized.includes('mixed') && normalized.includes('sources')) {
    score += 0.04;
  }
  const coveredTerms = [...terms].filter((term) => normalized.includes(term)).length;
  score += Math.min(0.12, coveredTerms * 0.02);
  return Math.min(1.15, score);
}

function compactResultNode(
  result: Pick<FastFusionNode, 'nodeId' | 'filePath' | 'language' | 'kind' | 'qualifiedName' | 'contentHash'>,
  score: number
): FastFusionNode {
  return {
    nodeId: result.nodeId,
    filePath: result.filePath,
    language: result.language,
    kind: result.kind,
    qualifiedName: result.qualifiedName,
    contentHash: result.contentHash,
    score,
    sources: ['vector'],
    sourceScores: { vector: score },
    content: compactContent([
      `path ${result.filePath}`,
      result.qualifiedName,
      `kind ${result.kind}`
    ].join('\n'))
  };
}

function compactContent(content: string): string {
  return content
    .split(/\r?\n/)
    .slice(0, FAST_NODE_CONTENT_LINE_LIMIT)
    .join('\n')
    .slice(0, FAST_NODE_CONTENT_CHAR_LIMIT);
}

function singleLineSnippet(content: string, maxChars: number): string {
  return content
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

function sourceSnippetFilesForQuery(query: string): string[] {
  const parsed = parseFusionQuery(query);
  const queryParts = query.trim().split(/\s+/).filter(Boolean);
  return uniqueInOrder([
    ...(parsed.filters.file ? [parsed.filters.file] : []),
    ...queryParts.filter((part) => isPathLikeQueryPart(part) && /\.[A-Za-z0-9]{1,8}\b/.test(part))
  ]).map((part) => part.replace(/\\/g, '/'));
}

function candidateAffectedTestFiles(snapshot: Snapshot, query: string, limit: number): string[] {
  const pathQueries = sourceSnippetFilesForQuery(query);
  const tokens = specificQueryTokens(query);
  if (tokens.length === 0 || pathQueries.length === 0) {
    return [];
  }
  const pathFamilies = testPathFamiliesForQuery(query);
  const candidates = snapshot.nodes
    .filter((node) => isTestPath(node.filePath))
    .map((node) => {
      const haystack = exactTokenHaystack(node);
      const tokenScore = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
      const score = tokenScore + testPathFamilyScore(node.filePath, pathFamilies);
      return { filePath: node.filePath, score };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      left.filePath.localeCompare(right.filePath)
    );
  return uniqueInOrder(candidates.map((item) => item.filePath)).slice(0, limit);
}

function selectAffectedTopNodes(snapshot: Snapshot, query: string, requestedLimit: number): SnapshotNode[] {
  if (requestedLimit <= 0) {
    return [];
  }
  const tokens = specificQueryTokens(query);
  if (tokens.length === 0) {
    return [];
  }
  const pathFamilies = testPathFamiliesForQuery(query);
  return snapshot.nodes
    .filter((node) => isTestPath(node.filePath) && typeof node.sourceSnippet === 'string' && node.sourceSnippet.length > 0)
    .map((node) => {
      const haystack = exactTokenHaystack(node);
      const tokenScore = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
      const score = tokenScore + testPathFamilyScore(node.filePath, pathFamilies);
      return { node, score };
    })
    .filter((item) => item.score >= 3)
    .sort((left, right) =>
      right.score - left.score ||
      left.node.filePath.localeCompare(right.node.filePath) ||
      left.node.qualifiedName.localeCompare(right.node.qualifiedName)
    )
    .slice(0, Math.min(2, requestedLimit))
    .map((item) => item.node);
}

interface TestPathFamilies {
  directorySegments: readonly string[];
  fileStems: readonly string[];
  suiteSegments: readonly string[];
}

function testPathFamiliesForQuery(query: string): TestPathFamilies {
  const pathQueries = sourceSnippetFilesForQuery(query);
  const nonTestPathQueries = pathQueries.filter((queryPart) => !isTestPathQueryPart(queryPart));
  const directorySegments: string[] = [];
  const fileStems: string[] = [];
  const suiteSegments: string[] = [];
  for (const queryPart of pathQueries.filter((part) => isTestPathQueryPart(part))) {
    const normalizedPath = queryPart.replace(/\\/g, '/').toLowerCase();
    for (const segment of normalizedPath.split('/')) {
      if (/^(?:tests?|unit_tests|integration_tests)$/.test(segment)) {
        suiteSegments.push(segment);
      }
    }
  }
  for (const queryPart of nonTestPathQueries) {
    const normalizedPath = queryPart.replace(/\\/g, '/');
    const parts = normalizedPath.split('/').filter(Boolean);
    const fileName = parts.at(-1) ?? '';
    const stem = fileName.replace(/\.[^.]+$/, '');
    if (stem.length >= 4 && !TEST_PATH_FAMILY_STOP_WORDS.has(stem.toLowerCase())) {
      fileStems.push(stem.toLowerCase());
    }
    for (const segment of parts.slice(0, -1)) {
      const normalizedSegment = segment.toLowerCase();
      if (normalizedSegment.length >= 4 && !TEST_PATH_FAMILY_STOP_WORDS.has(normalizedSegment)) {
        directorySegments.push(normalizedSegment);
      }
    }
  }
  return {
    directorySegments: uniqueInOrder(directorySegments).slice(0, 8),
    fileStems: uniqueInOrder(fileStems).slice(0, 8),
    suiteSegments: uniqueInOrder(suiteSegments).slice(0, 4)
  };
}

function testPathFamilyScore(filePath: string, families: TestPathFamilies): number {
  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
  const fileName = basename(normalizedPath);
  let score = 0;
  for (const segment of families.directorySegments) {
    if (normalizedPath.includes(`/${segment}/`)) {
      score += 2;
    }
  }
  for (const stem of families.fileStems) {
    if (fileName.includes(stem) || normalizedPath.includes(`/${stem}/`)) {
      score += 2;
    }
  }
  for (const segment of families.suiteSegments) {
    if (normalizedPath.includes(`/${segment}/`)) {
      score += 2;
    }
  }
  return Math.min(6, score);
}

function selectFreshFamilyTopNodes(snapshot: Snapshot, query: string, requestedTopk: number): SnapshotNode[] {
  if (requestedTopk > 2 || sourceSnippetFilesForQuery(query).some((queryPart) => isTestPathQueryPart(queryPart))) {
    return [];
  }
  const explicitPaths = new Set(sourceSnippetFilesForQuery(query));
  const tokens = specificQueryTokens(query).filter((token) => token.length >= 5);
  if (tokens.length === 0) {
    return [];
  }
  return snapshot.nodes
    .filter((node) => !explicitPaths.has(node.filePath) && !isTestPath(node.filePath))
    .map((node) => {
      const haystack = new Set(sourceEvidenceTokens(node));
      const tokenScore = tokens.reduce((score, token) => score + (haystack.has(token) ? 1 : 0), 0);
      const utilityScore = /(?:util|utils|helper|helpers|support)$/i.test(node.name) ||
        /(?:Util|Utils|Helper|Helpers|Support)\b/.test(node.qualifiedName)
        ? 4
        : 0;
      return {
        node,
        score: tokenScore + utilityScore + (node.kind === 'class' || node.kind === 'interface' ? 0.5 : 0)
      };
    })
    .filter((item) => item.score >= 2)
    .sort((left, right) =>
      right.score - left.score ||
      left.node.filePath.length - right.node.filePath.length ||
      left.node.filePath.localeCompare(right.node.filePath) ||
      left.node.qualifiedName.localeCompare(right.node.qualifiedName)
    )
    .slice(0, 1)
    .map((item) => item.node);
}

function exactTokenHaystack(node: SnapshotNode): string {
  return sourceEvidenceTokens(node).join(' ');
}

function sourceEvidenceTokens(node: SnapshotNode): string[] {
  const tokens = uniqueInOrder([
    ...extractExactTokens(node.filePath),
    ...identifierWords(node.filePath),
    ...extractExactTokens(node.name),
    ...identifierWords(node.name),
    ...extractExactTokens(node.qualifiedName),
    ...identifierWords(node.qualifiedName),
    ...(node.calls ?? []).flatMap(extractExactTokens),
    ...(node.calls ?? []).flatMap(identifierWords),
    ...extractExactTokens(node.signature ?? ''),
    ...identifierWords(node.signature ?? ''),
    ...extractExactTokens(node.docstring ?? ''),
    ...identifierWords(node.docstring ?? ''),
    ...extractExactTokens(node.sourceSnippet ?? ''),
    ...identifierWords(node.sourceSnippet ?? '')
  ]).filter((token) => token.length > 1 && !/^\d+$/.test(token));
  return uniqueInOrder([
    ...tokens,
    ...tokens.flatMap((token) => token.endsWith('s') && token.length > 3 ? [token.slice(0, -1)] : [])
  ]);
}

function specificQueryTokens(query: string): string[] {
  const stop = new Set([
    'src', 'lib', 'core', 'api', 'app', 'apps', 'pkg', 'public', 'private',
    'tests', 'test', 'unit_tests', 'integration_tests', 'tools', 'cli',
    'main', 'index', 'file', 'path', 'route', 'routes', 'models', 'model'
  ]);
  return uniqueInOrder(query
    .split(/\s+/)
    .flatMap((part) => [
      ...extractExactTokens(part),
      ...identifierWords(part),
      ...part.split(/[_:./\\-]+/).flatMap(extractExactTokens)
    ])
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 3 && !stop.has(token) && !/^\d+$/.test(token)));
}

function extractExactTokens(text: string): string[] {
  return text
    .split(/[^A-Za-z0-9_]+/g)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function exactFusionPriority(node: FastFusionNode, query: string): number {
  const exact = canonical(stripFieldFilters(query));
  if (!exact) {
    return 0;
  }
  const qualified = canonical(node.qualifiedName);
  const tail = canonical(node.qualifiedName.split(/[:.#]/).pop() ?? node.qualifiedName);
  if (qualified === exact || tail === exact) {
    return 2;
  }
  return canonical(node.content).includes(exact) ? 1 : 0;
}

async function readFastRegistryNodes(projectPath: string, query: string, topk: number): Promise<FastFusionNode[] | null> {
  const strippedQuery = stripFieldFilters(query);
  if (!FAST_REGISTRY_QUERY_PATTERN.test(strippedQuery)) {
    return null;
  }
  const requiredFiles: string[] = [];
  const registrySurfaceQuery = /\b(?:tool\s+registry|zincgraph_(?:semantic_search|dedup_check))\b/i.test(strippedQuery);
  const freshnessSurfaceQuery = /\b(auto\s+sync|fresh|freshness|stale|pending|manifest|vector|changed\s+files?)\b/i.test(strippedQuery);
  if (registrySurfaceQuery) {
    requiredFiles.push('src/mcp/tool-registry.ts');
  }
  if (freshnessSurfaceQuery) {
    requiredFiles.push(
      'src/freshness/auto-sync.ts',
      'src/freshness/manifest.ts',
      'src/freshness/freshness-gate.ts',
      'src/vector/code-to-vectors.ts'
    );
  }
  if (requiredFiles.length === 0) {
    requiredFiles.push('src/mcp/tool-registry.ts');
  }
  if (requiredFiles.some((filePath) => !existsSync(resolve(projectPath, filePath)))) {
    return null;
  }
  const terms = tokenize(strippedQuery);
  const ranked = FAST_REGISTRY_NODES
    .map((node) => ({
      node,
      score: registryScore(node, terms, query)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.node.filePath.localeCompare(right.node.filePath))
    .slice(0, Math.max(3, Math.min(topk, FAST_REGISTRY_NODES.length)));
  if (ranked.length === 0) {
    return null;
  }
  return ranked.map(({ node, score }) => ({
    nodeId: node.nodeId,
    filePath: node.filePath,
    language: node.language,
    kind: node.kind,
    qualifiedName: node.qualifiedName,
    contentHash: '',
    score,
    sources: ['registry'],
    sourceScores: { registry: score },
    content: node.content
  }));
}

function registryScore(
  node: typeof FAST_REGISTRY_NODES[number],
  terms: readonly string[],
  query: string
): number {
  const haystack = canonical([node.qualifiedName, node.filePath, node.content, ...node.aliases].join(' '));
  const exact = canonical(stripFieldFilters(query));
  let score = exact && canonical(node.qualifiedName) === exact ? 5 : 0;
  for (const term of terms) {
    if (haystack.includes(term)) {
      score += 1;
    }
  }
  return score;
}

function shouldLoadFastFreshness(query: string): boolean {
  return /\b(fresh|freshness|stale|pending|manifest)\b/i.test(stripFieldFilters(query));
}

function isExplicitAnchorBundleQuery(query: string): boolean {
  const parts = stripFieldFilters(query).trim().split(/\s+/).filter(Boolean);
  return parts.length >= 2 && parts.every((part) => isPathLikeQueryPart(part) || isLikelyExactSymbolQuery(part));
}

function shouldUseGraphOnlyFastPath(query: string, graphNodes: readonly FastFusionNode[]): boolean {
  const stripped = stripFieldFilters(query);
  if (!stripped) {
    return false;
  }
  const parts = stripped.trim().split(/\s+/).filter(Boolean);
  const anchorParts = parts.filter((part) => isPathLikeQueryPart(part) || isLikelyExactSymbolQuery(part));
  const exactAnchorCount = parts.filter((part) => isLikelyExactSymbolQuery(part)).length;
  const distinctFiles = new Set(graphNodes.map((node) => node.filePath)).size;
  const denseGraph = distinctFiles <= 2;
  const familyTokens = queryFamilyTokens(parts);
  const connectorScopes = queryConnectorScopes(parts);
  if (
    familyTokens.length > 0 &&
    isAnchorRichQuery(parseFusionQuery(stripped)) &&
    graphNodes.some((node) => fileFamilyMatchScore(node.filePath, familyTokens, connectorScopes) > 0)
  ) {
    return true;
  }
  if (graphNodes.some((node) => exactFusionPriority(node, stripped) >= 2)) {
    return denseGraph || (anchorParts.length <= 2 && exactAnchorCount <= 1);
  }
  if (isExplicitAnchorBundleQuery(stripped)) {
    return true;
  }
  if (/\b(similar|ranking|relevance|feedback|compression)\b/i.test(stripped)) {
    return false;
  }
  const graphAnchored = /\b(auto\s+sync|changed\s+files?|manifest|stale|pending|fresh|review|dedup|mcp|tool\s+registry|vector)\b/i.test(stripped);
  return graphAnchored && distinctFiles >= 2;
}

function buildGraphIndex(nodes: readonly SnapshotNode[]): GraphIndex {
  const nodesByCallName = new Map<string, SnapshotNode[]>();
  const callersByNodeId = new Map<string, SnapshotNode[]>();
  for (const node of nodes) {
    for (const key of callKeys(node)) {
      const bucket = nodesByCallName.get(key) ?? [];
      bucket.push(node);
      nodesByCallName.set(key, bucket);
    }
  }
  for (const caller of nodes) {
    for (const callee of calleesFor(caller, { nodesByCallName })) {
      const bucket = callersByNodeId.get(callee.id) ?? [];
      bucket.push(caller);
      callersByNodeId.set(callee.id, bucket);
    }
  }
  return { nodes, nodesByCallName, callersByNodeId };
}

function callKeys(node: SnapshotNode): string[] {
  return [...new Set([
    normalize(node.name),
    normalize(node.qualifiedName)
  ])].filter(Boolean);
}

function calleesFor(node: SnapshotNode, graph: Pick<GraphIndex, 'nodesByCallName'>): SnapshotNode[] {
  const callees = new Map<string, SnapshotNode>();
  for (const call of node.calls ?? []) {
    const candidates = graph.nodesByCallName.get(normalize(call)) ?? [];
    for (const candidate of candidates) {
      callees.set(candidate.id, candidate);
    }
  }
  return [...callees.values()];
}

function collectRelatedNodes(seeds: readonly SnapshotNode[], graph: GraphIndex): RelatedNode[] {
  const related: RelatedNode[] = [];
  for (const seed of seeds) {
    related.push({ relation: 'seed', node: seed });
    for (const caller of graph.callersByNodeId.get(seed.id) ?? []) {
      related.push({ relation: 'caller', node: caller });
    }
    for (const callee of calleesFor(seed, graph)) {
      related.push({ relation: 'callee', node: callee });
    }
    for (const reference of referencesFor(seed, graph)) {
      related.push({ relation: 'reference', node: reference });
    }
  }
  return uniqueRelated(related);
}

function referencesFor(seed: SnapshotNode, graph: GraphIndex): SnapshotNode[] {
  const needles = [seed.name, seed.qualifiedName].map(normalize).filter(Boolean);
  return graph.nodes.filter((node) =>
    node.id !== seed.id &&
    needles.some((needle) =>
      normalize(`${node.signature ?? ''} ${node.docstring ?? ''} ${node.sourceSnippet ?? ''} ${(node.calls ?? []).join(' ')}`).includes(needle)
    )
  );
}

function uniqueRelated(items: readonly RelatedNode[]): RelatedNode[] {
  const seen = new Set<string>();
  const result: RelatedNode[] = [];
  for (const item of items) {
    const key = `${item.relation}:${item.node.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

function formatGraphLine(relation: string, node: SnapshotNode, graph: GraphIndex): string {
  const callers = (graph.callersByNodeId.get(node.id)?.map((caller) => caller.qualifiedName) ?? []).slice(0, 3);
  const callees = calleesFor(node, graph).map((callee) => callee.qualifiedName).slice(0, 3);
  return [
    relation,
    node.kind,
    node.qualifiedName,
    node.filePath,
    callers.length ? `callers ${callers.join(' ')}` : '',
    callees.length ? `callees ${callees.join(' ')}` : ''
  ].filter(Boolean).join(' ');
}

interface BarrelFileReference {
  filePath: string;
  exports: string[];
}

const BARREL_FILENAMES = ['index.ts', 'index.mts', 'index.cts', 'index.js', 'index.mjs', 'index.cjs'] as const;

function collectBarrelFiles(
  snapshot: Snapshot,
  seeds: readonly SnapshotNode[],
  project: string
): BarrelFileReference[] {
  if (seeds.length === 0) {
    return [];
  }

  const candidatePaths = new Set<string>();
  for (const file of snapshot.files) {
    if (isBarrelFile(file.path)) {
      candidatePaths.add(file.path.replace(/\\/g, '/'));
    }
  }
  for (const seed of seeds) {
    const normalizedSeedPath = seed.filePath.replace(/\\/g, '/');
    let directory = dirname(normalizedSeedPath);
    while (directory && directory !== '.' && directory !== '/') {
      for (const barrelName of BARREL_FILENAMES) {
        candidatePaths.add(`${directory}/${barrelName}`);
      }
      directory = dirname(directory);
    }
    for (const barrelName of BARREL_FILENAMES) {
      candidatePaths.add(barrelName);
    }
  }
  if (candidatePaths.size === 0) {
    return [];
  }

  const seedNeedles = new Set<string>();
  for (const seed of seeds) {
    for (const value of [seed.name, seed.qualifiedName, seed.qualifiedName.split(/[:.#]/).pop() ?? seed.qualifiedName]) {
      const normalized = normalize(value);
      if (normalized) {
        seedNeedles.add(normalized);
      }
    }
  }

  const references: BarrelFileReference[] = [];
  for (const filePath of candidatePaths) {
    const content = readBarrelContent(project, filePath);
    if (!content) {
      continue;
    }
    const exportedNames = extractExportedNames(content);
    if (exportedNames.length === 0) {
      continue;
    }
    const normalizedContent = normalize(content);
    const matchedExports = exportedNames.filter((exported) =>
      seedNeedles.has(normalize(exported)) || normalizedContent.includes(normalize(exported))
    );
    if (matchedExports.length === 0 && !seedNeedlesHasContentMatch(seedNeedles, normalizedContent)) {
      continue;
    }
    references.push({
      filePath,
      exports: matchedExports.length > 0 ? matchedExports : exportedNames.slice(0, 8)
    });
  }

  return references.sort((left, right) => left.filePath.localeCompare(right.filePath));
}

function seedNeedlesHasContentMatch(seedNeedles: ReadonlySet<string>, normalizedContent: string): boolean {
  for (const needle of seedNeedles) {
    if (normalizedContent.includes(needle)) {
      return true;
    }
  }
  return false;
}

function isBarrelFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return /(^|\/)index\.[cm]?[jt]s$/.test(normalized) || normalized.endsWith('/index.ts');
}

function readBarrelContent(project: string, filePath: string): string | null {
  try {
    const absolutePath = resolve(project, filePath);
    if (!existsSync(absolutePath)) {
      return null;
    }
    return readFileSync(absolutePath, 'utf8');
  } catch {
    return null;
  }
}

function extractExportedNames(content: string): string[] {
  const names = new Set<string>();
  const exportPattern = /export\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"][^'"]+['"]/g;
  for (const match of content.matchAll(exportPattern)) {
    const block = match[1] ?? '';
    for (const entry of block.split(',')) {
      const candidate = entry.trim();
      if (!candidate) {
        continue;
      }
      const exported = candidate.split(/\s+as\s+/i).pop()?.trim();
      if (exported) {
        names.add(exported);
      }
    }
  }

  const starExportPattern = /export\s+\*\s+from\s+['"][^'"]+['"]/g;
  if ([...content.matchAll(starExportPattern)].length > 0) {
    names.add('*');
  }

  return [...names];
}

function formatBarrelLine(filePath: string, exports: readonly string[]): string {
  const exportList = exports.slice(0, 8);
  return [
    'file',
    filePath,
    exportList.length > 0 ? `exports ${exportList.join(' ')}` : ''
  ].filter(Boolean).join(' ');
}

function parseChangedFiles(query: string): string[] {
  return [...new Set(query
    .split(/\s+/)
    .map((part) => part.trim().replace(/\\/g, '/'))
    .filter((part) => part.length > 0 && !part.startsWith('-')))];
}

function affectedTokens(changedFiles: readonly string[], changedNodes: readonly SnapshotNode[]): string[] {
  const fileTokens = changedFiles.flatMap((file) => tokenize(file.replace(/\.[^.]+$/, '')));
  const nodeTokens = changedNodes.flatMap((node) => tokenize(`${node.name} ${node.qualifiedName} ${node.filePath}`));
  return [...new Set([...fileTokens, ...nodeTokens])].filter((token) => token.length > 2);
}

function affectedScore(node: SnapshotNode, tokens: readonly string[]): number {
  const haystack = normalize(`${node.filePath} ${node.name} ${node.qualifiedName} ${node.signature ?? ''} ${node.docstring ?? ''} ${node.sourceSnippet ?? ''} ${(node.calls ?? []).join(' ')}`);
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function pathMatches(filePath: string, changedFile: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedChanged = changedFile.replace(/\\/g, '/');
  return normalizedPath === normalizedChanged || normalizedPath.endsWith(`/${normalizedChanged}`);
}

function isTestPath(filePath: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
  return /(?:^|\/)(?:tests|unit_tests|integration_tests|__tests__)(?:\/|$)/.test(normalizedPath) ||
    /(?:^|\/)src\/test(?:\/|$)/.test(normalizedPath) ||
    normalizedPath.startsWith('tests/') ||
    /\.test\.[cm]?[jt]sx?$/.test(normalizedPath) ||
    /\.spec\.[cm]?[jt]sx?$/.test(normalizedPath);
}

async function printRealAutoSync(options: { project: string; files: string[] }): Promise<void> {
  if (options.files.length === 0) {
    throw new Error('Auto-sync requires at least one changed file.');
  }
  const { runAutoSyncOnce } = await import('./freshness/auto-sync.js');
  const result = await runAutoSyncOnce(options.project, {
    files: options.files,
    source: 'cli'
  }, {
    debounceMs: 0
  });
  console.log(JSON.stringify(summarizeAutoSyncResult(result)));
}

async function printRealDedup(options: { project: string; describe: string; threshold: number; topk: number }): Promise<void> {
  const { runDedupCommand } = await import('./behavior/dedup-command.js');
  const result = await runDedupCommand({
    projectPath: options.project,
    describe: options.describe,
    threshold: options.threshold,
    topk: options.topk
  });
  console.log(result.output);
}

function stripFieldFilters(query: string): string {
  return query.split(/\s+/).filter((part) => !/^[A-Za-z][A-Za-z0-9_-]*:.+/.test(part)).join(' ').trim() || query;
}

function fastSnapshotNodeMatchesFilters(
  node: Pick<SnapshotNode, 'kind' | 'language' | 'filePath' | 'qualifiedName'>,
  filters: ScalarFilters
): boolean {
  if (filters.kind && node.kind !== filters.kind) {
    return false;
  }
  if (filters.language && node.language !== filters.language) {
    return false;
  }
  if (filters.file && node.filePath !== filters.file) {
    return false;
  }
  if (filters.path && !node.filePath.startsWith(filters.path)) {
    return false;
  }
  return true;
}

function fastSemanticResultMatchesFilters(
  node: Pick<FastFusionNode, 'kind' | 'language' | 'filePath' | 'qualifiedName'>,
  filters: ScalarFilters
): boolean {
  if (!fastSnapshotNodeMatchesFilters(node, filters)) {
    return false;
  }
  if (filters.name && !normalize(node.qualifiedName).includes(normalize(filters.name))) {
    return false;
  }
  return true;
}

function tokenize(text: string): string[] {
  return [...new Set(normalize(text).split(/\s+/).filter((term) => term.length > 1 && !/^\d+$/.test(term)))];
}

function normalize(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-./:(){}[\],;<>+=!?'"`|\\]+/g, ' ')
    .toLowerCase();
}

function canonical(text: string): string {
  return text.replace(/[^A-Za-z0-9_$]+/g, '').toLowerCase();
}

function loadSnapshotModule(): Promise<typeof import('./vector/codegraph-snapshot.js')> {
  cachedSnapshotModule ??= import('./vector/codegraph-snapshot.js');
  return cachedSnapshotModule;
}

async function delegateToFullCli(): Promise<void> {
  const fullCliPath = './cli-full.js';
  const { buildCli } = await import(fullCliPath);
  await buildCli().parseAsync(process.argv);
}

function parseAutoSyncArgs(args: string[]): { project: string; files: string[] } {
  let project = process.cwd();
  const files: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (index === 0 && !arg.startsWith('-')) {
      project = arg;
    } else if (arg === '--file') {
      const value = args[++index];
      if (value) files.push(value);
    }
  }
  return { project: resolve(project), files };
}

function parseDedupArgs(args: string[]): { project: string; describe: string; threshold: number; topk: number } {
  let project = process.cwd();
  let describe = '';
  let threshold = 0.85;
  let topk = 5;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--describe') {
      describe = args[++index] ?? '';
    } else if (arg === '-p' || arg === '--project') {
      project = args[++index] ?? project;
    } else if (arg === '--threshold') {
      threshold = Number.parseFloat(args[++index] ?? String(threshold)) || threshold;
    } else if (arg === '--topk') {
      topk = Number.parseInt(args[++index] ?? String(topk), 10) || topk;
    }
  }
  return { project, describe, threshold, topk };
}

export function summarizeAutoSyncResult(result: {
  projectPath: string;
  source: string;
  startedAt: number;
  completedAt: number;
  transitions: Array<{
    filePath: string;
    stale: { state: string };
    pending?: { state: string };
    fresh?: { state: string; docIds?: readonly string[] };
    failed?: { state: string; error?: string };
  }>;
  warnings: string[];
}) {
  return {
    projectPath: result.projectPath,
    source: result.source,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    durationMs: Math.max(0, result.completedAt - result.startedAt),
    transitions: result.transitions.map((transition) => ({
      filePath: transition.filePath,
      states: [transition.stale.state, transition.pending?.state, transition.fresh?.state, transition.failed?.state].filter(Boolean),
      ...(transition.fresh?.docIds ? { docCount: transition.fresh.docIds.length } : {}),
      ...(transition.failed?.error ? { error: transition.failed.error } : {})
    })),
    warnings: result.warnings
  };
}

export function isMainModule(entryPath: string | undefined = process.argv[1]): boolean {
  return Boolean(entryPath && import.meta.url === pathToFileURL(entryPath).href);
}

function isCompiledCliEntry(entryPath: string | undefined = process.argv[1]): boolean {
  if (!entryPath) {
    return false;
  }
  const normalized = resolve(entryPath).replace(/\\/g, '/').toLowerCase();
  return normalized.endsWith('/dist/cli.js');
}

if (isMainModule() || isCompiledCliEntry()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
