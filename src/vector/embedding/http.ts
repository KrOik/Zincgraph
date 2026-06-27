import { sparseVectorFromTokens, tokenizeCodeText } from './local.js';
import type {
  EmbeddingAdapter,
  EmbeddingBatchFailure,
  EmbeddingBatchResult,
  EmbeddingProvider,
  EmbeddingProviderErrorDetail,
  EmbeddingResult
} from './registry.js';
import { NetworkPolicy } from '../network-policy.js';

export interface HTTPEmbeddingOptions {
  endpoint?: string;
  headers?: Record<string, string>;
  model?: string;
  profile?: string;
  provider?: EmbeddingProvider;
  expectedDimension?: number;
  maxRetries?: number;
}

export class HTTPEmbedding implements EmbeddingAdapter {
  readonly provider: EmbeddingProvider;
  readonly profile: string;
  private readonly maxRetries: number;

  constructor(
    private readonly networkPolicy = NetworkPolicy.disabled(),
    private readonly options: HTTPEmbeddingOptions = {}
  ) {
    this.provider = options.provider ?? 'http';
    this.profile = options.profile ?? remoteEmbeddingProfile(this.provider, options.endpoint, options.model);
    this.maxRetries = Math.max(0, options.maxRetries ?? 1);
  }

  async embed(texts: readonly string[]): Promise<EmbeddingResult[]> {
    this.networkPolicy.assertAllowed(this.provider);
    const result = await this.embedResult(texts);
    if (result.ok) {
      return result.values;
    }
    throw new Error(formatProviderFailure(result.error));
  }

  async embedResult(texts: readonly string[]): Promise<EmbeddingBatchResult> {
    try {
      this.networkPolicy.assertAllowed(this.provider);
    } catch (error) {
      return failure(this.provider, error instanceof Error ? error.message : String(error), 'auth-config');
    }
    if (!this.options.endpoint) {
      return failure(this.provider, 'HTTPEmbedding requires an explicit endpoint configuration.', 'auth-config');
    }

    let lastFailure: EmbeddingBatchFailure | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await fetch(this.options.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.options.headers ?? {})
          },
          body: JSON.stringify({
            input: [...texts],
            ...(this.options.model ? { model: this.options.model } : {})
          })
        });
        if (!response.ok) {
          const body = await response.text();
          const detail = httpStatusFailure(this.provider, response.status, response.statusText, body);
          lastFailure = { ok: false, error: detail };
          if (detail.retryable && attempt < this.maxRetries) {
            continue;
          }
          return lastFailure;
        }

        const payload = await response.json() as unknown;
        const embeddings = extractEmbeddings(payload);
        const validated = validateEmbeddings(this.provider, texts, embeddings, this.options.expectedDimension);
        if (!validated.ok) {
          return validated;
        }
        return {
          ok: true,
          values: validated.vectors.map((dense, index) => {
            const text = texts[index] ?? '';
            const tokens = tokenizeCodeText(text);
            return {
              dense,
              tokens,
              sparse: sparseVectorFromTokens(tokens)
            };
          })
        };
      } catch (error) {
        const detail = requestFailure(this.provider, error);
        lastFailure = { ok: false, error: detail };
        if (detail.retryable && attempt < this.maxRetries) {
          continue;
        }
        return lastFailure;
      }
    }

    return lastFailure ?? failure(this.provider, 'embedding request failed', 'retryable-upstream');
  }
}

export function remoteEmbeddingProfile(provider: EmbeddingProvider, endpoint?: string, model?: string): string {
  const target = sanitizeProfileSegment(model ?? endpoint ?? 'default');
  return `${provider}:${target}`;
}

function sanitizeProfileSegment(value: string): string {
  return value.replace(/^https?:\/\//i, '').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'default';
}

function extractEmbeddings(payload: unknown): number[][] {
  if (Array.isArray(payload)) {
    return payload.map(normalizeDenseVector);
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('embedding response must be an object or array');
  }
  const response = payload as {
    embedding?: unknown;
    embeddings?: unknown;
    data?: Array<{ embedding?: unknown }>;
    output?: { embeddings?: unknown };
  };
  if (Array.isArray(response.embeddings)) {
    return response.embeddings.map(normalizeDenseVector);
  }
  if (Array.isArray(response.data)) {
    return response.data.map((item) => normalizeDenseVector(item.embedding));
  }
  if (Array.isArray(response.output?.embeddings)) {
    return response.output.embeddings.map(normalizeDenseVector);
  }
  if (Array.isArray(response.embedding)) {
    return [normalizeDenseVector(response.embedding)];
  }
  throw new Error('embedding response does not contain embeddings');
}

function normalizeDenseVector(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw new Error('embedding payload must be an array');
  }
  return value.map((item) => {
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      throw new Error('embedding payload must contain only finite numbers');
    }
    return item;
  });
}

