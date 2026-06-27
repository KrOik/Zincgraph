import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { DEFAULT_CHUNKER_VERSION } from '../chunker.js';
import { FusionStore, fusionStorePath } from '../../freshness/fusion-store.js';
import { NetworkPolicy } from '../network-policy.js';
import { zincgraphDataDir } from '../zvec-adapter.js';
import { getAdapter, type AdapterRegistryOptions, type EmbeddingAdapter, type EmbeddingProvider } from './registry.js';
import type { SiliconFlowEmbeddingOptions } from './siliconflow.js';

export interface ActiveEmbeddingConfigInput {
  provider?: EmbeddingProvider;
  embeddingProfile?: string;
  chunkerVersion?: string;
  dimension?: number;
  allowNetwork?: boolean;
  networkPolicy?: NetworkPolicy;
  http?: AdapterRegistryOptions['http'];
  openai?: AdapterRegistryOptions['openai'];
  qwen?: AdapterRegistryOptions['qwen'];
  siliconflow?: Partial<SiliconFlowEmbeddingOptions>;
}

export interface ResolvedEmbeddingConfig {
  provider: EmbeddingProvider;
  profile: string;
  chunkerVersion: string;
  networkPolicy: NetworkPolicy;
  adapter: EmbeddingAdapter;
  metadataEntries: Record<string, string>;
}

interface EmbeddingMetadata {
  provider?: string | null;
  profile?: string | null;
  chunkerVersion?: string | null;
  dimension?: string | null;
  network?: string | null;
  httpEndpoint?: string | null;
  httpModel?: string | null;
  httpHeaders?: string | null;
  openaiModel?: string | null;
  openaiBaseUrl?: string | null;
  qwenModel?: string | null;
  qwenBaseUrl?: string | null;
  siliconflowModel?: string | null;
  siliconflowBaseUrl?: string | null;
}

type EmbeddingMetadataEntry = (typeof METADATA_KEYS)[keyof typeof METADATA_KEYS];
type EmbeddingMetadataEntries = Partial<Record<EmbeddingMetadataEntry, string>>;
interface EmbeddingMetadataCachePayload {
  entries: Record<string, string>;
  dbMtimeMs?: number;
}

const METADATA_KEYS = {
  provider: 'embedding.provider',
  profile: 'embedding.profile',
  chunkerVersion: 'embedding.chunkerVersion',
  dimension: 'embedding.dimension',
  network: 'embedding.network',
  httpEndpoint: 'embedding.http.endpoint',
  httpModel: 'embedding.http.model',
  httpHeaders: 'embedding.http.headers',
  openaiModel: 'embedding.openai.model',
  openaiBaseUrl: 'embedding.openai.baseUrl',
  qwenModel: 'embedding.qwen.model',
  qwenBaseUrl: 'embedding.qwen.baseUrl',
  siliconflowModel: 'embedding.siliconflow.model',
  siliconflowBaseUrl: 'embedding.siliconflow.baseUrl'
} as const;
const EMBEDDING_METADATA_CACHE_FILE = 'embedding-metadata.json';
const LOADED_ENV_PROJECTS = new Set<string>();

