import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { FusionStore, type StoredVectorDocument } from '../freshness/fusion-store.js';
import { type FreshnessSnapshot, getFreshnessSnapshot } from '../freshness/freshness-gate.js';
import {
  buildNodeText,
  readCodeGraphSnapshot,
  type CodeGraphSnapshot,
  type CodeGraphSnapshotNode,
  type VectorDocument
} from '../vector/code-to-vectors.js';
import { DEFAULT_CHUNKER_VERSION } from '../vector/chunker.js';
import { openCollection } from '../vector/collection-manager.js';
import { detectContentType } from '../compression/compression-strategy.js';
import { tokenizeCodeText } from '../vector/embedding/local.js';
import { filterEquals, type VectorSearchResult } from '../vector/zvec-adapter.js';
import {
  applyContextBudget,
  type BehaviorAnnotation,
  type ContextBudgetResult,
  type EvidenceSource
} from './context-budget.js';
import type { FusionCompressionAdapter } from '../compression/fusion-compressor.js';
import type { RelevanceScorerAdapter } from '../compression/relevance-scorer.js';
import type { DynamicFusionPolicy, RankingAdjustments } from '../compression/ranking-adjuster.js';
import { parseFusionQuery, queryTerms, type ParsedFusionQuery, type QueryRoute, type ScalarFilters } from './intent-router.js';

export function routeWeightValue(route: QueryRoute, source: FusionSource, adjustments?: RankingAdjustments): number {
  const base = FUSION_RANKING_POLICY.routeWeights[route][source];
  const override = adjustments?.routeWeightOverrides?.[route]?.[source];
  return override ?? base;
}

export type FusionSource = EvidenceSource;

export interface FusionNode {
  nodeId: string;
  filePath: string;
  language: string;
  kind: string;
  qualifiedName: string;
  contentHash: string;
  score: number;
  sources: FusionSource[];
  sourceScores: Partial<Record<FusionSource, number>>;
  content: string;
  fileSymbols?: string[];
  freshnessState?: string;
  warnings?: string[];
  annotations?: BehaviorAnnotation[];
}

export interface FusionEdge {
  source: string;
  targetName: string;
  kind: 'calls';
}

export interface FusionPolicy {
  textBranch: string;
  nativeFts: false | string;
  relevanceMode?: 'bm25' | 'embedding' | 'hybrid';
}

export interface ContextCapsule {
  query: string;
  strippedQuery: string;
  route: QueryRoute;
  filters: ScalarFilters;
  nodes: FusionNode[];
  documents: VectorDocument[];
  edges: FusionEdge[];
  freshness: FreshnessSnapshot;
  policy: FusionPolicy;
  warnings: string[];
  context: ContextBudgetResult;
  diagnostics?: FusionQueryDiagnostics;
}

export interface FusionQueryDiagnostics {
  timingsMs: Record<string, number>;
  candidateCounts: {
    graph: number;
    vector: number;
    text: number;
    merged: number;
    output: number;
  };
  fullJsonBytes: number;
}

export interface FusionQueryOptions {
  topk?: number;
  maxTokens?: number;
}

export interface QueryEngineDependencies {
  readSnapshot(projectPath: string): CodeGraphSnapshot;
  vectorSearch(projectPath: string, text: string, topk: number, filters: ScalarFilters): Promise<VectorSearchResult[]>;
  listVectorDocuments(projectPath: string): StoredVectorDocument[];
  readFreshness(projectPath: string): FreshnessSnapshot;
  annotateCandidates?(input: ContextAnnotationInput): BehaviorAnnotationProviderOutput | Promise<BehaviorAnnotationProviderOutput>;
  compressResults?: FusionCompressionAdapter;
  relevanceScorer?: RelevanceScorerAdapter;
  relevanceMode?: 'bm25' | 'embedding' | 'hybrid';
  dynamicPolicy?: DynamicFusionPolicy;
}

export interface TopoSemanticQueryEngineOptions {
  topk?: number;
  maxTokens?: number;
  dependencies?: Partial<QueryEngineDependencies>;
}

export function setDynamicPolicy(engine: TopoSemanticQueryEngine, policy: DynamicFusionPolicy | undefined): void {
  engine.setDynamicPolicy(policy);
}

interface CandidateDraft {
  nodeId: string;
  filePath: string;
  language: string;
  kind: string;
  qualifiedName: string;
  contentHash: string;
  score: number;
  source: FusionSource;
  content: string;
}

export type BehaviorAnnotationMap = ReadonlyMap<string, readonly BehaviorAnnotation[]> | Record<string, readonly BehaviorAnnotation[]>;

export interface BehaviorAnnotationAssignment {
  nodeId?: string;
  qualifiedName?: string;
  annotations: readonly BehaviorAnnotation[];
}

