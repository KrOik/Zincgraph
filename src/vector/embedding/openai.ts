import { HTTPEmbedding } from './http.js';
import type { EmbeddingAdapter, EmbeddingBatchResult, EmbeddingResult } from './registry.js';
import { NetworkPolicy } from '../network-policy.js';

export interface OpenAIEmbeddingOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  organization?: string;
  profile?: string;
}

export class OpenAIEmbedding implements EmbeddingAdapter {
  readonly provider = 'openai' as const;
  readonly profile: string;
  private readonly apiKey: string | undefined;
  private readonly delegate: HTTPEmbedding;

  constructor(
    private readonly networkPolicy = NetworkPolicy.disabled(),
    options: OpenAIEmbeddingOptions = {}
  ) {
    this.apiKey = options.apiKey ?? process.env.ZINCGRAPH_OPENAI_API_KEY;
    const model = options.model ?? 'text-embedding-3-small';
    this.profile = options.profile ?? `openai:${model}`;
    this.delegate = new HTTPEmbedding(networkPolicy, {
      endpoint: options.baseUrl ?? 'https://api.openai.com/v1/embeddings',
      model,
      profile: this.profile,
      provider: this.provider,
      headers: {
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        ...(options.organization ? { 'OpenAI-Organization': options.organization } : {})
      }
    });
  }

  async embed(texts: readonly string[]): Promise<EmbeddingResult[]> {
    this.networkPolicy.assertAllowed(this.provider);
    if (!this.apiKey) {
      throw new Error('OpenAIEmbedding requires an API key via options.apiKey or ZINCGRAPH_OPENAI_API_KEY.');
    }
    if (!this.profile.startsWith(`${this.provider}:`)) {
      throw new Error(`OpenAIEmbedding profile must start with ${this.provider}:. Received ${this.profile}.`);
    }
    return this.delegate.embed(texts);
  }

  async embedResult(texts: readonly string[]): Promise<EmbeddingBatchResult> {
    if (!this.apiKey) {
      return {
        ok: false,
        error: {
          provider: this.provider,
          kind: 'auth-config',
          message: 'OpenAIEmbedding requires an API key via options.apiKey or ZINCGRAPH_OPENAI_API_KEY.',
          retryable: false
        }
      };
    }
    if (!this.profile.startsWith(`${this.provider}:`)) {
      return {
        ok: false,
        error: {
          provider: this.provider,
          kind: 'auth-config',
          message: `OpenAIEmbedding profile must start with ${this.provider}:. Received ${this.profile}.`,
          retryable: false
        }
      };
    }
    return this.delegate.embedResult(texts);
  }
}