export function resolveActiveEmbedding(
  projectPath = process.cwd(),
  input: ActiveEmbeddingConfigInput = {}
): ResolvedEmbeddingConfig {
  loadProjectEnvFile(projectPath);
  const metadata = readEmbeddingMetadata(projectPath);
  const provider = coerceProvider(
    input.provider,
    envValue('ZINCGRAPH_EMBEDDING_PROVIDER'),
    metadata.provider,
    'local'
  );
  const explicitProfile = firstString(
    input.embeddingProfile,
    envValue('ZINCGRAPH_EMBEDDING_PROFILE'),
    metadata.profile
  );
  const chunkerVersion = firstString(
    input.chunkerVersion,
    envValue('ZINCGRAPH_CHUNKER_VERSION'),
    metadata.chunkerVersion,
    DEFAULT_CHUNKER_VERSION
  )!;
  const dimension = firstNumber(
    input.dimension,
    envNumber('ZINCGRAPH_EMBEDDING_DIMENSION'),
    parseNumber(metadata.dimension)
  );
  const networkEnabled = parseBoolean(
    input.allowNetwork,
    envBoolean('ZINCGRAPH_EMBEDDING_ENABLE_NETWORK'),
    parseBooleanText(metadata.network)
  );
  const networkPolicy = input.networkPolicy ?? (
    networkEnabled
      ? NetworkPolicy.enabledFor([provider])
      : NetworkPolicy.disabled()
  );
  const headers = parseHeaders(
    input.http?.headers,
    parseHeadersText(envValue('ZINCGRAPH_EMBEDDING_HTTP_HEADERS')),
    parseHeadersText(metadata.httpHeaders)
  );
  const httpEndpoint = firstString(
    input.http?.endpoint,
    envValue('ZINCGRAPH_EMBEDDING_HTTP_ENDPOINT'),
    metadata.httpEndpoint
  );
  const httpModel = firstString(
    input.http?.model,
    envValue('ZINCGRAPH_EMBEDDING_HTTP_MODEL'),
    metadata.httpModel
  );
  const openaiModel = firstString(
    input.openai?.model,
    envValue('ZINCGRAPH_OPENAI_EMBEDDING_MODEL'),
    metadata.openaiModel
  );
  const openaiBaseUrl = firstString(
    input.openai?.baseUrl,
    envValue('ZINCGRAPH_OPENAI_BASE_URL'),
    metadata.openaiBaseUrl
  );
  const openaiApiKey = firstString(input.openai?.apiKey, envValue('ZINCGRAPH_OPENAI_API_KEY'));
  const qwenModel = firstString(
    input.qwen?.model,
    envValue('ZINCGRAPH_QWEN_EMBEDDING_MODEL'),
    metadata.qwenModel
  );
  const qwenBaseUrl = firstString(
    input.qwen?.baseUrl,
    envValue('ZINCGRAPH_QWEN_BASE_URL'),
    metadata.qwenBaseUrl
  );
  const qwenApiKey = firstString(input.qwen?.apiKey, envValue('ZINCGRAPH_QWEN_API_KEY'));
  const siliconflowModel = firstString(
    input.siliconflow?.model,
    envValue('ZINCGRAPH_SILICONFLOW_MODEL'),
    metadata.siliconflowModel
  );
  const siliconflowBaseUrl = firstString(
    input.siliconflow?.baseUrl,
    envValue('ZINCGRAPH_SILICONFLOW_BASE_URL'),
    metadata.siliconflowBaseUrl
  );
  const siliconflowApiKey = firstString(
    input.siliconflow?.apiKey,
    envValue('ZINCGRAPH_SILICONFLOW_API_KEY'),
    envValue('SILICONFLOW_API_KEY'),
    envValue('silicon')
  );
  const adapter = getAdapter(provider, {
    networkPolicy,
    ...(dimension === undefined ? {} : { dimension }),
    ...(explicitProfile === undefined ? {} : { profile: explicitProfile }),
    http: {
      ...input.http,
      ...(httpEndpoint === undefined ? {} : { endpoint: httpEndpoint }),
      ...(httpModel === undefined ? {} : { model: httpModel }),
      ...(headers ? { headers } : {})
    },
    openai: {
      ...input.openai,
      ...(openaiModel === undefined ? {} : { model: openaiModel }),
      ...(openaiBaseUrl === undefined ? {} : { baseUrl: openaiBaseUrl }),
      ...(openaiApiKey === undefined ? {} : { apiKey: openaiApiKey })
    },
    qwen: {
      ...input.qwen,
      ...(qwenModel === undefined ? {} : { model: qwenModel }),
      ...(qwenBaseUrl === undefined ? {} : { baseUrl: qwenBaseUrl }),
      ...(qwenApiKey === undefined ? {} : { apiKey: qwenApiKey })
    },
    siliconflow: {
      ...input.siliconflow,
      ...(siliconflowModel === undefined ? {} : { model: siliconflowModel }),
      ...(siliconflowBaseUrl === undefined ? {} : { baseUrl: siliconflowBaseUrl }),
      ...(siliconflowApiKey === undefined ? {} : { apiKey: siliconflowApiKey })
    }
  });
  const metadataEntries = filterMetadataEntries({
    [METADATA_KEYS.provider]: provider,
    [METADATA_KEYS.profile]: explicitProfile ?? adapter.profile,
    [METADATA_KEYS.chunkerVersion]: chunkerVersion,
    ...(dimension === undefined ? {} : { [METADATA_KEYS.dimension]: String(dimension) }),
    [METADATA_KEYS.network]: networkEnabled ? 'enabled' : 'disabled',
    ...(httpEndpoint === undefined ? {} : { [METADATA_KEYS.httpEndpoint]: httpEndpoint }),
    ...(httpModel === undefined ? {} : { [METADATA_KEYS.httpModel]: httpModel }),
    ...(headers ? { [METADATA_KEYS.httpHeaders]: JSON.stringify(headers) } : {}),
    ...(openaiModel === undefined ? {} : { [METADATA_KEYS.openaiModel]: openaiModel }),
    ...(openaiBaseUrl === undefined ? {} : { [METADATA_KEYS.openaiBaseUrl]: openaiBaseUrl }),
    ...(qwenModel === undefined ? {} : { [METADATA_KEYS.qwenModel]: qwenModel }),
    ...(qwenBaseUrl === undefined ? {} : { [METADATA_KEYS.qwenBaseUrl]: qwenBaseUrl }),
    ...(siliconflowModel === undefined ? {} : { [METADATA_KEYS.siliconflowModel]: siliconflowModel }),
    ...(siliconflowBaseUrl === undefined ? {} : { [METADATA_KEYS.siliconflowBaseUrl]: siliconflowBaseUrl })
  });
  return {
    provider,
    profile: explicitProfile ?? adapter.profile,
    chunkerVersion,
    networkPolicy,
    adapter,
    metadataEntries
  };
}

