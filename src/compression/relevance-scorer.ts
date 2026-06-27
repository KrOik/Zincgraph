import { expandSemanticQueryText, expandSemanticQueryTokens, tokenizeCodeText } from '../vector/embedding/local.js';
import type { ManifestState } from '../freshness/manifest.js';
import type { FusionIntent } from '../fusion/intent-router.js';

export type RelevanceMode = 'bm25' | 'embedding' | 'hybrid';

export interface TextDocument {
  nodeId: string;
  content: string;
  filePath: string;
  qualifiedName: string;
  tokens?: string[];
  callTargets?: string[];
  freshnessState?: ManifestState;
  sourceScores?: Partial<Record<'graph' | 'vector' | 'fts', number>>;
}

export interface RankFeatureWeights {
  lexical: number;
  semantic: number;
  structure: number;
  freshness: number;
}

export interface RankFeatureScores {
  lexical: number;
  semantic: number;
  structure: number;
  freshness: number;
  final: number;
}

export interface ScoredDocument {
  nodeId: string;
  score: number;
  bm25Score: number;
  embeddingScore: number;
  lexicalScore: number;
  semanticScore: number;
  structureScore: number;
  freshnessScore: number;
  matchedTerms: string[];
  rankFeatures: RankFeatureScores;
  rankWeights: RankFeatureWeights;
}

export interface ScorerOptions {
  mode: RelevanceMode;
  bm25Weight?: number;
  embeddingWeight?: number;
  bm25K1?: number;
  bm25B?: number;
  intent?: FusionIntent;
  exactSymbol?: string;
}

export interface RelevanceScorerAdapter {
  score(query: string, documents: TextDocument[], options: ScorerOptions): ScoredDocument[];
}

export interface EmbeddingFunction {
  embed(text: string): number[];
}

export interface RelevanceScorerDependencies {
  embeddingFn?: EmbeddingFunction;
}

const DEFAULT_BM25_K1 = 1.2;
const DEFAULT_BM25_B = 0.75;
const DEFAULT_INTENT: FusionIntent = 'graph-navigation';
const DEFAULT_HYBRID_WEIGHTS: Record<FusionIntent, RankFeatureWeights> = {
  'exact-symbol': { lexical: 0.2, semantic: 0.05, structure: 0.65, freshness: 0.1 },
  'graph-navigation': { lexical: 0.22, semantic: 0.18, structure: 0.5, freshness: 0.1 },
  'freshness/status': { lexical: 0.18, semantic: 0.12, structure: 0.3, freshness: 0.4 },
  'semantic-ranking': { lexical: 0.18, semantic: 0.52, structure: 0.22, freshness: 0.08 },
  'compression-feedback': { lexical: 0.22, semantic: 0.22, structure: 0.4, freshness: 0.16 }
};
const FRESHNESS_STATE_SCORES: Record<ManifestState, number> = {
  fresh: 1,
  pending: 0.45,
  stale: 0.15,
  failed: 0
};

/**
 * Search-result reranker for semantic ranking and priority ordering.
 * Blends lexical, embedding, structure, and freshness evidence across mixed sources.
 */
export class RelevanceScorer implements RelevanceScorerAdapter {
  private readonly embeddingFn: EmbeddingFunction | undefined;

  constructor(dependencies: RelevanceScorerDependencies = {}) {
    this.embeddingFn = dependencies.embeddingFn;
  }