export type BehaviorAnnotationProviderOutput = BehaviorAnnotationMap | readonly BehaviorAnnotationAssignment[];

export interface ContextAnnotationInput {
  snapshot: CodeGraphSnapshot;
  nodes: readonly FusionNode[];
  documents: readonly VectorDocument[];
  parsed: ParsedFusionQuery;
}

export const FUSION_RANKING_POLICY = {
  routeWeights: {
    'graph-first': { graph: 1.25, vector: 1, fts: 1 },
    'graph-first-filter': { graph: 1.25, vector: 1, fts: 1 },
    'vector-first': { graph: 1, vector: 1.35, fts: 1 },
    hybrid: { graph: 1, vector: 1, fts: 1 }
  },
  fusionBoosts: {
    multiSourceBonusPerAdditionalSource: 0.25,
    graphExactMultiplier: 1.3,
    callProximityMultiplier: 1.15
  },
  freshnessPenalties: {
    stale: 0.8,
    nonFresh: 0.7
  },
  tieBreakers: ['score-desc', 'filePath-asc', 'nodeId-asc', 'qualifiedName-asc']
} as const satisfies {
  routeWeights: Record<QueryRoute, Record<FusionSource, number>>;
  fusionBoosts: {
    multiSourceBonusPerAdditionalSource: number;
    graphExactMultiplier: number;
    callProximityMultiplier: number;
  };
  freshnessPenalties: {
    stale: number;
    nonFresh: number;
  };
  tieBreakers: readonly string[];
};

const DEFAULT_TOPK = 10;
const DEFAULT_MAX_TOKENS = 8_000;
const EXACT_SYMBOL_MATCH_BONUS = 2.5;
const EXACT_SYMBOL_OUTSIDE_FILE_MULTIPLIER = 0.55;

function measureStage<T>(timingsMs: Record<string, number>, name: string, fn: () => T): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    timingsMs[name] = roundTiming(performance.now() - start);
  }
}

async function measureStageAsync<T>(timingsMs: Record<string, number>, name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    timingsMs[name] = roundTiming(performance.now() - start);
  }
}

function roundTiming(value: number): number {
  return Math.round(value * 100) / 100;
}

export class TopoSemanticQueryEngine {
  private readonly projectPath: string;
  private readonly topk: number;
  private readonly maxTokens: number;
  private readonly dependencies: QueryEngineDependencies;
  dynamicPolicy: DynamicFusionPolicy | undefined = undefined;

  constructor(projectPath = process.cwd(), options: TopoSemanticQueryEngineOptions = {}) {
    this.projectPath = resolve(projectPath);
    this.topk = options.topk ?? DEFAULT_TOPK;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.dependencies = {
      readSnapshot: defaultReadSnapshot,
      vectorSearch: defaultVectorSearch,
      listVectorDocuments: defaultListVectorDocuments,
      readFreshness: defaultReadFreshness,
      ...options.dependencies
    };
    this.dynamicPolicy = this.dependencies.dynamicPolicy ?? undefined;
  }

  setDynamicPolicy(policy: DynamicFusionPolicy | undefined): void {
    this.dynamicPolicy = policy;
  }