function validateEmbeddings(
  provider: EmbeddingProvider,
  texts: readonly string[],
  embeddings: readonly number[][],
  expectedDimension: number | undefined
): EmbeddingBatchFailure | { ok: true; vectors: number[][] } {
  if (embeddings.length !== texts.length) {
    return failure(
      provider,
      `embedding payload count mismatch: expected ${texts.length}, received ${embeddings.length}`,
      'malformed-payload',
      { partialResultCount: embeddings.length }
    );
  }

  const firstDimension = embeddings[0]?.length;
  if (!firstDimension || firstDimension <= 0) {
    return failure(provider, 'embedding payload contained an empty vector', 'malformed-payload');
  }
  if (expectedDimension !== undefined && firstDimension !== expectedDimension) {
    return failure(provider, 'embedding payload dimension mismatch', 'dimension-mismatch', {
      expectedDimension,
      actualDimension: firstDimension
    });
  }
  for (const embedding of embeddings) {
    if (embedding.length === 0) {
      return failure(provider, 'embedding payload contained an empty vector', 'malformed-payload');
    }
    if (embedding.length !== firstDimension) {
      return failure(provider, 'embedding payload dimension mismatch', 'dimension-mismatch', {
        expectedDimension: firstDimension,
        actualDimension: embedding.length
      });
    }
  }
  return {
    ok: true,
    vectors: embeddings.map((embedding) => [...embedding])
  };
}

function httpStatusFailure(
  provider: EmbeddingProvider,
  statusCode: number,
  statusText: string,
  body: string
): EmbeddingProviderErrorDetail {
  const trimmedBody = body.trim();
  if (statusCode === 401 || statusCode === 403) {
    return {
      provider,
      kind: 'auth-config',
      message: `authentication failed: ${statusText}${trimmedBody ? ` ${trimmedBody}` : ''}`,
      retryable: false,
      statusCode
    };
  }
  if (statusCode === 408 || statusCode === 429 || statusCode >= 500) {
    return {
      provider,
      kind: 'retryable-upstream',
      message: `upstream retryable error: ${statusText}${trimmedBody ? ` ${trimmedBody}` : ''}`,
      retryable: true,
      statusCode
    };
  }
  return {
    provider,
    kind: 'malformed-payload',
    message: `upstream returned ${statusCode} ${statusText}${trimmedBody ? ` ${trimmedBody}` : ''}`,
    retryable: false,
    statusCode
  };
}

function requestFailure(provider: EmbeddingProvider, error: unknown): EmbeddingProviderErrorDetail {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  if (lowered.includes('timeout') || lowered.includes('timed out') || (error instanceof Error && error.name === 'AbortError')) {
    return {
      provider,
      kind: 'transport-timeout',
      message,
      retryable: true
    };
  }
  if (
    lowered.includes('fetch failed') ||
    lowered.includes('socket hang up') ||
    lowered.includes('econnreset') ||
    lowered.includes('temporar')
  ) {
    return {
      provider,
      kind: 'retryable-upstream',
      message,
      retryable: true
    };
  }
  return {
    provider,
    kind: 'malformed-payload',
    message,
    retryable: false
  };
}

function failure(
  provider: EmbeddingProvider,
  message: string,
  kind: EmbeddingProviderErrorDetail['kind'],
  extra: Partial<Omit<EmbeddingProviderErrorDetail, 'provider' | 'kind' | 'message' | 'retryable'>> = {}
): EmbeddingBatchFailure {
  return {
    ok: false,
    error: {
      provider,
      kind,
      message,
      retryable: kind === 'transport-timeout' || kind === 'retryable-upstream',
      ...(extra.statusCode === undefined ? {} : { statusCode: extra.statusCode }),
      ...(extra.expectedDimension === undefined ? {} : { expectedDimension: extra.expectedDimension }),
      ...(extra.actualDimension === undefined ? {} : { actualDimension: extra.actualDimension }),
      ...(extra.partialResultCount === undefined ? {} : { partialResultCount: extra.partialResultCount })
    }
  };
}

function formatProviderFailure(detail: EmbeddingProviderErrorDetail): string {
  const status = detail.statusCode !== undefined ? ` [status ${detail.statusCode}]` : '';
  const dimension = detail.expectedDimension !== undefined || detail.actualDimension !== undefined
    ? ` (expected ${detail.expectedDimension ?? '?'}, got ${detail.actualDimension ?? '?'})`
    : '';
  return `${detail.provider} embedding ${detail.kind}${status}: ${detail.message}${dimension}`;
}
