import { LocalTokenEmbedding } from './local.js';
import { HTTPEmbedding, type HTTPEmbeddingOptions } from './http.js';
import { OpenAIEmbedding, type OpenAIEmbeddingOptions } from './openai.js';
import { QwenEmbedding, type QwenEmbeddingOptions } from './qwen.js';
import { SiliconFlowEmbedding, type SiliconFlowEmbeddingOptions } from './siliconflow.js';
import { NetworkPolicy } from '../network-policy.js';

export type EmbeddingProvider = 'local' | 'openai' | 'qwen' | 'http' | 'siliconflow';

export interface EmbeddingResult {
  sparse: Record<number, number>;
  dense: number[];
  tokens: string[];
}

export type EmbeddingProviderErrorKind =
  | 'auth-config'
  | 'transport-timeout'
  | 'retryable-upstream'
  | 'malformed-payload'
  | 'dimension-mismatch';

export interface EmbeddingProviderErrorDetail {
  kind: EmbeddingProviderErrorKind;
  provider: EmbeddingProvider;
  message: string;
  retryable: boolean;
  statusCode?: number;
  expectedDimension?: number;
  actualDimension?: number;
  partialResultCount?: number;
}

export interface EmbeddingBatchSuccess {
  ok: true;
  values: EmbeddingResult[];
}

export interface EmbeddingBatchFailure {
  ok: false;
  error: EmbeddingProviderErrorDetail;
  partialValues?: EmbeddingResult[];
}

export type EmbeddingBatchResult = EmbeddingBatchSuccess | EmbeddingBatchFailure;

export class EmbeddingProviderError extends Error {
  readonly detail: EmbeddingProviderErrorDetail;

  constructor(detail: EmbeddingProviderErrorDetail) {
    super(formatProviderError(detail));
    this.name = 'EmbeddingProviderError';
    this.detail = detail;
  }
}

export interface EmbeddingAdapter {
  readonly provider: EmbeddingProvider;
  readonly profile: string;
  embed(texts: readonly string[]): Promise<EmbeddingResult[]>;
  embedResult?(texts: readonly string[]): Promise<EmbeddingBatchResult>;
}

export interface AdapterRegistryOptions {
  networkPolicy?: NetworkPolicy;
  dimension?: number;
  profile?: string;
  http?: Partial<HTTPEmbeddingOptions>;
  openai?: Partial<OpenAIEmbeddingOptions>;
  qwen?: Partial<QwenEmbeddingOptions>;
  siliconflow?: Partial<SiliconFlowEmbeddingOptions>;
}

export function getAdapter(provider: EmbeddingProvider = 'local', options: AdapterRegistryOptions = {}): EmbeddingAdapter {
  const policy = options.networkPolicy ?? NetworkPolicy.disabled();
  switch (provider) {
    case 'local':
      return new LocalTokenEmbedding({
        ...(options.dimension === undefined ? {} : { dimension: options.dimension }),
        ...(options.profile === undefined ? {} : { profile: options.profile })
      });
    case 'openai':
      return new OpenAIEmbedding(policy, {
        ...options.openai,
        ...(options.profile === undefined ? {} : { profile: options.profile })
      });
    case 'qwen':
      return new QwenEmbedding(policy, {
        ...options.qwen,
        ...(options.profile === undefined ? {} : { profile: options.profile })
      });
    case 'http':
      return new HTTPEmbedding(policy, {
        ...options.http,
        ...(options.profile === undefined ? {} : { profile: options.profile })
      });
    case 'siliconflow':
      return new SiliconFlowEmbedding(policy, {
        ...options.siliconflow,
        ...(options.profile === undefined ? {} : { profile: options.profile })
      });
  }
}

export async function embedWithResult(
  adapter: EmbeddingAdapter,
  texts: readonly string[]
): Promise<EmbeddingBatchResult> {
  if (typeof adapter.embedResult === 'function') {
    return adapter.embedResult(texts);
  }
  try {
    return {
      ok: true,
      values: await adapter.embed(texts)
    };
  } catch (error) {
    return {
      ok: false,
      error: toProviderErrorDetail(adapter.provider, error)
    };
  }
}

export async function embedOrThrow(
  adapter: EmbeddingAdapter,
  texts: readonly string[]
): Promise<EmbeddingResult[]> {
  const result = await embedWithResult(adapter, texts);
  if (result.ok) {
    return result.values;
  }
  throw new EmbeddingProviderError(result.error);
}

export function toProviderErrorDetail(
  provider: EmbeddingProvider,
  error: unknown,
  overrides: Partial<Omit<EmbeddingProviderErrorDetail, 'provider'>> = {}
): EmbeddingProviderErrorDetail {
  if (error instanceof EmbeddingProviderError) {
    return {
      ...error.detail,
      ...overrides,
      provider
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const kind = overrides.kind ?? classifyProviderErrorKind(message, error);
  return {
    provider,
    kind,
    message,
    retryable: overrides.retryable ?? (kind === 'transport-timeout' || kind === 'retryable-upstream'),
    ...(overrides.statusCode === undefined ? {} : { statusCode: overrides.statusCode }),
    ...(overrides.expectedDimension === undefined ? {} : { expectedDimension: overrides.expectedDimension }),
    ...(overrides.actualDimension === undefined ? {} : { actualDimension: overrides.actualDimension }),
    ...(overrides.partialResultCount === undefined ? {} : { partialResultCount: overrides.partialResultCount })
  };
}

function formatProviderError(detail: EmbeddingProviderErrorDetail): string {
  const dimensionText = detail.expectedDimension !== undefined || detail.actualDimension !== undefined
    ? ` (expected ${detail.expectedDimension ?? '?'}, got ${detail.actualDimension ?? '?'})`
    : '';
  const partialText = detail.partialResultCount !== undefined
    ? ` (partial results: ${detail.partialResultCount})`
    : '';
  const statusText = detail.statusCode !== undefined ? ` [status ${detail.statusCode}]` : '';
  return `${detail.provider} embedding ${detail.kind}${statusText}: ${detail.message}${dimensionText}${partialText}`;
}

function classifyProviderErrorKind(message: string, error: unknown): EmbeddingProviderErrorKind {
  const lowered = message.toLowerCase();
  if (
    lowered.includes('api key') ||
    lowered.includes('endpoint') ||
    lowered.includes('configuration') ||
    lowered.includes('config') ||
    lowered.includes('network policy') ||
    lowered.includes('not allowed')
  ) {
    return 'auth-config';
  }
  if (
    lowered.includes('timeout') ||
    lowered.includes('timed out') ||
    lowered.includes('abort') ||
    (error instanceof Error && error.name === 'AbortError')
  ) {
    return 'transport-timeout';
  }
  if (
    /\b429\b/.test(lowered) ||
    /\b5\d\d\b/.test(lowered) ||
    lowered.includes('rate limit') ||
    lowered.includes('temporar') ||
    lowered.includes('upstream') ||
    lowered.includes('fetch failed') ||
    lowered.includes('econnreset') ||
    lowered.includes('socket hang up')
  ) {
    return 'retryable-upstream';
  }
  if (lowered.includes('dimension')) {
    return 'dimension-mismatch';
  }
  return 'malformed-payload';
}
