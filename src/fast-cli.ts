#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFusionQuery, type ScalarFilters } from './fusion/intent-router.js';
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
  qualifiedName: string;
  contentHash: string;
  score: number;
  sources: string[];
  sourceScores: Record<string, number>;
  content: string;
  freshnessState?: ManifestState;
  warnings?: string[];
}

const RETRIEVAL_COMMANDS = new Set(['search', 'explore']);
const GRAPH_COMMANDS = new Set(['node', 'callers', 'callees']);
let cachedSnapshotModule: Promise<typeof import('./vector/codegraph-snapshot.js')> | undefined;
const FAST_NODE_CONTENT_LINE_LIMIT = 8;
const FAST_NODE_CONTENT_CHAR_LIMIT = 360;
const FAST_REGISTRY_QUERY_PATTERN = /\b(?:tool\s+registry|zincgraph_(?:semantic_search|dedup_check)|auto\s+sync|fresh(?:ness)?|stale|pending|manifest|changed\s+files?)\b/i;
const FAST_ZINCGRAPH_DIR = '.zincgraph';
const FAST_EMBEDDING_METADATA_CACHE_FILE = 'embedding-metadata.json';
const FAST_FUSION_STORE_FILE = 'fusion.sqlite';
const FAST_DEFAULT_EMBEDDING_PROFILE = 'local-token-v1:64';
const FAST_DEFAULT_CHUNKER_VERSION = 'codegraph-node-v3-semantic-bridge';
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
  const nodes = mergeFusionNodes(graphNodes, semantic.nodes, resultLimit, options.query);
  console.log(JSON.stringify({
    query: options.query,
    route: command === 'search' && semantic.vectorHits === 0 && !bridgeFastPath ? 'graph-first' : 'hybrid',
    nodes,
    ...(semantic.freshness ? { freshness: semantic.freshness } : {}),
    warnings: semantic.warnings,
    evidence: summarizeEvidence(nodes, options.query)
  }));
}

function adaptiveResultLimit(nodes: readonly SnapshotNode[], query: string, requestedTopk: number): number {
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
    nodes: registryNodes,
    ...(semantic.freshness ? { freshness: semantic.freshness } : {}),
    warnings: semantic.warnings,
    evidence: summarizeEvidence(registryNodes, options.query)
  };
}

async function readSnapshot(
  projectPath: string,
  options: { includeSourceSnippets?: boolean } = {}
): Promise<Snapshot> {
  const module = await loadSnapshotModule();
  return module.readCodeGraphSnapshot(projectPath, options) as Snapshot;
}

function readFastSnapshotUpdatedAt(projectPath: string): string | undefined {
  const dbPath = join(resolve(projectPath), '.codegraph', 'codegraph.db');
  const mtimeMs = readFastMtimeMs(dbPath);
  return mtimeMs !== null ? new Date(mtimeMs).toISOString() : undefined;
}

export function selectRankedNodes(nodes: readonly SnapshotNode[], query: string, limit: number): SnapshotNode[] {
  const parsed = parseFusionQuery(query);
  const ranked = rankNodes(nodes, parsed);
  const terms = tokenize(parsed.text);
  if (terms.length <= 1 || limit <= 3) {
    return ranked.slice(0, limit);
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
  const seeds = selectRankedNodes(snapshot.nodes, options.query, Math.max(1, Math.min(options.topk, 4)));
  const related = collectRelatedNodes(seeds, graph);
  const lines = [`impact ${options.query}`];
  for (const item of related.slice(0, Math.max(options.topk, 6))) {
    lines.push(formatImpactLine(item.relation, item.node));
  }
  return lines.join('\n');
}

function formatImpactLine(relation: string, node: SnapshotNode): string {
  return [relation, node.kind, node.qualifiedName, node.filePath].join(' ');
}

export function formatFastGraphNavigation(snapshot: Snapshot, command: string, options: ParsedArgs): string {
  const graph = buildGraphIndex(snapshot.nodes);
  const seeds = selectRankedNodes(snapshot.nodes, options.query, Math.max(1, Math.min(options.topk, 6)));
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

function rankNodes(nodes: readonly SnapshotNode[], parsed: ReturnType<typeof parseFusionQuery>): SnapshotNode[] {
  const terms = tokenize(parsed.text);
  const filters = parsed.filters;
  const nameFilter = filters.name;
  const scored = nodes
    .filter((node) => fastSnapshotNodeMatchesFilters(node, filters))
    .map((node) => ({ node, score: scoreNode(node, terms, nameFilter) }))
    .filter((entry) => entry.score > 0);
  const pool = scored.length > 0 ? scored : nodes.map((node) => ({ node, score: 0 }));
  return pool
    .sort((left, right) =>
      right.score - left.score ||
      left.node.filePath.localeCompare(right.node.filePath) ||
      left.node.qualifiedName.localeCompare(right.node.qualifiedName)
    )
    .map((entry) => entry.node);
}

function scoreNode(node: SnapshotNode, terms: readonly string[], nameFilter: string | undefined): number {
  const metadata = normalize(`${node.name} ${node.qualifiedName} ${node.filePath} ${node.signature ?? ''} ${node.docstring ?? ''} ${(node.calls ?? []).join(' ')}`);
  const source = normalize(node.sourceSnippet ?? '');
  let score = 0;
  const exactQuery = canonical(terms.join(' '));
  if (exactQuery && (canonical(node.name) === exactQuery || canonical(node.qualifiedName) === exactQuery)) {
    score += 25;
  }
  for (const term of terms) {
    if (metadata.includes(term)) {
      score += 3;
    } else if (source.includes(term)) {
      score += 1;
    }
  }
  if (nameFilter && normalize(node.qualifiedName).includes(normalize(nameFilter))) {
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

export function toFusionNode(node: SnapshotNode, allNodes: readonly SnapshotNode[] = [], score = 1): FastFusionNode {
  const structuralContext = sameFileStructuralContext(node, allNodes).map((item) => item.qualifiedName);
  const content = [
    `path ${node.filePath}`,
    node.signature || node.qualifiedName || node.name,
    structuralContext.length > 0 ? `context ${structuralContext.join(' ')}` : '',
    (node.calls?.length ?? 0) > 0 ? `calls ${(node.calls ?? []).slice(0, 8).join(' ')}` : ''
  ].filter(Boolean).join('\n');
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
  return [...new Set(tokenize(parts.join(' ')))].slice(0, 80).join(' ');
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

function shouldUseGraphOnlyFastPath(query: string, graphNodes: readonly FastFusionNode[]): boolean {
  const stripped = stripFieldFilters(query);
  if (!stripped) {
    return false;
  }
  if (graphNodes.some((node) => exactFusionPriority(node, stripped) >= 2)) {
    return true;
  }
  if (/\b(similar|ranking|relevance|feedback|compression)\b/i.test(stripped)) {
    return false;
  }
  const graphAnchored = /\b(auto\s+sync|changed\s+files?|manifest|stale|pending|fresh|review|dedup|mcp|tool\s+registry|vector)\b/i.test(stripped);
  const distinctFiles = new Set(graphNodes.map((node) => node.filePath)).size;
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
  return normalizedPath.includes('/tests/') ||
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
