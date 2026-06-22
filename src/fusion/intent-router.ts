import { tokenizeCodeText } from '../vector/embedding/local.js';

export type QueryRoute = 'graph-first' | 'graph-first-filter' | 'vector-first' | 'hybrid';

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

const SEMANTIC_HINTS = new Set(['similar', 'like', 'related']);
const FIELD_TOKEN = /^([A-Za-z][A-Za-z0-9_-]*):(.+)$/;

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
  const route = routeParsedQuery(text, filters);
  return {
    original,
    text,
    filters,
    route,
    terms: queryTerms(text, filters)
  };
}

export function routeQuery(query: string): QueryRoute {
  return parseFusionQuery(query).route;
}

export function queryTerms(text: string, filters: ScalarFilters = {}): string[] {
  const seed = text.trim() || filters.name || filters.file || filters.path || '';
  return tokenizeCodeText(seed);
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

function routeParsedQuery(text: string, filters: ScalarFilters): QueryRoute {
  if (filters.path || filters.file) {
    return 'graph-first-filter';
  }
  const terms = tokenizeCodeText(text);
  if (terms.some((term) => SEMANTIC_HINTS.has(term))) {
    return 'vector-first';
  }
  if (isLikelyExactSymbol(text)) {
    return 'graph-first';
  }
  if (filters.name && !text) {
    return 'graph-first-filter';
  }
  return 'hybrid';
}

function isLikelyExactSymbol(text: string): boolean {
  const trimmed = text.trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    return false;
  }
  return /[a-z0-9][A-Z]/.test(trimmed) || /^[A-Z]/.test(trimmed) || trimmed.includes('_');
}