  async query(query: string, options: FusionQueryOptions = {}): Promise<ContextCapsule> {
    const timingsMs: Record<string, number> = {};
    const parsed = measureStage(timingsMs, 'parseQuery', () => parseFusionQuery(query));
    const topk = options.topk ?? this.topk;
    const snapshot = measureStage(timingsMs, 'snapshotRead', () => this.dependencies.readSnapshot(this.projectPath));
    const storedDocuments = measureStage(timingsMs, 'vectorDocumentLoad', () => this.dependencies.listVectorDocuments(this.projectPath));
    const documentByNode = measureStage(timingsMs, 'documentMap', () => mapDocumentsByNode(storedDocuments));
    const freshness = measureStage(timingsMs, 'freshnessRead', () => this.dependencies.readFreshness(this.projectPath));

    const adjustments = this.dynamicPolicy?.adjustments;
    const graphCandidates = measureStage(timingsMs, 'graphCandidates', () => this.graphCandidates(snapshot, parsed, documentByNode, adjustments));
    const vectorCandidates = await measureStageAsync(timingsMs, 'vectorSearch', () => this.vectorCandidates(parsed, topk * 4, documentByNode, adjustments));
    const textCandidates = measureStage(timingsMs, 'textCandidates', () => this.textCandidates(parsed, storedDocuments, adjustments));

    const nodes = measureStage(timingsMs, 'mergeCandidates', () => mergeCandidates(
      [...graphCandidates, ...vectorCandidates, ...textCandidates],
      snapshot,
      freshness,
      parsed,
      adjustments
    ).slice(0, topk));

    const documents = nodes
      .map((node) => documentByNode.get(node.nodeId))
      .filter((document): document is VectorDocument => document !== undefined);
    await measureStageAsync(timingsMs, 'behaviorAnnotations', () => this.attachBehaviorAnnotations(nodes, snapshot, documents, parsed));

    let contextNodes = nodes;
    if (this.dependencies.compressResults) {
      const compressionStrategy = selectCompressionStrategy(nodes, adjustments);
      const compressionResult = await measureStageAsync(timingsMs, 'compression', () => this.dependencies.compressResults!.compress(nodes, {
        maxTokens: options.maxTokens ?? this.maxTokens,
        strategy: compressionStrategy
      }));
      contextNodes = compressionResult.compressedCandidates;
    } else {
      timingsMs.compression = 0;
    }

    const context = measureStage(timingsMs, 'contextBudget', () => applyContextBudget(contextNodes, { maxTokens: options.maxTokens ?? this.maxTokens }));
    const outputNodes = this.dependencies.compressResults ? contextNodes : nodes;
    const outputDocuments = this.dependencies.compressResults ? [] : documents;

    const policy: FusionPolicy = { textBranch: 'fusion-store-token-overlap', nativeFts: false };
    if (this.dependencies.relevanceScorer) {
      policy.textBranch = 'headroom-relevance';
      policy.nativeFts = 'headroom-relevance';
      policy.relevanceMode = this.dependencies.relevanceMode ?? 'hybrid';
    }

    const capsule: ContextCapsule = {
      query,
      strippedQuery: parsed.text,
      route: parsed.route,
      filters: parsed.filters,
      nodes: outputNodes,
      documents: outputDocuments,
      edges: measureStage(timingsMs, 'edges', () => edgesForNodes(snapshot, outputNodes)),
      freshness,
      policy,
      warnings: freshness.warnings,
      context,
      diagnostics: {
        timingsMs,
        candidateCounts: {
          graph: graphCandidates.length,
          vector: vectorCandidates.length,
          text: textCandidates.length,
          merged: nodes.length,
          output: outputNodes.length
        },
        fullJsonBytes: 0
      }
    };
    capsule.diagnostics!.fullJsonBytes = Buffer.byteLength(JSON.stringify(capsule));
    return capsule;
  }

  async search(query: string, options: FusionQueryOptions = {}): Promise<ContextCapsule> {
    return this.query(query, options);
  }

  private graphCandidates(
    snapshot: CodeGraphSnapshot,
    parsed: ParsedFusionQuery,
    documentByNode: ReadonlyMap<string, VectorDocument>,
    adjustments?: RankingAdjustments
  ): CandidateDraft[] {
    const terms = queryTerms(parsed.text, parsed.filters);
    const candidates: CandidateDraft[] = [];
    for (const node of snapshot.nodes) {
      if (!nodeMatchesFilters(node, parsed.filters)) {
        continue;
      }
      const score = graphScore(node, terms, parsed.filters);
      if (score <= 0) {
        continue;
      }
      const document = documentByNode.get(node.id);
      candidates.push({
        nodeId: node.id,
        filePath: node.filePath,
        language: node.language,
        kind: node.kind,
        qualifiedName: node.qualifiedName,
        contentHash: document?.contentHash ?? '',
        score: applyRouteWeight(score, parsed.route, 'graph', adjustments),
        source: 'graph',
        content: document?.content ?? buildNodeText(node)
      });
    }
    return candidates;
  }

  private async vectorCandidates(
    parsed: ParsedFusionQuery,
    topk: number,
    documentByNode: ReadonlyMap<string, VectorDocument>,
    adjustments?: RankingAdjustments
  ): Promise<CandidateDraft[]> {
    const text = parsed.text || parsed.filters.name || parsed.original;
    if (!text.trim()) {
      return [];
    }
    const results = await this.dependencies.vectorSearch(this.projectPath, text, topk, parsed.filters);
    return results
      .filter((result) => result.chunkerVersion === DEFAULT_CHUNKER_VERSION)
      .filter((result) => resultMatchesFilters(result, parsed.filters))
      .map((result) => {
        const document = documentByNode.get(result.nodeId);
        return {
          nodeId: result.nodeId,
          filePath: result.filePath,
          language: result.language,
          kind: result.kind,
          qualifiedName: result.qualifiedName,
          contentHash: result.contentHash,
          score: applyRouteWeight(normalizeScore(result.score), parsed.route, 'vector', adjustments),
          source: 'vector' as const,
          content: document?.content ?? result.qualifiedName
        };
      });
  }

