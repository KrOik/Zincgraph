import { resolve } from 'node:path';

import { FusionStore, type StoredVectorDocument } from '../freshness/fusion-store.js';
import { type FreshnessSnapshot, getFreshnessSnapshot } from '../freshness/freshness-gate.js';
import type { ManifestState } from '../freshness/manifest.js';
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
import {
  expandSemanticQueryText,
  resolveActiveEmbedding,
  tokenizeCodeText,
  type ActiveEmbeddingConfigInput,
  type ResolvedEmbeddingConfig
} from '../vector/embedding/index.js';
import { filterEquals, type VectorSearchResult } from '../vector/zvec-adapter.js';
import {
  applyContextBudget,
  type BehaviorAnnotation,
  type ContextBudgetResult,
  type EvidenceSource
} from './context-budget.js';
import type { FusionCompressionAdapter } from '../compression/fusion-compressor.js';
import {
  createDefaultRelevanceScorer,
  type RankFeatureScores,
  type RelevanceMode,
  type RelevanceScorerAdapter,
  type TextDocument
} from '../compression/relevance-scorer.js';
import type { DynamicFusionPolicy, RankingAdjustments } from '../compression/ranking-adjuster.js';
import {
  isLikelyExactSymbolQuery,
  parseFusionQuery,
  queryTerms,
  type FusionIntent,
  type ParsedFusionQuery,
  type QueryRoute,
  type ScalarFilters
} from './intent-router.js';

type VectorSearchMode = 'dense' | 'hybrid' | 'sparse';

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
  freshnessState?: ManifestState;
  warnings?: string[];
  rankFeatures?: RankFeatureScores;
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
  intent: FusionIntent;
  route: QueryRoute;
  filters: ScalarFilters;
  nodes: FusionNode[];
  documents: VectorDocument[];
  edges: FusionEdge[];
  freshness: FreshnessSnapshot;
  policy: FusionPolicy;
  warnings: string[];
  context: ContextBudgetResult;
}

export interface FusionCandidateBudget {
  graph?: number;
  vector?: number;
  text?: number;
  merged?: number;
}

export interface FusionQueryOptions {
  topk?: number;
  maxTokens?: number;
  candidateBudget?: FusionCandidateBudget;
}

export interface QueryEngineDependencies {
  readSnapshot(projectPath: string): CodeGraphSnapshot;
  vectorSearch(
    projectPath: string,
    text: string,
    topk: number,
    filters: ScalarFilters,
    mode?: VectorSearchMode
  ): Promise<VectorSearchResult[]>;
  listVectorDocuments(projectPath: string): StoredVectorDocument[];
  getVectorDocumentsByNodeIds?(projectPath: string, nodeIds: readonly string[]): StoredVectorDocument[];
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
  embedding?: ActiveEmbeddingConfigInput;
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

interface QueryFocusAnchor {
  node: CodeGraphSnapshotNode;
  pathMatched: boolean;
  symbolMatched: boolean;
  exactSymbolMatched: boolean;
}

interface QueryFocus {
  anchors: readonly QueryFocusAnchor[];
}

interface QueryFocusBoosts {
  graphExactMultiplier: number;
  callProximityMultiplier: number;
}

interface NodeReferenceIndex {
  exact: Map<string, Set<string>>;
  token: Map<string, Set<string>>;
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
    graphExactMultiplier: 2,
    callProximityMultiplier: 1.8
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
const DEFAULT_GRAPH_CANDIDATE_MULTIPLIER = 6;
const DEFAULT_VECTOR_CANDIDATE_MULTIPLIER = 2;
const DEFAULT_TEXT_CANDIDATE_MULTIPLIER = 6;
const DEFAULT_MERGED_CANDIDATE_MULTIPLIER = 8;
const MAX_QUERY_SEMANTIC_ALIASES = 8;
const MAX_QUERY_SEMANTIC_NEIGHBORS = 8;
const RELAXED_SEMANTIC_RANKING_VECTOR_LIMIT = 4;
const RELAXED_SEMANTIC_RANKING_SCOPE_DISCOUNT = 0.98;

export class TopoSemanticQueryEngine {
  private readonly projectPath: string;
  private readonly topk: number;
  private readonly maxTokens: number;
  private readonly dependencies: QueryEngineDependencies;
  private readonly activeEmbedding: ResolvedEmbeddingConfig;
  private readonly preferNodeIdVectorDocumentLookup: boolean;
  dynamicPolicy: DynamicFusionPolicy | undefined = undefined;

  constructor(projectPath = process.cwd(), options: TopoSemanticQueryEngineOptions = {}) {
    this.projectPath = resolve(projectPath);
    this.topk = options.topk ?? DEFAULT_TOPK;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.activeEmbedding = resolveActiveEmbedding(this.projectPath, options.embedding);
    this.dependencies = {
      readSnapshot: defaultReadSnapshot,
      vectorSearch: (target, text, topk, filters, mode) =>
        defaultVectorSearch(target, text, topk, filters, this.activeEmbedding, mode),
      listVectorDocuments: (target) => defaultListVectorDocuments(target, this.activeEmbedding),
      readFreshness: (target) => defaultReadFreshness(target, this.activeEmbedding),
      relevanceScorer: createDefaultRelevanceScorer(),
      relevanceMode: 'hybrid',
      ...options.dependencies
    };
    // Default to the cheaper node-id lookup unless the caller explicitly supplies
    // a custom listVectorDocuments implementation that we should honor instead.
    this.preferNodeIdVectorDocumentLookup =
      options.dependencies?.listVectorDocuments === undefined ||
      options.dependencies.getVectorDocumentsByNodeIds !== undefined;
    this.dynamicPolicy = this.dependencies.dynamicPolicy ?? undefined;
  }

  setDynamicPolicy(policy: DynamicFusionPolicy | undefined): void {
    this.dynamicPolicy = policy;
  }