function loadProjectEnvFile(projectPath: string): void {
  const projectRoot = resolve(projectPath);
  if (LOADED_ENV_PROJECTS.has(projectRoot)) {
    return;
  }
  LOADED_ENV_PROJECTS.add(projectRoot);
  const envPath = join(projectRoot, '.env');
  if (!existsSync(envPath) || typeof process.loadEnvFile !== 'function') {
    return;
  }
  try {
    process.loadEnvFile(envPath);
  } catch {
    // Fall back to existing process.env values when the local env file is invalid.
  }
}

function readEmbeddingMetadata(projectPath: string): EmbeddingMetadata {
  const projectRoot = resolve(projectPath);
  const cachePayload = readEmbeddingMetadataCache(projectRoot);
  if (cachePayload && embeddingMetadataCacheIsFresh(projectRoot, cachePayload)) {
    return metadataFromEntries(cachePayload.entries);
  }
  if (existsSync(fusionStorePath(projectRoot))) {
    const store = new FusionStore(projectRoot);
    try {
      const metadata = filterMetadataEntries(
        store.getMetadataEntries(Object.values(METADATA_KEYS)) as EmbeddingMetadataEntries
      );
      if (Object.keys(metadata).length > 0) {
        updateEmbeddingMetadataCache(projectRoot, metadata, { trustedDbMirror: true });
        return metadataFromEntries(metadata);
      }
    } finally {
      store.close();
    }
  }
  return metadataFromEntries(cachePayload?.entries ?? {});
}

export function cacheResolvedEmbedding(
  projectPath: string,
  resolved: Pick<ResolvedEmbeddingConfig, 'provider' | 'profile' | 'chunkerVersion'> & { metadataEntries?: Readonly<Record<string, string>> }
): void {
  const entries = filterMetadataEntries({
    [METADATA_KEYS.provider]: resolved.provider,
    [METADATA_KEYS.profile]: resolved.profile,
    [METADATA_KEYS.chunkerVersion]: resolved.chunkerVersion,
    ...(resolved.metadataEntries ?? {})
  });
  const store = new FusionStore(projectPath);
  try {
    store.setMetadataEntries(entries);
  } finally {
    store.close();
  }
  updateEmbeddingMetadataCache(projectPath, entries, { trustedDbMirror: true });
}

export function updateEmbeddingMetadataCache(
  projectPath: string,
  entries: Partial<Record<string, string | undefined | null>>,
  options: { trustedDbMirror?: boolean } = {}
): void {
  const cachePath = embeddingMetadataCachePath(projectPath);
  const currentCache = readEmbeddingMetadataCache(projectPath);
  const nextEntries: Record<string, string> = {
    ...(currentCache?.entries ?? {})
  };
  let changed = false;
  for (const [key, value] of Object.entries(entries)) {
    if (!Object.values(METADATA_KEYS).includes(key as EmbeddingMetadataEntry)) {
      continue;
    }
    const normalized = typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
    if (normalized === undefined) {
      if (key in nextEntries) {
        delete nextEntries[key];
        changed = true;
      }
      continue;
    }
    if (nextEntries[key] !== normalized) {
      nextEntries[key] = normalized;
      changed = true;
    }
  }
  if (!changed && existsSync(cachePath)) {
    return;
  }
  mkdirSync(zincgraphDataDir(resolve(projectPath)), { recursive: true });
  const trustedDbMtimeMs = options.trustedDbMirror
    ? (readFusionStoreMtime(projectPath) ?? currentCache?.dbMtimeMs)
    : undefined;
  const payload: EmbeddingMetadataCachePayload = {
    entries: nextEntries,
    ...(trustedDbMtimeMs === undefined ? {} : { dbMtimeMs: trustedDbMtimeMs })
  };
  writeFileSync(cachePath, JSON.stringify(payload, null, 2));
}

function embeddingMetadataCachePath(projectPath: string): string {
  return join(zincgraphDataDir(resolve(projectPath)), EMBEDDING_METADATA_CACHE_FILE);
}