  private textCandidates(parsed: ParsedFusionQuery, storedDocuments: readonly StoredVectorDocument[], adjustments?: RankingAdjustments): CandidateDraft[] {
    const terms = queryTerms(parsed.text, parsed.filters);
    if (terms.length === 0 && !hasAnyFilter(parsed.filters)) {
      return [];
    }
    const drafts: CandidateDraft[] = [];
    for (const stored of storedDocuments) {
      const document = asVectorDocument(stored.json);
      if (!document || !documentMatchesFilters(document, parsed.filters)) {
        continue;
      }
      const score = lexicalScore(document, terms, parsed.filters);
      if (score <= 0) {
        continue;
      }
      drafts.push({
        nodeId: document.nodeId,
        filePath: document.filePath,
        language: document.language,
        kind: document.kind,
        qualifiedName: document.qualifiedName,
        contentHash: document.contentHash,
        score: applyRouteWeight(score, parsed.route, 'fts', adjustments),
        source: 'fts',
        content: document.content
      });
    }
    return drafts;
  }

  private async attachBehaviorAnnotations(
    nodes: FusionNode[],
    snapshot: CodeGraphSnapshot,
    documents: readonly VectorDocument[],
    parsed: ParsedFusionQuery
  ): Promise<void> {
    const provider = this.dependencies.annotateCandidates ?? defaultAnnotateCandidates;
    const annotations = await provider({ snapshot, nodes, documents, parsed });
    const byNode = annotationEntries(annotations);
    for (const node of nodes) {
      const nodeAnnotations = byNode.get(node.nodeId) ?? byNode.get(node.qualifiedName);
      if (nodeAnnotations?.length) {
        node.annotations = [...nodeAnnotations];
      }
    }
  }
}


export function routeWeight(route: QueryRoute, source: FusionSource): number {
  return FUSION_RANKING_POLICY.routeWeights[route][source];
}

function applyRouteWeight(score: number, route: QueryRoute, source: FusionSource, adjustments?: RankingAdjustments): number {
  return score * routeWeightValue(route, source, adjustments);
}

function defaultReadSnapshot(projectPath: string): CodeGraphSnapshot {
  return readCodeGraphSnapshot(projectPath);
}

async function defaultVectorSearch(
  projectPath: string,
  text: string,
  topk: number,
  filters: ScalarFilters
): Promise<VectorSearchResult[]> {
  const collection = openCollection(projectPath);
  try {
    const filter = zvecFilterFor(filters);
    return await collection.query([filter ? { text, filter } : { text }], topk);
  } finally {
    collection.destroy();
  }
}

export function zvecFilterFor(filters: ScalarFilters): string | undefined {
  const clauses: string[] = [];
  if (filters.kind) {
    clauses.push(filterEquals('kind', filters.kind));
  }
  if (filters.language) {
    clauses.push(filterEquals('language', filters.language));
  }
  if (filters.file) {
    clauses.push(filterEquals('file_path', filters.file));
  }
  return clauses.length > 0 ? clauses.join(' AND ') : undefined;
}

function defaultListVectorDocuments(projectPath: string): StoredVectorDocument[] {
  const store = new FusionStore(projectPath);
  try {
    return store.listVectorDocuments().filter(isCurrentStoredVectorDocument);
  } finally {
    store.close();
  }
}

function defaultReadFreshness(projectPath: string): FreshnessSnapshot {
  return getFreshnessSnapshot(projectPath);
}

function defaultAnnotateCandidates(input: ContextAnnotationInput): BehaviorAnnotationMap {
  const annotations = new Map<string, BehaviorAnnotation[]>();

  for (const node of input.nodes) {
    const nodeAnnotations: BehaviorAnnotation[] = [];
    const content = node.content.toLowerCase();
    if (content.includes('lodash') && content.includes('clonedeep')) {
      nodeAnnotations.push({
        type: 'stdlib-replacement',
        severity: 'suggestion',
        message: 'This code may use stdlib structuredClone instead of lodash cloneDeep.',
        evidence: { replacement: 'structuredClone', matched: 'lodash cloneDeep' }
      });
    }
    if (content.includes('fs-extra') && /\b(copy|remove|mkdir|readjson|writejson)\b/.test(content)) {
      nodeAnnotations.push({
        type: 'native-replacement',
        severity: 'suggestion',
        message: 'This code may use Node.js native fs APIs instead of fs-extra for this operation.',
        evidence: { replacement: 'node:fs', matched: 'fs-extra' }
      });
    }
    if (nodeAnnotations.length > 0) {
      annotations.set(node.nodeId, nodeAnnotations);
    }
  }

  return annotations;
}

function annotationEntries(annotations: BehaviorAnnotationProviderOutput): Map<string, readonly BehaviorAnnotation[]> {
  if (Array.isArray(annotations)) {
    const byNode = new Map<string, readonly BehaviorAnnotation[]>();
    for (const assignment of annotations) {
      if (assignment.nodeId) {
        byNode.set(assignment.nodeId, assignment.annotations);
      }
      if (assignment.qualifiedName) {
        byNode.set(assignment.qualifiedName, assignment.annotations);
      }
    }
    return byNode;
  }
  if (annotations instanceof Map) {
    return new Map(annotations);
  }
  return new Map(Object.entries(annotations));
}