  async query(query: string, options: FusionQueryOptions = {}): Promise<ContextCapsule> {
    const parsed = parseFusionQuery(query);
    const topk = options.topk ?? this.topk;
    const candidateBudget = resolveCandidateBudget(topk, options.candidateBudget);
    const snapshot = this.dependencies.readSnapshot(this.projectPath);
    const snapshotNodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
    const contentHashByPath = new Map(snapshot.files.map((file) => [file.path, file.contentHash]));
    const semanticContentByNode = buildQuerySemanticContent(snapshot);
    const freshness = this.dependencies.readFreshness(this.projectPath);
    const fusionBoosts: QueryFocusBoosts = {
      graphExactMultiplier: FUSION_RANKING_POLICY.fusionBoosts.graphExactMultiplier,
      callProximityMultiplier: FUSION_RANKING_POLICY.fusionBoosts.callProximityMultiplier,
      ...(this.dynamicPolicy?.adjustments.fusionBoostOverrides ?? {})
    };
    const queryFocus = buildQueryFocus(snapshot, parsed);
    const skipSupplementalCandidates = shouldSkipSupplementalCandidates(parsed);

    const adjustments = this.dynamicPolicy?.adjustments;
    const graphCandidates = limitCandidateDrafts(
      this.graphCandidates(snapshot, parsed, semanticContentByNode, contentHashByPath, adjustments, queryFocus, fusionBoosts),
      candidateBudget.graph
    );
    const vectorCandidates = limitCandidateDrafts(
      skipSupplementalCandidates
        ? []
        : await this.vectorCandidates(snapshotNodeById, parsed, candidateBudget.vector, semanticContentByNode, adjustments, queryFocus, fusionBoosts),
      candidateBudget.vector
    );
    const textCandidates = limitCandidateDrafts(
      skipSupplementalCandidates
        ? []
        : this.textCandidates(snapshot, parsed, semanticContentByNode, contentHashByPath, adjustments, queryFocus, fusionBoosts),
      candidateBudget.text
    );

    const mergedNodes = mergeCandidates(
      [...graphCandidates, ...vectorCandidates, ...textCandidates],
      freshness,
      parsed,
      adjustments
    ).slice(0, candidateBudget.merged);
    const rerankLimit = Math.min(mergedNodes.length, Math.max(topk, topk * 2));
    const selectedNodeIds = mergedNodes.slice(0, rerankLimit).map((node) => node.nodeId);
    const documentByNode = mapDocumentsByNode(this.loadStoredDocuments(selectedNodeIds), this.activeEmbedding);
    const preserveExactRoots = shouldPreserveExactRootAnchors(parsed);
    const rerankedNodes = this.dependencies.relevanceScorer
      ? rerankFusionNodes(
        mergedNodes.slice(0, rerankLimit),
        parsed,
        snapshot,
        documentByNode,
        this.dependencies.relevanceScorer,
        this.dependencies.relevanceMode ?? 'hybrid',
        queryFocus,
        preserveExactRoots
      )
      : mergedNodes.slice(0, rerankLimit);
    const nodes = diversifyBroadHybridResults(rerankedNodes, parsed, queryFocus, preserveExactRoots).slice(0, topk);

    const documents = nodes
      .map((node) => documentByNode.get(node.nodeId))
      .filter((document): document is VectorDocument => document !== undefined);
    await this.attachBehaviorAnnotations(nodes, snapshot, documents, parsed);

    let contextNodes = nodes;
    if (this.dependencies.compressResults) {
      const compressionStrategy = selectCompressionStrategy(nodes, adjustments);
      const compressionResult = await this.dependencies.compressResults.compress(nodes, {
        maxTokens: options.maxTokens ?? this.maxTokens,
        strategy: compressionStrategy
      });
      contextNodes = compressionResult.compressedCandidates;
    }

    const context = applyContextBudget(contextNodes, { maxTokens: options.maxTokens ?? this.maxTokens });
    const outputNodes = this.dependencies.compressResults ? contextNodes : nodes;
    const outputDocuments = this.dependencies.compressResults ? [] : documents;

    const policy: FusionPolicy = { textBranch: 'fusion-store-token-overlap', nativeFts: false };
    if (this.dependencies.relevanceScorer) {
      policy.textBranch = 'two-stage-rerank';
      policy.nativeFts = 'two-stage-rerank';
      policy.relevanceMode = this.dependencies.relevanceMode ?? 'hybrid';
    }

    return {
      query,
      strippedQuery: parsed.text,
      intent: parsed.intent,
      route: parsed.route,
      filters: parsed.filters,
      nodes: outputNodes,
      documents: outputDocuments,
      edges: edgesForNodes(snapshot, outputNodes),
      freshness,
      policy,
      warnings: freshness.warnings,
      context
    };
  }

  async search(query: string, options: FusionQueryOptions = {}): Promise<ContextCapsule> {
    return this.query(query, options);
  }

  private graphCandidates(
    snapshot: CodeGraphSnapshot,
    parsed: ParsedFusionQuery,
    contentByNode: ReadonlyMap<string, string>,
    contentHashByPath: ReadonlyMap<string, string>,
    adjustments?: RankingAdjustments,
    focus?: QueryFocus,
    fusionBoosts?: QueryFocusBoosts
  ): CandidateDraft[] {
    const terms = queryTerms(parsed.text, parsed.filters);
    const relaxedFilters = shouldRelaxSemanticRankingPathFilters(parsed) ? relaxedSemanticRankingFilters(parsed.filters) : undefined;
    const candidates: CandidateDraft[] = [];
    for (const node of snapshot.nodes) {
      const strictScope = nodeMatchesFilters(node, parsed.filters);
      if (!strictScope && (!relaxedFilters || !nodeMatchesFilters(node, relaxedFilters))) {
        continue;
      }
      const content = contentByNode.get(node.id) ?? buildNodeText(node);
      const score = graphScore(node, content, terms, parsed);
      if (score <= 0) {
        continue;
      }
      const boostedScore = focus && fusionBoosts ? applyQueryFocusBoost(score, node, focus, fusionBoosts) : score;
      candidates.push({
        nodeId: node.id,
        filePath: node.filePath,
        language: node.language,
        kind: node.kind,
        qualifiedName: node.qualifiedName,
        contentHash: contentHashByPath.get(node.filePath) ?? '',
        score: applyRouteWeight(boostedScore, parsed.route, 'graph', adjustments) * (strictScope || !relaxedFilters ? 1 : RELAXED_SEMANTIC_RANKING_SCOPE_DISCOUNT),
        source: 'graph',
        content
      });
    }
    return candidates;
  }

