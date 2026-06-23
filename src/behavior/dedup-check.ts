import { FusionStore } from '../freshness/fusion-store.js';
import { openCollection, type CodeVectorCollection } from '../vector/collection-manager.js';
import { DEFAULT_CHUNKER_VERSION } from '../vector/chunker.js';
import { tokenizeCodeText } from '../vector/embedding/local.js';
import type { VectorDocument } from '../vector/code-to-vectors.js';
import type { VectorSearchResult } from '../vector/zvec-adapter.js';

export const DEFAULT_DEDUP_THRESHOLD = 0.85;
export const DEFAULT_DEDUP_TOPK = 5;

export interface DedupCandidate {
  nodeId: string;
  qualifiedName: string;
  filePath: string;
  kind: string;
  score: number;
  content?: string;
}

export interface DedupCheckRequest {
  description: string;
  threshold?: number | undefined;
  topk?: number | undefined;
}

export interface DedupRecommendation {
  action: 'reuse' | 'none';
  message: string;
}

export interface DedupCheckResult {
  description: string;
  threshold: number;
  matches: DedupCandidate[];
  recommendation: DedupRecommendation;
}

export interface DedupCheckerDependencies {
  search(description: string, topk: number): Promise<readonly DedupCandidate[]>;
}

export interface RunDedupCheckOptions {
  projectPath?: string;
  description: string;
  threshold?: number;
  topk?: number;
  checker?: Pick<DedupChecker, 'check'>;
}

export type DedupCollectionOpener = (projectPath: string) => Pick<CodeVectorCollection, 'query' | 'destroy'>;
export type DedupDocumentLister = (projectPath: string) => readonly VectorDocument[];

export class DedupChecker {
  readonly threshold: number;
  private readonly dependencies: DedupCheckerDependencies;

  constructor(projectPath = process.cwd(), options: { threshold?: number; dependencies?: DedupCheckerDependencies } = {}) {
    this.threshold = options.threshold ?? DEFAULT_DEDUP_THRESHOLD;
    this.dependencies = options.dependencies ?? defaultDependencies(projectPath);
  }

  async check(request: DedupCheckRequest): Promise<DedupCheckResult> {
    const description = request.description.trim();
    if (!description) {
      throw new Error('dedup description must be non-empty');
    }
    const threshold = request.threshold ?? this.threshold;
    validateThreshold(threshold);
    const topk = request.topk ?? DEFAULT_DEDUP_TOPK;
    const candidates = await this.dependencies.search(description, Math.max(topk, DEFAULT_DEDUP_TOPK));
    const matches = candidates
      .filter((candidate) => Number.isFinite(candidate.score) && candidate.score >= threshold)
      .sort((left, right) => right.score - left.score)
      .slice(0, topk);
    return {
      description,
      threshold,
      matches,
      recommendation: matches.length > 0 ? reuseRecommendation(matches[0]!, threshold) : noDuplicateRecommendation(threshold)
    };
  }
}

export function formatDedupResult(result: DedupCheckResult): string {
  const lines = [
    'checkType: dedup-check',
    result.recommendation.message,
    `threshold=${result.threshold}`,
    `matches=${result.matches.length}`
  ];
  for (const match of result.matches) {
    lines.push(`- ${match.qualifiedName} (${match.filePath}) score=${match.score.toFixed(2)}`);
  }
  return lines.join('\n');
}

export async function runDedupCheck(options: RunDedupCheckOptions): Promise<DedupCheckResult> {
  if (options.threshold !== undefined) {
    validateThreshold(options.threshold);
  }
  const checker = options.checker ?? new DedupChecker(options.projectPath ?? process.cwd());
  const request: DedupCheckRequest = { description: options.description };
  if (options.threshold !== undefined) {
    request.threshold = options.threshold;
  }
  if (options.topk !== undefined) {
    request.topk = options.topk;
  }
  return checker.check(request);
}

export function validateThreshold(threshold: number): void {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`dedup threshold must be between 0 and 1, got ${threshold}`);
  }
}

function reuseRecommendation(match: DedupCandidate, threshold: number): DedupRecommendation {
  return {
    action: 'reuse',
    message: `Semantic duplicate found: existing ${match.kind} ${match.qualifiedName} (${match.filePath}) scored ${Math.round(match.score * 100)}% >= ${Math.round(threshold * 100)}%; reuse it instead of duplicating.`
  };
}

function noDuplicateRecommendation(threshold: number): DedupRecommendation {
  return {
    action: 'none',
    message: `No semantic duplicate above ${Math.round(threshold * 100)}%; no reuse suggestion.`
  };
}

function defaultDependencies(projectPath: string): DedupCheckerDependencies {
  return { search: createVectorDedupSearch(projectPath) };
}

export function createVectorDedupSearch(
  projectPath: string,
  open: DedupCollectionOpener = openCollection,
  listDocuments: DedupDocumentLister = listVectorDocuments
): DedupCheckerDependencies['search'] {
  return {
    async search(description: string, topk: number): Promise<DedupCandidate[]> {
      const queryTokens = new Set(tokenizeCodeText(description));
      if (queryTokens.size === 0) {
        return [];
      }
      const collection = open(projectPath);
      try {
        const documentsByNode = new Map(listDocuments(projectPath).map((document) => [document.nodeId, document]));
        const results = await collection.query([{ text: description }], topk);
        return results
          .filter((result) => result.chunkerVersion === DEFAULT_CHUNKER_VERSION)
          .map((result) => vectorResultToCandidate(result, queryTokens, documentsByNode.get(result.nodeId)))
          .sort((left, right) => right.score - left.score)
          .slice(0, topk);
      } finally {
        collection.destroy();
      }
    }
  }.search;
}

function listVectorDocuments(projectPath: string): VectorDocument[] {
  const store = new FusionStore(projectPath);
  try {
    return store.listVectorDocuments()
      .map((stored) => asVectorDocument(stored.json))
      .filter((document): document is VectorDocument => document !== null);
  } finally {
    store.close();
  }
}

function vectorResultToCandidate(
  result: VectorSearchResult,
  queryTokens: ReadonlySet<string>,
  document: VectorDocument | undefined
): DedupCandidate {
  const vectorScore = normalizeVectorScore(result.score);
  const calibratedScore = document ? Math.min(vectorScore, conservativeTokenSimilarity(queryTokens, document)) : vectorScore;
  return {
    nodeId: result.nodeId,
    qualifiedName: result.qualifiedName,
    filePath: result.filePath,
    kind: result.kind,
    score: calibratedScore,
    ...(document?.content ? { content: document.content } : {})
  };
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

function conservativeTokenSimilarity(queryTokens: ReadonlySet<string>, document: VectorDocument): number {
  const documentTokens = new Set([
    ...document.tokens,
    ...tokenizeCodeText(document.qualifiedName),
    ...tokenizeCodeText(document.content)
  ]);
  if (documentTokens.size === 0) {
    return 0;
  }
  const overlap = [...queryTokens].filter((token) => documentTokens.has(token)).length;
  const coverage = overlap / queryTokens.size;
  const precision = overlap / Math.min(documentTokens.size, Math.max(queryTokens.size, 1));
  return Math.min(1, (coverage + precision) / 2);
}

function normalizeVectorScore(score: number): number {
  if (!Number.isFinite(score) || score <= 0) {
    return 0;
  }
  return Math.min(1, score);
}