function embeddingMetadataCacheIsFresh(projectPath: string, cachePayload: EmbeddingMetadataCachePayload): boolean {
  const dbPath = fusionStorePath(projectPath);
  if (!existsSync(dbPath)) {
    return true;
  }
  if (typeof cachePayload.dbMtimeMs !== 'number') {
    return false;
  }
  const dbMtimeMs = readFusionStoreMtime(projectPath);
  return dbMtimeMs !== null && cachePayload.dbMtimeMs >= dbMtimeMs;
}

function readEmbeddingMetadataCache(projectPath: string): EmbeddingMetadataCachePayload | null {
  const cachePath = embeddingMetadataCachePath(projectPath);
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
      const entries = normalizeEmbeddingMetadataEntries(payload.entries);
      if (entries === null) {
        return null;
      }
      return {
        entries,
        ...(typeof payload.dbMtimeMs === 'number' ? { dbMtimeMs: payload.dbMtimeMs } : {})
      };
    }
    const entries = normalizeEmbeddingMetadataEntries(parsed);
    return entries ? { entries } : null;
  } catch {
    return null;
  }
}

function normalizeEmbeddingMetadataEntries(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0)
  );
}

function readFusionStoreMtime(projectPath: string): number | null {
  const dbPath = fusionStorePath(projectPath);
  if (!existsSync(dbPath)) {
    return null;
  }
  try {
    return statSync(dbPath).mtimeMs;
  } catch {
    return null;
  }
}

function metadataFromEntries(entries: EmbeddingMetadataEntries): EmbeddingMetadata {
  return {
    provider: entries[METADATA_KEYS.provider] ?? null,
    profile: entries[METADATA_KEYS.profile] ?? null,
    chunkerVersion: entries[METADATA_KEYS.chunkerVersion] ?? null,
    dimension: entries[METADATA_KEYS.dimension] ?? null,
    network: entries[METADATA_KEYS.network] ?? null,
    httpEndpoint: entries[METADATA_KEYS.httpEndpoint] ?? null,
    httpModel: entries[METADATA_KEYS.httpModel] ?? null,
    httpHeaders: entries[METADATA_KEYS.httpHeaders] ?? null,
    openaiModel: entries[METADATA_KEYS.openaiModel] ?? null,
    openaiBaseUrl: entries[METADATA_KEYS.openaiBaseUrl] ?? null,
    qwenModel: entries[METADATA_KEYS.qwenModel] ?? null,
    qwenBaseUrl: entries[METADATA_KEYS.qwenBaseUrl] ?? null,
    siliconflowModel: entries[METADATA_KEYS.siliconflowModel] ?? null,
    siliconflowBaseUrl: entries[METADATA_KEYS.siliconflowBaseUrl] ?? null
  };
}

function filterMetadataEntries(entries: Partial<Record<string, string | undefined | null>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(entries).filter((entry): entry is [string, string] =>
      Object.values(METADATA_KEYS).includes(entry[0] as EmbeddingMetadataEntry) &&
      typeof entry[1] === 'string' &&
      entry[1].trim().length > 0
    )
  );
}

function coerceProvider(...values: Array<string | undefined | null>): EmbeddingProvider {
  for (const value of values) {
    if (value === 'local' || value === 'http' || value === 'openai' || value === 'qwen' || value === 'siliconflow') {
      return value;
    }
  }
  return 'local';
}

function firstString(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function firstNumber(...values: Array<number | undefined | null>): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function envValue(key: string): string | undefined {
  const value = process.env[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function envNumber(key: string): number | undefined {
  return parseNumber(envValue(key));
}

function parseNumber(value: string | number | undefined | null): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function envBoolean(key: string): boolean | undefined {
  return parseBooleanText(envValue(key));
}

function parseBoolean(...values: Array<boolean | undefined>): boolean {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return false;
}

function parseBooleanText(value: string | undefined | null): boolean | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'enabled', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'disabled', 'off'].includes(normalized)) {
    return false;
  }
  return undefined;
}

function parseHeaders(
  ...values: Array<Record<string, string> | undefined>
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  let hasValue = false;
  for (const value of values) {
    if (!value) {
      continue;
    }
    hasValue = true;
    for (const [key, headerValue] of Object.entries(value)) {
      merged[key] = headerValue;
    }
  }
  return hasValue ? merged : undefined;
}

function parseHeadersText(value: string | undefined | null): Record<string, string> | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const headers: Record<string, string> = {};
    for (const [key, headerValue] of Object.entries(parsed)) {
      if (typeof headerValue === 'string' && headerValue.trim().length > 0) {
        headers[key] = headerValue;
      }
    }
    return Object.keys(headers).length > 0 ? headers : undefined;
  } catch {
    return undefined;
  }
}