  private async vectorCandidates(
    snapshotNodeById: ReadonlyMap<string, CodeGraphSnapshotNode>,
    parsed: ParsedFusionQuery,
    topk: number,
    contentByNode: ReadonlyMap<string, string>,
    adjustments?: RankingAdjustments,
    focus?: QueryFocus,
    fusionBoosts?: QueryFocusBoosts
  ): Promise<CandidateDraft[]> {
    const searchText = parsed.text || parsed.filters.name || parsed.original;
    if (!searchText.trim()) {
      return [];
    }
    const vectorMode = preferredVectorSearchMode(parsed);
    const queryText = expandSemanticQueryText(searchText);
    const relaxedFilters = shouldRelaxSemanticRankingPathFilters(parsed) ? relaxedSemanticRankingFilters(parsed.filters) : undefined;
    const strictVectorFilter = zvecFilterFor(parsed.filters);
    const relaxedVectorFilter = relaxedFilters ? zvecFilterFor(relaxedFilters) : undefined;
    const shouldSearchRelaxedVector = Boolean(relaxedFilters && relaxedVectorFilter !== strictVectorFilter);
    const [strictResults, relaxedResults] = await Promise.all([
      this.dependencies.vectorSearch(
        this.projectPath,
        queryText,
        topk,
        parsed.filters,
        vectorMode
      ),
      shouldSearchRelaxedVector
        ? this.dependencies.vectorSearch(
          this.projectPath,
          queryText,
          Math.min(topk, RELAXED_SEMANTIC_RANKING_VECTOR_LIMIT * 2),
          relaxedFilters!,
          vectorMode
        )
        : Promise.resolve([] as VectorSearchResult[])
    ]);
    const candidates = new Map<string, CandidateDraft>();
    const addResult = (result: VectorSearchResult, filters: ScalarFilters): void => {
      if (result.chunkerVersion !== this.activeEmbedding.chunkerVersion) {
        return;
      }
      if (!resultMatchesFilters(result, filters)) {
        return;
      }
      if (candidates.has(result.nodeId)) {
        return;
      }
      const inStrictScope = resultMatchesFilters(result, parsed.filters);
      const scopeDiscount = inStrictScope || !relaxedFilters ? 1 : RELAXED_SEMANTIC_RANKING_SCOPE_DISCOUNT;
      const boostedScore = focus && fusionBoosts
        ? applyQueryFocusBoost(normalizeScore(result.score), snapshotNodeById.get(result.nodeId), focus, fusionBoosts)
        : normalizeScore(result.score);
      candidates.set(result.nodeId, {
        nodeId: result.nodeId,
        filePath: result.filePath,
        language: result.language,
        kind: result.kind,
        qualifiedName: result.qualifiedName,
        contentHash: result.contentHash,
        score: applyRouteWeight(boostedScore, parsed.route, 'vector', adjustments) * scopeDiscount,
        source: 'vector' as const,
        content: contentByNode.get(result.nodeId) ?? result.qualifiedName
      });
    };
    for (const result of strictResults) {
      addResult(result, parsed.filters);
    }
    if (relaxedFilters) {
      for (const result of relaxedResults) {
        addResult(result, relaxedFilters);
      }
    }
    return [...candidates.values()];
  }

  private textCandidates(
    snapshot: CodeGraphSnapshot,
    parsed: ParsedFusionQuery,
    contentByNode: ReadonlyMap<string, string>,
    contentHashByPath: ReadonlyMap<string, string>,
    adjustments?: RankingAdjustments,
    focus?: QueryFocus,
    fusionBoosts?: QueryFocusBoosts
  ): CandidateDraft[] {
    const terms = queryTerms(parsed.text, parsed.filters);
    if (terms.length === 0 && !hasAnyFilter(parsed.filters)) {
      return [];
    }
    const relaxedFilters = shouldRelaxSemanticRankingPathFilters(parsed) ? relaxedSemanticRankingFilters(parsed.filters) : undefined;
    const drafts: CandidateDraft[] = [];
    for (const node of snapshot.nodes) {
      const strictScope = nodeMatchesFilters(node, parsed.filters);
      if (!strictScope && (!relaxedFilters || !nodeMatchesFilters(node, relaxedFilters))) {
        continue;
      }
      const content = contentByNode.get(node.id) ?? buildNodeText(node);
      const score = lexicalScore(content, terms, parsed);
      if (score <= 0) {
        continue;
      }
      const boostedScore = focus && fusionBoosts ? applyQueryFocusBoost(score, node, focus, fusionBoosts) : score;
      drafts.push({
        nodeId: node.id,
        filePath: node.filePath,
        language: node.language,
        kind: node.kind,
        qualifiedName: node.qualifiedName,
        contentHash: contentHashByPath.get(node.filePath) ?? '',
        score: applyRouteWeight(boostedScore, parsed.route, 'fts', adjustments) * (strictScope || !relaxedFilters ? 1 : RELAXED_SEMANTIC_RANKING_SCOPE_DISCOUNT),
        source: 'fts',
        content
      });
    }
    return drafts;
  }

