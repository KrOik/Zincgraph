import { expandSemanticQueryTokens } from '../vector/embedding/local.js';

/**
 * Semantic intent router for priority ordering when search results are mixed from multiple sources.
 * Keeps ranking-aware queries, graph navigation, freshness, and compression feedback on the right route.
 */
export type QueryRoute = 'graph-first' | 'graph-first-filter' | 'vector-first' | 'hybrid';
export type FusionIntent =
  | 'exact-symbol'
  | 'graph-navigation'
  | 'freshness/status'
  | 'semantic-ranking'
  | 'compression-feedback';

export interface ScalarFilters {
  language?: string;
  kind?: string;
  file?: string;
  path?: string;
  name?: string;
}

export interface ParsedFusionQuery {
  original: string;
  text: string;
  filters: ScalarFilters;
  terms: string[];
  intent: FusionIntent;
  route: QueryRoute;
}

const FIELD_ALIASES = new Map<string, keyof ScalarFilters>([
  ['language', 'language'],
  ['lang', 'language'],
  ['kind', 'kind'],
  ['file', 'file'],
  ['path', 'path'],
  ['name', 'name']
]);

const SEMANTIC_RANKING_HINTS = new Set([
  'semantic',
  'similar',
  'ranking',
  'rank',
  'relevance',
  'related',
  'rerank',
  'retrieve'
]);
const COMPRESSION_FEEDBACK_HINTS = new Set([
  'compress',
  'compression',
  'compressor',
  'feedback',
  'retrieve',
  'retrieval',
  'stats',
  'hash',
  'ccr'
]);
const FRESHNESS_STATUS_HINTS = new Set([
  'fresh',
  'freshness',
  'stale',
  'pending',
  'failed',
  'manifest',
  'status',
  'sync',
  'autosync',
  'update',
  'updates',
  'vector',
  'vectors',
  'changed'
]);
const GRAPH_NAVIGATION_HINTS = new Set([
  'graph',
  'impact',
  'caller',
  'callers',
  'callee',
  'callees',
  'call',
  'calls',
  'dependency',
  'dependencies',
  'trace',
  'flow',
  'topology'
]);
const GRAPH_FIRST_HINTS = new Set([
  'caller',
  'callers',
  'callee',
  'callees',
  'impact',
  'trace',
  'topology'
]);
const FIELD_TOKEN = /^([A-Za-z][A-Za-z0-9_-]*):(.+)$/;

/**
 * Decide priority ordering when search results are mixed from multiple sources.
 * Parses scalar filters, classifies semantic intent, and picks the route.
 */
export function parseFusionQuery(query: string): ParsedFusionQuery {
  const original = query.trim();
  const filters: ScalarFilters = {};
  const textParts: string[] = [];

  for (const part of original.split(/\s+/)) {
    if (!part) {
      continue;
    }
    const match = FIELD_TOKEN.exec(part);
    if (match) {
      const [, rawKey, rawValue] = match;
      const key = rawKey ? FIELD_ALIASES.get(rawKey.toLowerCase()) : undefined;
      if (key && rawValue) {
        setFilter(filters, key, rawValue);
        continue;
      }
    }
    textParts.push(part);
  }

  const text = textParts.join(' ').trim();
  const intent = classifyIntent(text, filters);
  const route = routeParsedQuery(text, filters, intent);
  return {
    original,
    text,
    filters,
    intent,
    route,
    terms: queryTerms(text, filters)
  };
}

export function routeQuery(query: string): QueryRoute {
  return parseFusionQuery(query).route;
}

export function queryTerms(text: string, filters: ScalarFilters = {}): string[] {
  const seed = text.trim() || filters.name || filters.file || filters.path || '';
  return expandSemanticQueryTokens(seed);
}

export function isExactSymbolBundleQuery(text: string): boolean {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  return parts.length >= 2 && parts.every((part) => isLikelyExactSymbolQuery(part));
}

function isPathLikeQueryPart(part: string): boolean {
  return /[\\/]/.test(part) || /::/.test(part) || /\.[A-Za-z0-9]{1,8}\b/.test(part);
}

function isAnchorDenseBundleQuery(text: string): boolean {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    return false;
  }
  const pathPartCount = parts.filter((part) => isPathLikeQueryPart(part)).length;
  const exactSymbolCount = parts.filter((part) => isLikelyExactSymbolQuery(part)).length;
  return pathPartCount >= 2 || exactSymbolCount >= 3;
}

function setFilter(filters: ScalarFilters, key: keyof ScalarFilters, value: string): void {
  switch (key) {
    case 'language':
      filters.language = value;
      break;
    case 'kind':
      filters.kind = value;
      break;
    case 'file':
      filters.file = value;
      break;
    case 'path':
      filters.path = value;
      break;
    case 'name':
      filters.name = value;
      break;
  }
}

export function isLikelyExactSymbolQuery(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    return false;
  }
  return /[a-z0-9][A-Z]/.test(trimmed) || /^[A-Z]/.test(trimmed) || trimmed.includes('_');
}

function classifyIntent(text: string, filters: ScalarFilters): FusionIntent {
  const exactSymbol = isLikelyExactSymbolQuery(text) || (filters.name ? isLikelyExactSymbolQuery(filters.name) : false);
  if (exactSymbol) {
    return 'exact-symbol';
  }

  const terms = queryTerms(text, filters);
  if (containsHint(terms, COMPRESSION_FEEDBACK_HINTS)) {
    return 'compression-feedback';
  }
  if (containsHint(terms, FRESHNESS_STATUS_HINTS)) {
    return 'freshness/status';
  }
  if (isExactSymbolBundleQuery(text) || isAnchorDenseBundleQuery(text)) {
    return 'exact-symbol';
  }
  if (containsHint(terms, GRAPH_NAVIGATION_HINTS)) {
    return 'graph-navigation';
  }
  if (containsHint(terms, SEMANTIC_RANKING_HINTS)) {
    return 'semantic-ranking';
  }
  return 'graph-navigation';
}

function routeParsedQuery(text: string, filters: ScalarFilters, intent: FusionIntent): QueryRoute {
  if (filters.path || filters.file || (filters.name && !text)) {
    return 'graph-first-filter';
  }
  if (intent === 'exact-symbol' || isLikelyExactSymbolQuery(text)) {
    return 'graph-first';
  }
  switch (intent) {
    case 'semantic-ranking':
      return 'vector-first';
    case 'graph-navigation':
      return routeGraphNavigationQuery(text, filters);
    case 'freshness/status':
    case 'compression-feedback':
      return 'hybrid';
  }
}

function containsHint(terms: readonly string[], hints: ReadonlySet<string>): boolean {
  return terms.some((term) => hints.has(term));
}

function routeGraphNavigationQuery(text: string, filters: ScalarFilters): QueryRoute {
  const terms = queryTerms(text, filters);
  if (containsHint(terms, GRAPH_FIRST_HINTS)) {
    return 'graph-first';
  }
  if (containsHint(terms, GRAPH_NAVIGATION_HINTS)) {
    return 'hybrid';
  }
  return isPathHeavyQuery(text, filters) ? 'graph-first-filter' : 'hybrid';
}

function isPathHeavyQuery(text: string, filters: ScalarFilters): boolean {
  if (filters.path || filters.file) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  return /[\\/]/.test(trimmed) || /::/.test(trimmed) || /\.[A-Za-z0-9]{1,8}\b/.test(trimmed);
}
