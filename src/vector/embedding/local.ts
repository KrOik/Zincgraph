import { createHash } from 'node:crypto';

import type { EmbeddingAdapter, EmbeddingResult } from './registry.js';

export interface LocalTokenEmbeddingOptions {
  dimension?: number;
  profile?: string;
}

export const DEFAULT_LOCAL_EMBEDDING_DIMENSION = 64;
const HASH_SPACE = 1_000_003;
const MIN_TOKEN_LENGTH = 2;
const SEMANTIC_QUERY_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  decide: ['route', 'resolve', 'select'],
  decides: ['route', 'resolve', 'select'],
  mixed: ['fusion', 'merge'],
  multiple: ['multi'],
  ordering: ['rank', 'ranking', 'order'],
  ordered: ['rank', 'ranking', 'order'],
  priority: ['rank', 'ranking', 'order'],
  relevance: ['rank', 'ranking'],
  result: ['candidate', 'hit'],
  results: ['candidate', 'hit'],
  routing: ['route', 'resolve'],
  source: ['origin', 'input'],
  sources: ['origin', 'input']
};

const SEMANTIC_ROUTING_ANCHOR_TERMS = new Set([
  'priority',
  'ordering',
  'rank',
  'ranking'
]);
const SEMANTIC_ROUTING_TRIGGER_TERMS = new Set([
  'mixed',
  'multiple',
  'results',
  'search',
  'sources'
]);
const SEMANTIC_ROUTING_HINTS = ['intent', 'parse', 'query', 'route', 'router'];

export interface TokenizeCodeTextOptions {
  expandSynonyms?: boolean;
}

export class LocalTokenEmbedding implements EmbeddingAdapter {
  readonly provider = 'local' as const;
  readonly profile: string;
  readonly dimension: number;

  constructor(options: LocalTokenEmbeddingOptions = {}) {
    this.dimension = options.dimension ?? DEFAULT_LOCAL_EMBEDDING_DIMENSION;
    this.profile = options.profile ?? defaultLocalEmbeddingProfile(this.dimension);
  }

  async embed(texts: readonly string[]): Promise<EmbeddingResult[]> {
    return texts.map((text) => embedText(text, this.dimension));
  }
}

export function defaultLocalEmbeddingProfile(dimension = DEFAULT_LOCAL_EMBEDDING_DIMENSION): string {
  return `local-token-v1:${dimension}`;
}

export function tokenizeCodeText(text: string, options: TokenizeCodeTextOptions = {}): string[] {
  const spaced = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-./:(){}[\],;<>+=!?'"`|\\]+/g, ' ');

  const tokens = new Set<string>();
  for (const raw of spaced.split(/\s+/)) {
    const token = raw.trim().toLowerCase();
    if (!token || token.length < MIN_TOKEN_LENGTH || /^\d+$/.test(token)) {
      continue;
    }
    tokens.add(token);
    for (const stem of stemsFor(token)) {
      if (stem.length >= MIN_TOKEN_LENGTH) {
        tokens.add(stem);
      }
    }
    if (options.expandSynonyms) {
      for (const synonym of SEMANTIC_QUERY_SYNONYMS[token] ?? []) {
        if (synonym.length >= MIN_TOKEN_LENGTH) {
          tokens.add(synonym);
        }
      }
    }
  }
  if (options.expandSynonyms) {
    addSemanticRoutingHints(tokens);
  }
  return [...tokens].sort();
}

export function expandSemanticQueryTokens(text: string): string[] {
  return tokenizeCodeText(text, { expandSynonyms: true });
}

export function expandSemanticQueryText(text: string): string {
  return expandSemanticQueryTokens(text).join(' ');
}

export function sparseVectorForText(text: string): Record<number, number> {
  return sparseVectorFromTokens(tokenizeCodeText(text));
}

export function sparseVectorFromTokens(tokens: readonly string[]): Record<number, number> {
  const sparse: Record<number, number> = {};
  for (const token of new Set(tokens.map((value) => value.trim().toLowerCase()).filter(Boolean))) {
    if (token.length < MIN_TOKEN_LENGTH) {
      continue;
    }
    const index = stableHash(token) % HASH_SPACE;
    sparse[index] = (sparse[index] ?? 0) + 1;
  }
  return sparse;
}

function stemsFor(token: string): string[] {
  const stems: string[] = [];
  const suffixes: Array<[string, number]> = [
    ['ation', 5],
    ['ing', 3],
    ['ed', 2],
    ['es', 2],
    ['s', 1]
  ];

  for (const [suffix, size] of suffixes) {
    if (token.endsWith(suffix) && token.length > size + 2) {
      stems.push(token.slice(0, -size));
    }
  }

  if (token.endsWith('ation') && token.length > 7) {
    stems.push(`${token.slice(0, -5)}e`);
  }
  if (token.endsWith('ing') && token.length > 5) {
    stems.push(token.slice(0, -3).replace(/(.)\1$/, '$1'));
  }
  return stems;
}

function embedText(text: string, dimension: number): EmbeddingResult {
  const tokens = tokenizeCodeText(text);
  const sparse: Record<number, number> = {};
  const dense = Array.from({ length: dimension }, () => 0);

  for (const token of tokens) {
    const sparseIndex = stableHash(token) % HASH_SPACE;
    sparse[sparseIndex] = (sparse[sparseIndex] ?? 0) + 1;

    const denseIndex = stableHash(`dense:${token}`) % dimension;
    dense[denseIndex] = (dense[denseIndex] ?? 0) + 1;
  }

  normalizeInPlace(dense);
  return { sparse, dense, tokens };
}

function addSemanticRoutingHints(tokens: Set<string>): void {
  const hasAnchorTerm = [...SEMANTIC_ROUTING_ANCHOR_TERMS].some((term) => tokens.has(term));
  const hasTriggerTerm = [...SEMANTIC_ROUTING_TRIGGER_TERMS].some((term) => tokens.has(term));
  if (!hasAnchorTerm || !hasTriggerTerm) {
    return;
  }
  for (const hint of SEMANTIC_ROUTING_HINTS) {
    tokens.add(hint);
  }
}

function stableHash(text: string): number {
  const digest = createHash('sha256').update(text).digest();
  return digest.readUInt32BE(0);
}

function normalizeInPlace(vector: number[]): void {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    return;
  }
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = (vector[index] ?? 0) / norm;
  }
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function sparseCosineSimilarity(left: Record<number, number>, right: Record<number, number>): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (const [key, value] of Object.entries(left)) {
    leftNorm += value * value;
    dot += value * (right[Number(key)] ?? 0);
  }
  for (const value of Object.values(right)) {
    rightNorm += value * value;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