  private loadStoredDocuments(nodeIds: readonly string[]): StoredVectorDocument[] {
    const uniqueNodeIds = [...new Set(nodeIds.filter((nodeId) => nodeId.length > 0))];
    if (uniqueNodeIds.length === 0) {
      return [];
    }
    if (this.dependencies.getVectorDocumentsByNodeIds) {
      return this.dependencies.getVectorDocumentsByNodeIds(this.projectPath, uniqueNodeIds)
        .filter((stored) => isCurrentStoredVectorDocument(stored, this.activeEmbedding));
    }
    if (this.preferNodeIdVectorDocumentLookup) {
      return defaultGetVectorDocumentsByNodeIds(this.projectPath, uniqueNodeIds, this.activeEmbedding);
    }
    const selectedNodeIds = new Set(uniqueNodeIds);
    return this.dependencies
      .listVectorDocuments(this.projectPath)
      .filter((stored) => selectedNodeIds.has(stored.nodeId) && isCurrentStoredVectorDocument(stored, this.activeEmbedding));
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

function resolveCandidateBudget(topk: number, budget: FusionCandidateBudget | undefined): Required<FusionCandidateBudget> {
  const baseTopk = Math.max(1, Math.floor(topk));
  return {
    graph: candidateLimit(budget?.graph, baseTopk * DEFAULT_GRAPH_CANDIDATE_MULTIPLIER),
    vector: candidateLimit(budget?.vector, baseTopk * DEFAULT_VECTOR_CANDIDATE_MULTIPLIER),
    text: candidateLimit(budget?.text, baseTopk * DEFAULT_TEXT_CANDIDATE_MULTIPLIER),
    merged: candidateLimit(budget?.merged, baseTopk * DEFAULT_MERGED_CANDIDATE_MULTIPLIER)
  };
}

function candidateLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

function limitCandidateDrafts(candidates: readonly CandidateDraft[], limit: number): CandidateDraft[] {
  if (candidates.length <= limit) {
    return [...candidates];
  }
  return [...candidates].sort(compareCandidateDrafts).slice(0, limit);
}

function compareCandidateDrafts(left: CandidateDraft, right: CandidateDraft): number {
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

function defaultReadSnapshot(projectPath: string): CodeGraphSnapshot {
  return readCodeGraphSnapshot(projectPath);
}

function buildQuerySemanticContent(snapshot: CodeGraphSnapshot): Map<string, string> {
  const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const nodesByFile = new Map<string, CodeGraphSnapshotNode[]>();
  for (const node of snapshot.nodes) {
    const peers = nodesByFile.get(node.filePath) ?? [];
    peers.push(node);
    nodesByFile.set(node.filePath, peers);
  }

  const referenceIndex = buildQueryReferenceIndex(snapshot);
  const outgoingByNodeId = new Map<string, Set<string>>();
  const incomingByNodeId = new Map<string, Set<string>>();

  for (const node of snapshot.nodes) {
    const outgoing = new Set(
      resolveQueryReferenceIds(node.calls, referenceIndex).filter((nodeId) => nodeId !== node.id)
    );
    if (outgoing.size > 0) {
      outgoingByNodeId.set(node.id, outgoing);
    }
    for (const targetId of outgoing) {
      const incoming = incomingByNodeId.get(targetId) ?? new Set<string>();
      incoming.add(node.id);
      incomingByNodeId.set(targetId, incoming);
    }
  }

  const contentByNode = new Map<string, string>();
  for (const node of snapshot.nodes) {
    const baseContent = buildNodeText(node);
    const aliases = new Set<string>();
    const neighbors = new Set<string>();

    const sameFilePeers = (nodesByFile.get(node.filePath) ?? [])
      .filter((peer) => peer.id !== node.id)
      .sort(compareSnapshotNodeByQualifiedName)
      .slice(0, MAX_QUERY_SEMANTIC_NEIGHBORS);
    for (const peer of sameFilePeers) {
      aliases.add(peer.name);
      neighbors.add(`same-file ${peer.name}`);
    }

    const outgoingTargets = [...(outgoingByNodeId.get(node.id) ?? [])]
      .map((nodeId) => nodesById.get(nodeId))
      .filter((value): value is CodeGraphSnapshotNode => value !== undefined)
      .sort(compareSnapshotNodeByQualifiedName)
      .slice(0, MAX_QUERY_SEMANTIC_NEIGHBORS);
    for (const target of outgoingTargets) {
      aliases.add(target.name);
      neighbors.add(`calls ${target.name}`);
    }

    const incomingCallers = [...(incomingByNodeId.get(node.id) ?? [])]
      .map((nodeId) => nodesById.get(nodeId))
      .filter((value): value is CodeGraphSnapshotNode => value !== undefined)
      .sort(compareSnapshotNodeByQualifiedName)
      .slice(0, MAX_QUERY_SEMANTIC_NEIGHBORS);
    for (const caller of incomingCallers) {
      aliases.add(caller.name);
      neighbors.add(`called-by ${caller.name}`);
    }

    contentByNode.set(
      node.id,
      appendQuerySemanticText(
        baseContent,
        [...aliases].slice(0, MAX_QUERY_SEMANTIC_ALIASES),
        [...neighbors].slice(0, MAX_QUERY_SEMANTIC_NEIGHBORS)
      )
    );
  }

  return contentByNode;
}

function buildQueryReferenceIndex(snapshot: CodeGraphSnapshot): NodeReferenceIndex {
  const exact = new Map<string, Set<string>>();
  const token = new Map<string, Set<string>>();
  for (const node of snapshot.nodes) {
    registerQueryReference(exact, node.name, node.id, false);
    registerQueryReference(exact, node.qualifiedName, node.id, false);
    registerQueryReference(token, node.name, node.id, true);
    registerQueryReference(token, node.qualifiedName, node.id, true);
  }
  return { exact, token };
}

function registerQueryReference(
  index: Map<string, Set<string>>,
  reference: string,
  nodeId: string,
  tokenized: boolean
): void {
  const normalized = normalizeQueryReferenceKey(reference);
  if (normalized) {
    addQueryIndexEntry(index, normalized, nodeId);
  }
  if (!tokenized) {
    return;
  }
  for (const token of tokenizeCodeText(reference)) {
    if (token.length < 3) {
      continue;
    }
    addQueryIndexEntry(index, token, nodeId);
  }
}

function resolveQueryReferenceIds(reference: readonly string[], index: NodeReferenceIndex): string[] {
  const matches = new Set<string>();
  for (const part of reference) {
    const normalized = normalizeQueryReferenceKey(part);
    if (normalized) {
      const exactMatches = index.exact.get(normalized);
      if (exactMatches && exactMatches.size > 0) {
        for (const nodeId of exactMatches) {
          matches.add(nodeId);
        }
        continue;
      }
    }
    for (const token of tokenizeCodeText(part)) {
      if (token.length < 3) {
        continue;
      }
      const bucket = index.token.get(token);
      if (!bucket) {
        continue;
      }
      for (const nodeId of bucket) {
        matches.add(nodeId);
      }
    }
  }
  return [...matches];
}

function addQueryIndexEntry(index: Map<string, Set<string>>, key: string, nodeId: string): void {
  const bucket = index.get(key) ?? new Set<string>();
  bucket.add(nodeId);
  index.set(key, bucket);
}

function normalizeQueryReferenceKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function appendQuerySemanticText(baseContent: string, aliases: readonly string[], neighbors: readonly string[]): string {
  if (aliases.length === 0 && neighbors.length === 0) {
    return baseContent;
  }
  const parts = [baseContent];
  if (aliases.length > 0) {
    parts.push('semantic aliases');
    parts.push(...aliases);
  }
  if (neighbors.length > 0) {
    parts.push('semantic neighbors');
    parts.push(...neighbors);
  }
  return parts.join('\n');
}

function compareSnapshotNodeByQualifiedName(left: CodeGraphSnapshotNode, right: CodeGraphSnapshotNode): number {
  const qualifiedDelta = left.qualifiedName.localeCompare(right.qualifiedName);
  if (qualifiedDelta !== 0) {
    return qualifiedDelta;
  }
  return left.id.localeCompare(right.id);
}

async function defaultVectorSearch(
  projectPath: string,
  text: string,
  topk: number,
  filters: ScalarFilters,
  embedding: ResolvedEmbeddingConfig,
  mode: VectorSearchMode = 'dense'
): Promise<VectorSearchResult[]> {
  const collection = openCollection(projectPath, {
    embeddingProfile: embedding.profile,
    chunkerVersion: embedding.chunkerVersion,
    queryAdapter: embedding.adapter
  });
  try {
    const filter = zvecFilterFor(filters);
    return await collection.query([filter ? { text, filter, mode } : { text, mode }], topk);
  } finally {
    collection.destroy();
  }
}

function preferredVectorSearchMode(parsed: ParsedFusionQuery): VectorSearchMode {
  switch (parsed.intent) {
    case 'semantic-ranking':
      return parsed.filters.path || parsed.filters.file ? 'sparse' : 'hybrid';
    case 'compression-feedback':
    case 'freshness/status':
      return 'hybrid';
    default:
      return 'dense';
  }
}

function shouldRelaxSemanticRankingPathFilters(parsed: ParsedFusionQuery): boolean {
  return parsed.intent === 'semantic-ranking' && Boolean(parsed.filters.path || parsed.filters.file);
}

function relaxedSemanticRankingFilters(filters: ScalarFilters): ScalarFilters {
  const relaxed: ScalarFilters = { ...filters };
  delete relaxed.path;
  delete relaxed.file;
  return relaxed;
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

function defaultListVectorDocuments(projectPath: string, embedding: ResolvedEmbeddingConfig): StoredVectorDocument[] {
  const store = new FusionStore(projectPath);
  try {
    return store
      .listVectorDocuments(embedding.profile, embedding.chunkerVersion)
      .filter((stored) => isCurrentStoredVectorDocument(stored, embedding));
  } finally {
    store.close();
  }
}

function defaultGetVectorDocumentsByNodeIds(
  projectPath: string,
  nodeIds: readonly string[],
  embedding: ResolvedEmbeddingConfig
): StoredVectorDocument[] {
  const store = new FusionStore(projectPath);
  try {
    return store
      .getVectorDocumentsByNodeIds(nodeIds, embedding.profile, embedding.chunkerVersion)
      .filter((stored) => isCurrentStoredVectorDocument(stored, embedding));
  } finally {
    store.close();
  }
}

function defaultReadFreshness(projectPath: string, embedding: ResolvedEmbeddingConfig): FreshnessSnapshot {
  return getFreshnessSnapshot(projectPath, {
    provider: embedding.provider,
    embeddingProfile: embedding.profile,
    chunkerVersion: embedding.chunkerVersion,
    networkPolicy: embedding.networkPolicy
  });
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

function mapDocumentsByNode(
  storedDocuments: readonly StoredVectorDocument[],
  embedding: ResolvedEmbeddingConfig
): Map<string, VectorDocument> {
  const byNode = new Map<string, VectorDocument>();
  for (const stored of storedDocuments) {
    if (!isCurrentStoredVectorDocument(stored, embedding)) {
      continue;
    }
    const document = asVectorDocument(stored.json, embedding.chunkerVersion);
    if (document) {
      byNode.set(document.nodeId, document);
    }
  }
  return byNode;
}

function asVectorDocument(value: unknown, chunkerVersion = DEFAULT_CHUNKER_VERSION): VectorDocument | null {
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
    candidate.chunkerVersion === chunkerVersion
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
      embedding: Array.isArray(candidate.embedding) ? candidate.embedding.filter((item): item is number => typeof item === 'number') : [],
      semanticAliases: Array.isArray(candidate.semanticAliases)
        ? candidate.semanticAliases.filter((alias): alias is string => typeof alias === 'string')
        : [],
      semanticNeighbors: Array.isArray(candidate.semanticNeighbors)
        ? candidate.semanticNeighbors.filter((neighbor): neighbor is NonNullable<VectorDocument['semanticNeighbors']>[number] => {
          return Boolean(
            neighbor &&
            typeof neighbor === 'object' &&
            typeof neighbor.nodeId === 'string' &&
            typeof neighbor.qualifiedName === 'string' &&
            typeof neighbor.filePath === 'string' &&
            typeof neighbor.kind === 'string' &&
            typeof neighbor.score === 'number' &&
            (neighbor.relationship === 'same-file' || neighbor.relationship === 'semantic-overlap')
          );
        })
        : []
    };
  }
  return null;
}

function isCurrentStoredVectorDocument(stored: StoredVectorDocument, embedding: ResolvedEmbeddingConfig): boolean {
  return (
    stored.embeddingProfile === embedding.profile &&
    stored.chunkerVersion === embedding.chunkerVersion &&
    isCurrentVectorDocumentJson(stored.json, embedding.chunkerVersion)
  );
}

function isCurrentVectorDocumentJson(value: unknown, chunkerVersion = DEFAULT_CHUNKER_VERSION): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as Partial<VectorDocument>).chunkerVersion === chunkerVersion
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

function graphScore(
  node: CodeGraphSnapshotNode,
  content: string,
  terms: readonly string[],
  parsed: ParsedFusionQuery
): number {
  const filters = parsed.filters;
  if (terms.length === 0) {
    return hasAnyFilter(filters) ? 0.3 : 0;
  }
  const metadataText = [
    node.name,
    node.qualifiedName,
    node.filePath,
    node.signature ?? '',
    node.docstring ?? '',
    node.calls.join(' '),
    content
  ].join(' ');
  let overlap = countTermMatches(metadataText, terms);
  if (overlap === 0 && node.sourceSnippet) {
    overlap = countTermMatches(node.sourceSnippet, terms);
  }
  const nameBoost = filters.name && containsIgnoreCase(node.name, filters.name) ? 0.4 : 0;
  const pathParts = parsed.text.trim().split(/\s+/).filter((part) => isPathLikeQueryPart(part));
  const exactSymbolTerms = parsed.text.trim().split(/\s+/).filter((part) => isLikelyExactSymbolQuery(part));
  const semanticTerms = parsed.text.trim().split(/\s+/).filter((part) => !isPathLikeQueryPart(part) && !isLikelyExactSymbolQuery(part));
  const exactSymbolBonus = semanticTerms.length > 0
    ? exactSymbolTerms.reduce((bonus, part, index) => {
      const normalizedPart = normalizeSearchText(part);
      const normalizedNodeName = normalizeSearchText(node.name);
      const normalizedQualifiedName = normalizeSearchText(node.qualifiedName);
      const normalizedTail = normalizeSearchText(node.qualifiedName.split(/[:.#]/).pop() ?? node.qualifiedName);
      const positionWeight = exactSymbolTerms.length > 1
        ? 1 + ((exactSymbolTerms.length - index - 1) / (exactSymbolTerms.length - 1)) * 0.75
        : 1;
      if (normalizedNodeName === normalizedPart) {
        return bonus + ((pathParts.length > 0 ? 80 : 50) * positionWeight);
      }
      if (normalizedQualifiedName === normalizedPart || normalizedTail === normalizedPart) {
        return bonus + ((pathParts.length > 0 ? 60 : 35) * positionWeight);
      }
      if (
        normalizedQualifiedName.includes(`::${normalizedPart}`) ||
        normalizedQualifiedName.endsWith(normalizedPart)
      ) {
        return bonus + ((pathParts.length > 0 ? 30 : 20) * positionWeight);
      }
      return bonus;
    }, 0)
    : 0;
  const rootClassBonus = exactSymbolTerms.length === 1 &&
    semanticTerms.length > 0 &&
    (node.kind === 'class' || node.kind === 'interface') &&
    normalizeSearchText(node.name) === normalizeSearchText(exactSymbolTerms[0] ?? '') ?
    (pathParts.length > 0 ? 20 : 12)
    : 0;
  const routingBridgeBonus = semanticRoutingBridgeBonus(metadataText, terms, parsed);
  return overlap === 0 ? nameBoost + exactSymbolBonus + rootClassBonus + routingBridgeBonus : overlap / terms.length + nameBoost + exactSymbolBonus + rootClassBonus + routingBridgeBonus;
}

function lexicalScore(content: string, terms: readonly string[], parsed: ParsedFusionQuery): number {
  const filters = parsed.filters;
  if (terms.length === 0) {
    return hasAnyFilter(filters) ? 0.2 : 0;
  }
  const overlap = countTermMatches(content, terms);
  return overlap / terms.length + semanticRoutingBridgeBonus(content, terms, parsed);
}

function rerankFusionNodes(
  nodes: readonly FusionNode[],
  parsed: ParsedFusionQuery,
  snapshot: CodeGraphSnapshot,
  documentByNode: ReadonlyMap<string, VectorDocument>,
  relevanceScorer: RelevanceScorerAdapter,
  relevanceMode: RelevanceMode,
  focus?: QueryFocus,
  preserveExactRoots = false
): FusionNode[] {
  if (nodes.length === 0) {
    return [];
  }

  const snapshotNodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const queryText = parsed.text || parsed.original;
  const exactSymbol = isLikelyExactSymbolQuery(parsed.text)
    ? parsed.text
    : parsed.filters.name && isLikelyExactSymbolQuery(parsed.filters.name)
      ? parsed.filters.name
      : undefined;
  const documents: TextDocument[] = nodes.map((node) => {
    const vectorDocument = documentByNode.get(node.nodeId);
    const snapshotNode = snapshotNodeById.get(node.nodeId);
    const document: TextDocument = {
      nodeId: node.nodeId,
      content: vectorDocument?.content ?? node.content,
      filePath: node.filePath,
      qualifiedName: node.qualifiedName
    };
    if (vectorDocument?.tokens) {
      document.tokens = vectorDocument.tokens;
    }
    if (snapshotNode?.calls?.length) {
      document.callTargets = snapshotNode.calls;
    }
    if (node.freshnessState) {
      document.freshnessState = node.freshnessState;
    }
    document.sourceScores = {
      ...(node.sourceScores.graph !== undefined ? { graph: node.sourceScores.graph } : {}),
      ...(node.sourceScores.vector !== undefined ? { vector: node.sourceScores.vector } : {}),
      ...(node.sourceScores.fts !== undefined ? { fts: node.sourceScores.fts } : {})
    };
    return document;
  });
  const scored = relevanceScorer.score(queryText, documents, {
    mode: relevanceMode,
    intent: parsed.intent,
    ...(exactSymbol ? { exactSymbol } : {})
  });
  const scoresByNode = new Map(scored.map((entry) => [entry.nodeId, entry]));
  const maxMergedScore = Math.max(...nodes.map((node) => node.score), 0);
  const priorWeight = rerankPriorWeight(parsed.route);

  return [...nodes]
    .map((node) => {
      const scoredNode = scoresByNode.get(node.nodeId);
      if (!scoredNode) {
        return node;
      }
      const normalizedMergedScore = maxMergedScore > 0 ? node.score / maxMergedScore : 0;
      const finalScore = scoredNode.score * (1 - priorWeight) + normalizedMergedScore * priorWeight;
      return {
        ...node,
        score: finalScore,
        rankFeatures: {
          ...scoredNode.rankFeatures,
          final: finalScore
        }
      };
    })
    .sort((left, right) => {
      if (focus && preserveExactRoots) {
        const leftPriority = focusAnchorPriority(left, snapshotNodeById.get(left.nodeId), focus, preserveExactRoots);
        const rightPriority = focusAnchorPriority(right, snapshotNodeById.get(right.nodeId), focus, preserveExactRoots);
        const priorityDelta = rightPriority - leftPriority;
        if (priorityDelta !== 0) {
          return priorityDelta;
        }
      }
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      const leftGraph = left.sourceScores.graph ?? 0;
      const rightGraph = right.sourceScores.graph ?? 0;
      const graphDelta = rightGraph - leftGraph;
      if (graphDelta !== 0) {
        return graphDelta;
      }
      return compareFusionNodes(left, right);
    });
}

function rerankPriorWeight(route: QueryRoute): number {
  switch (route) {
    case 'vector-first':
      return 0.1;
    case 'graph-first':
    case 'graph-first-filter':
      return route === 'graph-first-filter' ? 0.45 : 0.35;
    case 'hybrid':
      return 0.2;
  }
}

function mergeCandidates(
  candidates: readonly CandidateDraft[],
  freshness: FreshnessSnapshot,
  parsed: ParsedFusionQuery,
  adjustments?: RankingAdjustments
): FusionNode[] {
  const fusionBoosts = {
    ...FUSION_RANKING_POLICY.fusionBoosts,
    ...(adjustments?.fusionBoostOverrides ?? {})
  };
  const byNode = new Map<string, FusionNode>();
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
      content: candidate.content
    });
  }

  const freshnessByFile = new Map(freshness.entries.map((entry) => [entry.filePath, entry.state]));
  const terms = queryTerms(parsed.text, parsed.filters);

  const ranked = [...byNode.values()]
    .map((node) => {
      let score =
        node.score +
        Math.max(0, node.sources.length - 1) * fusionBoosts.multiSourceBonusPerAdditionalSource;
      score += formulaicBroadQueryBoost(node, terms, parsed.route);
      score += semanticRoutingBridgeBonus(node.content, terms, parsed);
      const kindBoost = adjustments?.kindBoosts?.[node.kind];
      if (kindBoost) {
        score += kindBoost;
      }
      const freshnessState = freshnessByFile.get(node.filePath);
      const warnings: string[] = [];
      if (freshnessState && freshnessState !== 'fresh') {
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
  return ranked;
}

function diversifyBroadHybridResults(
  nodes: FusionNode[],
  parsed: ParsedFusionQuery,
  focus?: QueryFocus,
  preserveExactRoots = false
): FusionNode[] {
  const terms = queryTerms(parsed.text, parsed.filters);
  if (parsed.route !== 'hybrid' || terms.length < 3 || nodes.length < 2) {
    return nodes;
  }
  const remaining = [...nodes];
  const selected: FusionNode[] = [];
  const covered = new Set<string>();
  const maxScore = Math.max(...nodes.map((node) => node.score), 1);

  if (focus?.anchors.length && preserveExactRoots) {
    const anchoredNodes = nodes
      .filter((node) => focusAnchorPriority(node, undefined, focus, preserveExactRoots) > 0)
      .sort((left, right) => {
        const leftPriority = focusAnchorPriority(left, undefined, focus, preserveExactRoots);
        const rightPriority = focusAnchorPriority(right, undefined, focus, preserveExactRoots);
        const priorityDelta = rightPriority - leftPriority;
        if (priorityDelta !== 0) {
          return priorityDelta;
        }
        const scoreDelta = right.score - left.score;
        if (scoreDelta !== 0) {
          return scoreDelta;
        }
        return compareFusionNodes(left, right);
      });
    for (const anchored of anchoredNodes) {
      if (remaining.length === 0) {
        break;
      }
      const index = remaining.findIndex((node) => node.nodeId === anchored.nodeId);
      if (index < 0) {
        continue;
      }
      remaining.splice(index, 1);
      selected.push(anchored);
      for (const term of evidenceTerms(anchored, terms)) {
        covered.add(term);
      }
    }
  }

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

function focusAnchorPriority(
  node: FusionNode,
  snapshotNode: CodeGraphSnapshotNode | undefined,
  focus: QueryFocus,
  preserveExactRoots: boolean
): number {
  if (!preserveExactRoots) {
    return 0;
  }
  const anchor = focus.anchors.find((candidate) => candidate.node.id === node.nodeId || candidate.node.id === snapshotNode?.id);
  if (!anchor) {
    return 0;
  }
  if (anchor.pathMatched && anchor.exactSymbolMatched) {
    return 2;
  }
  if (anchor.pathMatched || anchor.exactSymbolMatched) {
    return 1;
  }
  return 0;
}

function buildQueryFocus(snapshot: CodeGraphSnapshot, parsed: ParsedFusionQuery): QueryFocus {
  const rawParts = parsed.text.trim().split(/\s+/).filter(Boolean);
  const pathParts = [...new Set([
    ...rawParts.filter((part) => isPathLikeQueryPart(part)),
    ...(parsed.filters.file ? [parsed.filters.file] : []),
    ...(parsed.filters.path ? [parsed.filters.path] : [])
  ])];
  const symbolParts = [...new Set([
    ...(parsed.filters.name ? [parsed.filters.name] : []),
    ...rawParts.filter((part) => isLikelyExactSymbolQuery(part))
  ])];
  if (pathParts.length === 0 && symbolParts.length === 0) {
    return { anchors: [] };
  }
  return {
    anchors: snapshot.nodes
      .map((node) => {
        const pathMatched = pathParts.length > 0 && pathParts.some((part) => nodeMatchesQueryPath(node, part));
        const symbolMatched = symbolParts.length > 0 && symbolParts.some((part) => nodeMatchesQuerySymbol(node, part));
        const exactSymbolMatched = symbolParts.length > 0 && symbolParts.some((part) => exactRootSymbolMatch(node, part));
        if (!pathMatched && !symbolMatched) {
          return null;
        }
        return { node, pathMatched, symbolMatched, exactSymbolMatched };
      })
      .filter((anchor): anchor is QueryFocusAnchor => anchor !== null)
  };
}

function shouldPreserveExactRootAnchors(parsed: ParsedFusionQuery): boolean {
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

function shouldSkipSupplementalCandidates(parsed: ParsedFusionQuery): boolean {
  const parts = [
    ...parsed.text.trim().split(/\s+/).filter(Boolean),
    ...(parsed.filters.file ? [parsed.filters.file] : []),
    ...(parsed.filters.path ? [parsed.filters.path] : []),
    ...(parsed.filters.name ? [parsed.filters.name] : [])
  ];
  if (parts.length < 2) {
    return false;
  }
  const pathPartCount = parts.filter((part) => isPathLikeQueryPart(part)).length;
  const exactSymbolCount = parts.filter((part) => isLikelyExactSymbolQuery(part)).length;
  return pathPartCount >= 2 || exactSymbolCount >= 3;
}

function applyQueryFocusBoost(
  score: number,
  candidate: CodeGraphSnapshotNode | undefined,
  focus: QueryFocus,
  fusionBoosts: QueryFocusBoosts
): number {
  if (!candidate || focus.anchors.length === 0) {
    return score;
  }
  let boostedScore = score;
  const exactAnchor = focus.anchors.find((anchor) => anchor.node.id === candidate.id);
  if (exactAnchor) {
    const exactAnchorMultiplier = exactAnchor.pathMatched
      ? (exactAnchor.symbolMatched
        ? fusionBoosts.graphExactMultiplier * Math.max(1, fusionBoosts.callProximityMultiplier)
        : fusionBoosts.graphExactMultiplier)
      : exactAnchor.symbolMatched
        ? fusionBoosts.callProximityMultiplier
        : 1;
    boostedScore *= exactAnchorMultiplier;
  }
  const proximityAnchor = focus.anchors.find((anchor) => anchor.node.id !== candidate.id && hasCallProximity(candidate, anchor.node));
  if (proximityAnchor) {
    if (exactAnchor) {
      boostedScore *= Math.sqrt(fusionBoosts.callProximityMultiplier);
    } else if (proximityAnchor.pathMatched) {
      boostedScore *= fusionBoosts.callProximityMultiplier;
    } else if (proximityAnchor.symbolMatched) {
      boostedScore *= Math.max(1, (fusionBoosts.callProximityMultiplier + 1) / 2);
    }
  }
  if (boostedScore > score) {
    boostedScore *= memberSpecificityMultiplier(candidate);
  }
  const classMemberBoost = classMemberFocusMultiplier(candidate, focus);
  if (classMemberBoost > 1) {
    boostedScore *= classMemberBoost;
  }
  return boostedScore;
}

function nodeMatchesQueryPath(node: CodeGraphSnapshotNode, part: string): boolean {
  const normalizedPart = normalizeSearchText(part);
  const normalizedFilePath = normalizeSearchText(node.filePath);
  const normalizedQualifiedName = normalizeSearchText(node.qualifiedName);
  return normalizedFilePath.includes(normalizedPart) || normalizedQualifiedName.includes(normalizedPart);
}

function nodeMatchesQuerySymbol(node: CodeGraphSnapshotNode, part: string): boolean {
  const normalizedPart = normalizeSearchText(part);
  const normalizedName = normalizeSearchText(node.name);
  const normalizedQualifiedName = normalizeSearchText(node.qualifiedName);
  const tail = normalizeSearchText(node.qualifiedName.split(/[:.#]/).pop() ?? node.qualifiedName);
  return normalizedName.includes(normalizedPart) || normalizedQualifiedName.includes(normalizedPart) || tail.includes(normalizedPart);
}

function exactRootSymbolMatch(node: CodeGraphSnapshotNode, part: string): boolean {
  const normalizedPart = normalizeSearchText(part);
  const normalizedName = normalizeSearchText(node.name);
  const normalizedQualifiedName = normalizeSearchText(node.qualifiedName);
  const tail = normalizeSearchText(node.qualifiedName.split(/[:.#]/).pop() ?? node.qualifiedName);
  return normalizedName === normalizedPart || normalizedQualifiedName === normalizedPart || tail === normalizedPart;
}

function hasCallProximity(candidate: CodeGraphSnapshotNode, anchor: CodeGraphSnapshotNode): boolean {
  return candidate.calls.some((call) => referencesQueryNode(call, anchor)) || anchor.calls.some((call) => referencesQueryNode(call, candidate));
}

function referencesQueryNode(reference: string, node: CodeGraphSnapshotNode): boolean {
  const normalizedReference = normalizeSearchText(reference);
  const candidates = new Set([
    normalizeSearchText(node.name),
    normalizeSearchText(node.qualifiedName),
    normalizeSearchText(node.qualifiedName.split(/[:.#]/).pop() ?? node.qualifiedName)
  ]);
  for (const candidate of candidates) {
    if (candidate && normalizedReference.includes(candidate)) {
      return true;
    }
  }
  return false;
}

function isPathLikeQueryPart(part: string): boolean {
  return /[\\/]/.test(part) || /::/.test(part) || /\.[A-Za-z0-9]{1,8}\b/.test(part);
}

function memberSpecificityMultiplier(candidate: CodeGraphSnapshotNode): number {
  const memberDepth = qualifiedNameMemberDepth(candidate.qualifiedName);
  if (memberDepth <= 0) {
    return 1;
  }
  return 1 + Math.min(1, memberDepth * 0.4);
}

function classMemberFocusMultiplier(candidate: CodeGraphSnapshotNode, focus: QueryFocus): number {
  const memberDepth = qualifiedNameMemberDepth(candidate.qualifiedName);
  if (memberDepth <= 0) {
    return 1;
  }
  const enclosingClass = qualifiedNameEnclosingType(candidate.qualifiedName);
  if (!enclosingClass) {
    return 1;
  }
  const normalizedEnclosingClass = normalizeSearchText(enclosingClass);
  const exactClassAnchor = focus.anchors.find((anchor) =>
    (anchor.node.kind === 'class' || anchor.node.kind === 'interface') &&
    (anchor.pathMatched || anchor.symbolMatched)
  );
  if (exactClassAnchor) {
    const normalizedAnchorName = normalizeSearchText(exactClassAnchor.node.name);
    if (normalizedAnchorName.includes(normalizedEnclosingClass) || normalizedEnclosingClass.includes(normalizedAnchorName)) {
      return 1;
    }
  }
  const matchingClassAnchor = focus.anchors.some((anchor) => {
    if (anchor.node.id === candidate.id) {
      return false;
    }
    if (anchor.node.kind !== 'class' && anchor.node.kind !== 'interface') {
      return false;
    }
    const normalizedAnchorName = normalizeSearchText(anchor.node.name);
    return normalizedAnchorName.includes(normalizedEnclosingClass) || normalizedEnclosingClass.includes(normalizedAnchorName);
  });
  if (!matchingClassAnchor) {
    return 1;
  }
  return 1 + Math.min(15, memberDepth * 12);
}

function qualifiedNameMemberDepth(qualifiedName: string): number {
  return Math.max(0, qualifiedName.split('::').length - 1);
}

function qualifiedNameEnclosingType(qualifiedName: string): string | undefined {
  const parts = qualifiedName.split('::').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) {
    return undefined;
  }
  return parts[parts.length - 2];
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
  return Math.min(1.2, evidenceOverlap * 0.35 + pathOverlap * 0.5);
}

function semanticRoutingBridgeBonus(content: string, terms: readonly string[], parsed: ParsedFusionQuery): number {
  if (parsed.intent !== 'semantic-ranking' || !shouldRelaxSemanticRankingPathFilters(parsed)) {
    return 0;
  }

  const queryTermsSet = new Set(terms);
  const hasOrderingSignal = ['priority', 'ranking', 'order', 'ordering'].some((term) => queryTermsSet.has(term));
  const hasMixedSourceSignal = ['mixed', 'result', 'results', 'search', 'source', 'sources'].some((term) => queryTermsSet.has(term));
  if (!hasOrderingSignal || !hasMixedSourceSignal) {
    return 0;
  }

  const normalized = normalizeSearchText(content);
  let bonus = 0;
  if (normalized.includes('intent') && normalized.includes('router')) {
    bonus += 0.9;
  }
  if (normalized.includes('parse') || normalized.includes('query') || normalized.includes('route')) {
    bonus += 0.25;
  }
  if (normalized.includes('semantic')) {
    bonus += 0.15;
  }
  return bonus;
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

function countTermMatches(text: string, terms: readonly string[]): number {
  if (!text || terms.length === 0) {
    return 0;
  }
  const normalized = normalizeSearchText(text);
  let count = 0;
  for (const term of terms) {
    if (normalized.includes(term)) {
      count += 1;
    }
  }
  return count;
}

function normalizeSearchText(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-./:(){}[\],;<>+=!?'"`|\\]+/g, ' ')
    .toLowerCase();
}