function mapDocumentsByNode(storedDocuments: readonly StoredVectorDocument[]): Map<string, VectorDocument> {
  const byNode = new Map<string, VectorDocument>();
  for (const stored of storedDocuments) {
    if (!isCurrentStoredVectorDocument(stored)) {
      continue;
    }
    const document = asVectorDocument(stored.json);
    if (document) {
      byNode.set(document.nodeId, document);
    }
  }
  return byNode;
}

function asVectorDocument(value: unknown): VectorDocument | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const candidate = value as Partial<VectorDocument>;
  if (
    typeof candidate.nodeId === 'string' &&
    typeof candidate.filePath === 'string' &&
    typeof candidate.language === 'string' &&
    typeof candidate.kind === 'string' &&
    typeof candidate.qualifiedName === 'string' &&
    typeof candidate.content === 'string' &&
    typeof candidate.contentHash === 'string' &&
    candidate.chunkerVersion === DEFAULT_CHUNKER_VERSION
  ) {
    return {
      id: typeof candidate.id === 'string' ? candidate.id : candidate.nodeId,
      nodeId: candidate.nodeId,
      filePath: candidate.filePath,
      language: candidate.language,
      kind: candidate.kind,
      qualifiedName: candidate.qualifiedName,
      content: candidate.content,
      contentHash: candidate.contentHash,
      chunkerVersion: candidate.chunkerVersion,
      tokens: Array.isArray(candidate.tokens) ? candidate.tokens.filter((token): token is string => typeof token === 'string') : [],
      contentSparse: candidate.contentSparse ?? {},
      embedding: Array.isArray(candidate.embedding) ? candidate.embedding.filter((item): item is number => typeof item === 'number') : []
    };
  }
  return null;
}

function isCurrentStoredVectorDocument(stored: StoredVectorDocument): boolean {
  return stored.chunkerVersion === DEFAULT_CHUNKER_VERSION && isCurrentVectorDocumentJson(stored.json);
}

function isCurrentVectorDocumentJson(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as Partial<VectorDocument>).chunkerVersion === DEFAULT_CHUNKER_VERSION
  );
}

function nodeMatchesFilters(node: CodeGraphSnapshotNode, filters: ScalarFilters): boolean {
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
  if (filters.name && !containsIgnoreCase(`${node.name} ${node.qualifiedName}`, filters.name)) {
    return false;
  }
  return true;
}

function documentMatchesFilters(document: VectorDocument, filters: ScalarFilters): boolean {
  return resultMatchesFilters(document, filters);
}

function resultMatchesFilters(result: Pick<VectorSearchResult, 'kind' | 'language' | 'filePath' | 'qualifiedName'>, filters: ScalarFilters): boolean {
  if (filters.kind && result.kind !== filters.kind) {
    return false;
  }
  if (filters.language && result.language !== filters.language) {
    return false;
  }
  if (filters.file && result.filePath !== filters.file) {
    return false;
  }
  if (filters.path && !result.filePath.startsWith(filters.path)) {
    return false;
  }
  if (filters.name && !containsIgnoreCase(result.qualifiedName, filters.name)) {
    return false;
  }
  return true;
}

function graphScore(node: CodeGraphSnapshotNode, terms: readonly string[], filters: ScalarFilters): number {
  if (terms.length === 0) {
    return hasAnyFilter(filters) ? 0.3 : 0;
  }
  const nodeText = [
    node.name,
    node.qualifiedName,
    node.filePath,
    node.signature ?? '',
    node.docstring ?? '',
    node.sourceSnippet ?? '',
    node.calls.join(' ')
  ].join(' ');
  const nodeTerms = new Set(tokenizeCodeText(nodeText));
  const overlap = terms.filter((term) => nodeTerms.has(term)).length;
  const nameBoost = filters.name && containsIgnoreCase(node.name, filters.name) ? 0.4 : 0;
  return overlap === 0 ? nameBoost : overlap / terms.length + nameBoost;
}

function lexicalScore(document: VectorDocument, terms: readonly string[], filters: ScalarFilters): number {
  if (terms.length === 0) {
    return hasAnyFilter(filters) ? 0.2 : 0;
  }
  const documentTerms = new Set([
    ...document.tokens.map((token) => token.toLowerCase()),
    ...tokenizeCodeText(document.filePath),
    ...tokenizeCodeText(document.content),
    ...tokenizeCodeText(document.qualifiedName)
  ]);
  const overlap = terms.filter((term) => documentTerms.has(term)).length;
  return overlap / terms.length;
}

