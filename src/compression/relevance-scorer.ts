import { tokenizeCodeText } from '../vector/embedding/local.js';

export type RelevanceMode = 'bm25' | 'embedding' | 'hybrid';

export interface TextDocument {
  nodeId: string;
  content: string;
  filePath: string;
  qualifiedName: string;
  tokens?: string[];
}

export interface ScoredDocument {
  nodeId: string;
  score: number;
  bm25Score?: number;
  embeddingScore?: number;
}

export interface ScorerOptions {
  mode: RelevanceMode;
  bm25Weight?: number;
  embeddingWeight?: number;
  bm25K1?: number;
  bm25B?: number;
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
const DEFAULT_BM25_WEIGHT = 0.5;
const DEFAULT_EMBEDDING_WEIGHT = 0.5;

export class RelevanceScorer implements RelevanceScorerAdapter {
  private readonly embeddingFn: EmbeddingFunction | undefined;

  constructor(dependencies: RelevanceScorerDependencies = {}) {
    this.embeddingFn = dependencies.embeddingFn;
  }

  score(query: string, documents: TextDocument[], options: ScorerOptions): ScoredDocument[] {
    switch (options.mode) {
      case 'bm25':
        return documents.map((document) => ({
          nodeId: document.nodeId,
          score: this.bm25Score(query, document, documents, options)
        }));
      case 'embedding':
        return documents.map((document) => ({
          nodeId: document.nodeId,
          score: this.embeddingScore(query, document)
        }));
      case 'hybrid':
      default: {
        const bm25Weight = options.bm25Weight ?? DEFAULT_BM25_WEIGHT;
        const embeddingWeight = options.embeddingWeight ?? DEFAULT_EMBEDDING_WEIGHT;
        return documents.map((document) => {
          const bm25 = this.bm25Score(query, document, documents, options);
          const embedding = this.embeddingScore(query, document);
          return {
            nodeId: document.nodeId,
            score: bm25Weight * bm25 + embeddingWeight * embedding,
            bm25Score: bm25,
            embeddingScore: embedding
          };
        });
      }
    }
  }

  private bm25Score(query: string, document: TextDocument, corpus: TextDocument[], options: ScorerOptions): number {
    const k1 = options.bm25K1 ?? DEFAULT_BM25_K1;
    const b = options.bm25B ?? DEFAULT_BM25_B;
    const queryTerms = tokenizeCodeText(query);
    if (queryTerms.length === 0) {
      return 0;
    }

    const documentTokens = document.tokens ?? tokenizeCodeText(`${document.content} ${document.filePath} ${document.qualifiedName}`);
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
    if (!this.embeddingFn) {
      return sparseCosineSimilarity(tokenizeCodeText(query), tokenizeCodeText(`${document.qualifiedName} ${document.content}`));
    }

    const queryVector = this.embeddingFn.embed(query);
    const docVector = this.embeddingFn.embed(`${document.qualifiedName} ${document.content.slice(0, 500)}`);
    return cosineSimilarity(queryVector, docVector);
  }
}

function computeAverageDocumentLength(corpus: TextDocument[]): number {
  if (corpus.length === 0) {
    return 1;
  }
  const total = corpus.reduce((sum, document) => {
    const tokens = document.tokens ?? tokenizeCodeText(`${document.content} ${document.filePath} ${document.qualifiedName}`);
    return sum + tokens.length;
  }, 0);
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
    const tokens = document.tokens ?? tokenizeCodeText(`${document.content} ${document.filePath} ${document.qualifiedName}`);
    const seen = new Set<string>();
    for (const token of tokens) {
      if (!seen.has(token)) {
        seen.add(token);
        documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
      }
    }
  }
  return documentFrequency;
}

function sparseCosineSimilarity(queryTokens: string[], documentTokens: string[]): number {
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

export function createDefaultRelevanceScorer(): RelevanceScorer {
  return new RelevanceScorer();
}