  score(query: string, documents: TextDocument[], options: ScorerOptions): ScoredDocument[] {
    if (documents.length === 0) {
      return [];
    }

    const queryTerms = expandSemanticQueryTokens(query);
    const lexicalRaw = documents.map((document) => Math.max(this.bm25Score(query, document, documents, options), document.sourceScores?.fts ?? 0));
    const semanticRaw = documents.map((document) => Math.max(this.embeddingScore(query, document), document.sourceScores?.vector ?? 0));
    const structureRaw = documents.map((document) => this.structureScore(queryTerms, document, options.exactSymbol));
    const graphStructuralRaw = documents.map((document) => document.sourceScores?.graph ?? 0);
    const freshnessRaw = documents.map((document) => freshnessScore(document.freshnessState));
    const lexicalScores = normalizeSeries(lexicalRaw);
    const semanticScores = normalizeSeries(semanticRaw);
    const graphStructuralScores = normalizeSeries(graphStructuralRaw);
    const structureScores = structureRaw.map((score, index) => clamp01(score * 0.5 + (graphStructuralScores[index] ?? 0) * 0.5));
    const freshnessScores = freshnessRaw.map(clamp01);
    const weights = resolveWeights(options);

    return documents.map((document, index) => {
      const lexicalScore = lexicalScores[index] ?? 0;
      const semanticScore = semanticScores[index] ?? 0;
      const structureScore = structureScores[index] ?? 0;
      const freshnessScore = freshnessScores[index] ?? 0;
      const score = (
        lexicalScore * weights.lexical +
        semanticScore * weights.semantic +
        structureScore * weights.structure +
        freshnessScore * weights.freshness
      );
      return {
        nodeId: document.nodeId,
        score,
        bm25Score: lexicalRaw[index] ?? 0,
        embeddingScore: semanticRaw[index] ?? 0,
        lexicalScore,
        semanticScore,
        structureScore,
        freshnessScore,
        matchedTerms: matchedTermsForDocument(queryTerms, document),
        rankFeatures: {
          lexical: lexicalScore,
          semantic: semanticScore,
          structure: structureScore,
          freshness: freshnessScore,
          final: score
        },
        rankWeights: weights
      };
    });
  }