function mergeCandidates(
  candidates: readonly CandidateDraft[],
  snapshot: CodeGraphSnapshot,
  freshness: FreshnessSnapshot,
  parsed: ParsedFusionQuery,
  adjustments?: RankingAdjustments
): FusionNode[] {
  const fusionBoosts = {
    ...FUSION_RANKING_POLICY.fusionBoosts,
    ...(adjustments?.fusionBoostOverrides ?? {})
  };
  const byNode = new Map<string, FusionNode>();
  const terms = queryTerms(parsed.text, parsed.filters);
  const symbolsByFile = buildFileSymbolsByFile(snapshot, terms);
  for (const candidate of candidates) {
    const existing = byNode.get(candidate.nodeId);
    if (existing) {
      if (!existing.sources.includes(candidate.source)) {
        existing.sources.push(candidate.source);
      }
      existing.sourceScores[candidate.source] = Math.max(existing.sourceScores[candidate.source] ?? 0, candidate.score);
      existing.score += candidate.score;
      if (candidate.content.length > existing.content.length) {
        existing.content = candidate.content;
      }
      continue;
    }
    byNode.set(candidate.nodeId, {
      nodeId: candidate.nodeId,
      filePath: candidate.filePath,
      language: candidate.language,
      kind: candidate.kind,
      qualifiedName: candidate.qualifiedName,
      contentHash: candidate.contentHash,
      score: candidate.score,
      sources: [candidate.source],
      sourceScores: { [candidate.source]: candidate.score },
      content: candidate.content,
      fileSymbols: selectFileSymbolsForNode(symbolsByFile.get(candidate.filePath) ?? [], candidate, terms)
    });
  }

  const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const freshnessByFile = new Map(freshness.entries.map((entry) => [entry.filePath, entry.state]));
  const exactQuerySignature = parsed.route === 'graph-first' ? normalizeExactSymbol(parsed.text) : '';
  const exactFocusFiles = exactQuerySignature
    ? new Set(
        [...byNode.values()]
          .filter((node) => exactSymbolMatches(node, exactQuerySignature))
          .map((node) => node.filePath)
      )
    : new Set<string>();

  const ranked = [...byNode.values()]
    .map((node) => {
      let score =
        node.score +
        Math.max(0, node.sources.length - 1) * fusionBoosts.multiSourceBonusPerAdditionalSource;
      if (node.sources.includes('graph')) {
        score *= fusionBoosts.graphExactMultiplier;
      }
      const snapshotNode = nodesById.get(node.nodeId);
      if (snapshotNode && hasCallProximity(snapshotNode, terms)) {
        score *= fusionBoosts.callProximityMultiplier;
      }
      if (exactQuerySignature) {
        if (exactSymbolMatches(node, exactQuerySignature)) {
          score += EXACT_SYMBOL_MATCH_BONUS;
        } else if (exactFocusFiles.size > 0 && !exactFocusFiles.has(node.filePath)) {
          score *= EXACT_SYMBOL_OUTSIDE_FILE_MULTIPLIER;
        }
      }
      score += formulaicBroadQueryBoost(node, terms, parsed.route);
      const kindBoost = adjustments?.kindBoosts?.[node.kind];
      if (kindBoost) {
        score += kindBoost;
      }
      const freshnessState = freshnessByFile.get(node.filePath);
      const warnings: string[] = [];
      if (freshnessState && freshnessState !== 'fresh') {
        score *=
          freshnessState === 'stale'
            ? FUSION_RANKING_POLICY.freshnessPenalties.stale
            : FUSION_RANKING_POLICY.freshnessPenalties.nonFresh;
        warnings.push(`⚠️ ${freshnessState} embeddings for ${node.filePath}`);
      }
      return {
        ...node,
        score,
        ...(freshnessState ? { freshnessState } : {}),
        ...(warnings.length > 0 ? { warnings } : {})
      };
    })
    .sort(compareFusionNodes);
  return diversifyBroadHybridResults(ranked, parsed);
}

function buildFileSymbolsByFile(snapshot: CodeGraphSnapshot, terms: readonly string[]): Map<string, string[]> {
  const collected = new Map<string, string[]>();
  const seenByFile = new Map<string, Set<string>>();

  for (const snapshotNode of snapshot.nodes) {
    const filePath = snapshotNode.filePath;
    const symbols = collected.get(filePath) ?? [];
    const seen = seenByFile.get(filePath) ?? new Set<string>();
    const add = (symbol: string | undefined | null): void => {
      const value = normalizeCandidateSymbol(symbol);
      if (!value) {
        return;
      }
      const normalized = normalizeExactSymbol(value);
      if (!normalized || seen.has(normalized)) {
        return;
      }
      seen.add(normalized);
      symbols.push(value);
    };

    add(snapshotNode.name);
    if (snapshotNode.qualifiedName && snapshotNode.qualifiedName !== snapshotNode.name) {
      add(shortSymbolName(snapshotNode.qualifiedName));
    }
    for (const highlight of extractSalientIdentifiers([snapshotNode.signature, snapshotNode.docstring, snapshotNode.sourceSnippet].filter(Boolean).join('\n'))) {
      add(highlight);
    }

    collected.set(filePath, symbols);
    seenByFile.set(filePath, seen);
  }

  const ranked = new Map<string, string[]>();
  for (const [filePath, symbols] of collected) {
    ranked.set(filePath, symbols.sort((left, right) => compareFileSymbols(left, right, terms, filePath)));
  }
  return ranked;
}

function selectFileSymbolsForNode(symbols: readonly string[], candidate: CandidateDraft, terms: readonly string[]): string[] {
  const candidateNames = new Set<string>([
    normalizeExactSymbol(candidate.qualifiedName),
    normalizeExactSymbol(shortSymbolName(candidate.qualifiedName)),
    normalizeExactSymbol(candidate.filePath)
  ]);
  return symbols
    .filter((symbol) => {
      const normalized = normalizeExactSymbol(symbol);
      return normalized.length > 0 && !candidateNames.has(normalized);
    })
    .slice(0, Math.max(6, Math.min(8, symbols.length)))
    .sort((left, right) => compareFileSymbols(left, right, terms, candidate.filePath));
}

function compareFileSymbols(left: string, right: string, terms: readonly string[], filePath: string): number {
  const scoreDelta = scoreFileSymbol(right, terms, filePath) - scoreFileSymbol(left, terms, filePath);
  if (scoreDelta !== 0) {
    return scoreDelta;
  }
  return left.localeCompare(right);
}

function scoreFileSymbol(symbol: string, terms: readonly string[], filePath: string): number {
  const lowerSymbol = symbol.toLowerCase();
  const normalizedSymbol = normalizeExactSymbol(symbol);
  const pathTerms = new Set(tokenizeCodeText(filePath));
  let score = 0;

  if (!symbol) {
    return score;
  }
  if (symbol.includes('_')) {
    score += 3;
  }
  if (/[A-Z]/.test(symbol.slice(1))) {
    score += 2;
  }
  for (const term of terms) {
    const normalizedTerm = normalizeExactSymbol(term);
    if (!normalizedTerm) {
      continue;
    }
    if (normalizedSymbol === normalizedTerm) {
      score += 10;
    } else if (normalizedSymbol.includes(normalizedTerm)) {
      score += 6;
    } else if (lowerSymbol.includes(term.toLowerCase())) {
      score += 3;
    }
  }
  const pathOverlap = terms.filter((term) => pathTerms.has(term)).length;
  if (pathOverlap > 0) {
    score += Math.min(4, pathOverlap * 1.5);
  }
  return score;
}

function extractSalientIdentifiers(text: string): string[] {
  if (!text.trim()) {
    return [];
  }
  const identifiers = new Set<string>();
  const patterns = [
    /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g,
    /\b[a-z][a-z0-9]*(?:[A-Z][a-zA-Z0-9]+)+\b/g,
    /\b[A-Z][a-zA-Z0-9]+(?:[A-Z][a-zA-Z0-9]+)+\b/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0];
      if (value) {
        identifiers.add(value);
      }
    }
  }
  return [...identifiers];
}