  private bm25Score(query: string, document: TextDocument, corpus: TextDocument[], options: ScorerOptions): number {
    const k1 = options.bm25K1 ?? DEFAULT_BM25_K1;
    const b = options.bm25B ?? DEFAULT_BM25_B;
    const queryTerms = tokenizeCodeText(query);
    if (queryTerms.length === 0) {
      return 0;
    }

    const documentTokens = documentTokensFor(document);
    const documentLength = documentTokens.length;
    const avgDocumentLength = computeAverageDocumentLength(corpus);
    const termFrequencyMap = buildTermFrequencyMap(documentTokens);
    const documentFrequencyMap = buildDocumentFrequencyMap(corpus);
    const corpusSize = corpus.length;

    let score = 0;
    for (const term of queryTerms) {
      const tf = termFrequencyMap.get(term) ?? 0;
      const df = documentFrequencyMap.get(term) ?? 0;
      if (tf === 0 || df === 0) {
        continue;
      }
      const idf = Math.log((corpusSize - df + 0.5) / (df + 0.5) + 1);
      const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (documentLength / Math.max(1, avgDocumentLength))));
      score += idf * tfNorm;
    }

    return score;
  }

  private embeddingScore(query: string, document: TextDocument): number {
    const expandedQuery = expandSemanticQueryText(query);
    if (!this.embeddingFn) {
      return tokenCosineSimilarity(expandSemanticQueryTokens(query), documentTokensFor(document));
    }

    const queryVector = this.embeddingFn.embed(expandedQuery);
    const docVector = this.embeddingFn.embed(`${document.qualifiedName} ${document.content.slice(0, 500)}`);
    return Math.max(0, cosineSimilarity(queryVector, docVector));
  }

  private structureScore(queryTerms: readonly string[], document: TextDocument, exactSymbol: string | undefined): number {
    if (queryTerms.length === 0 && !exactSymbol) {
      return 0;
    }
    const metadata = normalizeSearchText(`${document.filePath} ${document.qualifiedName}`);
    const callTargets = normalizeSearchText((document.callTargets ?? []).join(' '));
    const querySymbol = canonicalSymbol(exactSymbol);
    const qualifiedTail = canonicalSymbol(document.qualifiedName.split(/[:.#]/).pop() ?? document.qualifiedName);
    const qualifiedName = canonicalSymbol(document.qualifiedName);
    const pathOverlap = countTermMatches(metadata, queryTerms) / Math.max(1, queryTerms.length);
    const callOverlap = countTermMatches(callTargets, queryTerms) / Math.max(1, queryTerms.length);
    const exactSymbolBoost = querySymbol && (qualifiedTail === querySymbol || qualifiedName === querySymbol) ? 1 : 0;
    return clamp01(pathOverlap * 0.55 + callOverlap * 0.2 + exactSymbolBoost * 0.45);
  }
}

function computeAverageDocumentLength(corpus: TextDocument[]): number {
  if (corpus.length === 0) {
    return 1;
  }
  const total = corpus.reduce((sum, document) => sum + documentTokensFor(document).length, 0);
  return total / corpus.length;
}

function buildTermFrequencyMap(tokens: string[]): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  return frequencies;
}

function buildDocumentFrequencyMap(corpus: TextDocument[]): Map<string, number> {
  const documentFrequency = new Map<string, number>();
  for (const document of corpus) {
    const seen = new Set<string>();
    for (const token of documentTokensFor(document)) {
      if (!seen.has(token)) {
        seen.add(token);
        documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
      }
    }
  }
  return documentFrequency;
}

function documentTokensFor(document: TextDocument): string[] {
  return document.tokens ?? tokenizeCodeText(
    `${document.content} ${document.filePath} ${document.qualifiedName} ${(document.callTargets ?? []).join(' ')}`
  );
}

function matchedTermsForDocument(queryTerms: readonly string[], document: TextDocument): string[] {
  if (queryTerms.length === 0) {
    return [];
  }
  const tokens = new Set(documentTokensFor(document));
  return queryTerms.filter((term) => tokens.has(term));
}

function resolveWeights(options: ScorerOptions): RankFeatureWeights {
  if (options.mode === 'bm25') {
    return { lexical: 1, semantic: 0, structure: 0, freshness: 0 };
  }
  if (options.mode === 'embedding') {
    return { lexical: 0, semantic: 1, structure: 0, freshness: 0 };
  }

  if (options.bm25Weight !== undefined || options.embeddingWeight !== undefined) {
    const lexical = Math.max(0, options.bm25Weight ?? 0);
    const semantic = Math.max(0, options.embeddingWeight ?? 0);
    const remaining = Math.max(0, 1 - lexical - semantic);
    return normalizeWeights({
      lexical,
      semantic,
      structure: remaining / 2,
      freshness: remaining / 2
    });
  }

  return normalizeWeights(DEFAULT_HYBRID_WEIGHTS[options.intent ?? DEFAULT_INTENT]);
}

function normalizeWeights(weights: RankFeatureWeights): RankFeatureWeights {
  const total = weights.lexical + weights.semantic + weights.structure + weights.freshness;
  if (total <= 0) {
    return { lexical: 1, semantic: 0, structure: 0, freshness: 0 };
  }
  return {
    lexical: weights.lexical / total,
    semantic: weights.semantic / total,
    structure: weights.structure / total,
    freshness: weights.freshness / total
  };
}

function freshnessScore(state: ManifestState | undefined): number {
  return state ? FRESHNESS_STATE_SCORES[state] : 0.6;
}

function normalizeSeries(values: readonly number[]): number[] {
  const sanitized = values.map((value) => Number.isFinite(value) ? Math.max(0, value) : 0);
  const max = Math.max(...sanitized, 0);
  if (max <= 0) {
    return sanitized.map(() => 0);
  }
  return sanitized.map((value) => clamp01(value / max));
}

function tokenCosineSimilarity(queryTokens: string[], documentTokens: string[]): number {
  const queryFreq = buildTermFrequencyMap(queryTokens);
  const docFreq = buildTermFrequencyMap(documentTokens);
  let dotProduct = 0;
  let queryNorm = 0;
  let docNorm = 0;

  for (const [term, frequency] of queryFreq) {
    queryNorm += frequency * frequency;
    const documentFrequency = docFreq.get(term);
    if (documentFrequency !== undefined) {
      dotProduct += frequency * documentFrequency;
    }
  }
  for (const frequency of docFreq.values()) {
    docNorm += frequency * frequency;
  }

  const denominator = Math.sqrt(queryNorm) * Math.sqrt(docNorm);
  return denominator > 0 ? dotProduct / denominator : 0;
}

function cosineSimilarity(vectorA: number[], vectorB: number[]): number {
  if (vectorA.length !== vectorB.length || vectorA.length === 0) {
    return 0;
  }
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < vectorA.length; index++) {
    const valueA = vectorA[index] ?? 0;
    const valueB = vectorB[index] ?? 0;
    dotProduct += valueA * valueB;
    normA += valueA * valueA;
    normB += valueB * valueB;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator > 0 ? dotProduct / denominator : 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function countTermMatches(text: string, terms: readonly string[]): number {
  if (!text || terms.length === 0) {
    return 0;
  }
  let count = 0;
  for (const term of terms) {
    if (text.includes(term)) {
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

function canonicalSymbol(value: string | undefined): string {
  return value ? value.replace(/[^A-Za-z0-9_$]+/g, '').toLowerCase() : '';
}

export function createDefaultRelevanceScorer(): RelevanceScorer {
  return new RelevanceScorer();
}