function shortSymbolName(value: string): string {
  return String(value ?? '').split(/::|[#.]/g).pop() ?? '';
}

function normalizeCandidateSymbol(value: string | undefined | null): string {
  return String(value ?? '').trim();
}

function diversifyBroadHybridResults(nodes: FusionNode[], parsed: ParsedFusionQuery): FusionNode[] {
  const terms = queryTerms(parsed.text, parsed.filters);
  if (parsed.route !== 'hybrid' || terms.length < 3 || nodes.length < 2) {
    return nodes;
  }
  const remaining = [...nodes];
  const selected: FusionNode[] = [];
  const covered = new Set<string>();
  const maxScore = Math.max(...nodes.map((node) => node.score), 1);
  while (remaining.length > 0) {
    remaining.sort((left, right) => {
      const leftCoverage = uncoveredEvidenceTerms(left, terms, covered).length;
      const rightCoverage = uncoveredEvidenceTerms(right, terms, covered).length;
      const coverageDelta = rightCoverage - leftCoverage;
      if (coverageDelta !== 0) {
        return coverageDelta;
      }
      const normalizedScoreDelta = (right.score / maxScore) - (left.score / maxScore);
      if (normalizedScoreDelta !== 0) {
        return normalizedScoreDelta;
      }
      return compareFusionNodes(left, right);
    });
    const [next] = remaining.splice(0, 1);
    if (!next) {
      break;
    }
    selected.push(next);
    for (const term of evidenceTerms(next, terms)) {
      covered.add(term);
    }
  }
  return selected;
}

function exactSymbolMatches(node: Pick<FusionNode, 'qualifiedName'>, exactQuerySignature: string): boolean {
  if (!exactQuerySignature) {
    return false;
  }
  return node.qualifiedName
    .split(/::|[#.]/g)
    .some((segment) => normalizeExactSymbol(segment) === exactQuerySignature);
}

function selectCompressionStrategy(
  nodes: readonly FusionNode[],
  adjustments?: RankingAdjustments
): 'auto' | 'aggressive' | 'conservative' | 'off' {
  const settings = adjustments?.compressionAggressiveness;
  if (!settings || Object.keys(settings).length === 0) {
    return 'auto';
  }

  let sawAggressive = false;
  let sawConservative = false;
  let sawOff = false;

  for (const node of nodes) {
    const categories = new Set<string>([
      detectContentType(node.content),
      node.kind,
      ...node.sources
    ]);
    for (const category of categories) {
      const level = settings[category];
      if (!level) {
        continue;
      }
      if (level === 'off') {
        sawOff = true;
      } else if (level === 'conservative') {
        sawConservative = true;
      } else if (level === 'aggressive') {
        sawAggressive = true;
      }
    }
  }

  if (sawOff) {
    return 'off';
  }
  if (sawConservative) {
    return 'conservative';
  }
  if (sawAggressive) {
    return 'aggressive';
  }
  return 'auto';
}

function uncoveredEvidenceTerms(node: FusionNode, terms: readonly string[], covered: ReadonlySet<string>): string[] {
  return evidenceTerms(node, terms).filter((term) => !covered.has(term));
}

function evidenceTerms(node: FusionNode, terms: readonly string[]): string[] {
  const nodeTerms = new Set(tokenizeCodeText(`${node.filePath} ${node.qualifiedName} ${node.content}`));
  return terms.filter((term) => nodeTerms.has(term));
}

function formulaicBroadQueryBoost(node: FusionNode, terms: readonly string[], route: QueryRoute): number {
  if (route !== 'hybrid' || terms.length < 2) {
    return 0;
  }
  const evidenceTerms = new Set(tokenizeCodeText(`${node.filePath} ${node.qualifiedName} ${node.content}`));
  const pathTerms = new Set(tokenizeCodeText(`${node.filePath} ${node.qualifiedName}`));
  const evidenceOverlap = terms.filter((term) => evidenceTerms.has(term)).length / terms.length;
  const pathOverlap = terms.filter((term) => pathTerms.has(term)).length / terms.length;
  const familyBonus = fileFamilyBonus(node.filePath, terms);
  return Math.min(1.8, evidenceOverlap * 0.2 + pathOverlap * 1 + familyBonus);
}

function fileFamilyBonus(filePath: string, terms: readonly string[]): number {
  const pathTerms = new Set(tokenizeCodeText(filePath));
  const overlap = terms.filter((term) => pathTerms.has(term)).length;
  if (overlap === 0) {
    return 0;
  }
  const density = overlap / Math.max(1, terms.length);
  return Math.min(1.2, overlap * 0.35 + density * 0.75);
}

export function compareFusionNodes(left: FusionNode, right: FusionNode): number {
  const scoreDelta = right.score - left.score;
  if (scoreDelta !== 0) {
    return scoreDelta;
  }
  const fileDelta = left.filePath.localeCompare(right.filePath);
  if (fileDelta !== 0) {
    return fileDelta;
  }
  const nodeDelta = left.nodeId.localeCompare(right.nodeId);
  if (nodeDelta !== 0) {
    return nodeDelta;
  }
  return left.qualifiedName.localeCompare(right.qualifiedName);
}

function hasCallProximity(node: CodeGraphSnapshotNode, terms: readonly string[]): boolean {
  if (terms.length === 0 || node.calls.length === 0) {
    return false;
  }
  const callTerms = new Set(tokenizeCodeText(node.calls.join(' ')));
  return terms.some((term) => callTerms.has(term));
}

function normalizeExactSymbol(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function edgesForNodes(snapshot: CodeGraphSnapshot, nodes: readonly FusionNode[]): FusionEdge[] {
  const wanted = new Set(nodes.map((node) => node.nodeId));
  return snapshot.nodes
    .filter((node) => wanted.has(node.id))
    .flatMap((node) => node.calls.map((targetName) => ({ source: node.id, targetName, kind: 'calls' as const })));
}

function normalizeScore(score: number): number {
  if (!Number.isFinite(score)) {
    return 0;
  }
  return Math.max(0, score);
}

function hasAnyFilter(filters: ScalarFilters): boolean {
  return Boolean(filters.kind || filters.language || filters.file || filters.path || filters.name);
}

function containsIgnoreCase(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}
