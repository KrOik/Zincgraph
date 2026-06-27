import { HTTPEmbedding } from './http.js';
import type { EmbeddingAdapter, EmbeddingBatchResult, EmbeddingResult } from './registry.js';
import { NetworkPolicy } from '../network-policy.js';

export interface SiliconFlowEmbeddingOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  profile?: string;
}

const DEFAULT_SILICONFLOW_MODEL = 'BAAI/bge-m3';
const DEFAULT_SILICONFLOW_ENDPOINT = 'https://api.siliconflow.cn/v1/embeddings';

export class SiliconFlowEmbedding implements EmbeddingAdapter {
  readonly provider = 'siliconflow' as const;
  readonly profile: string;
  private readonly apiKey: string | undefined;
  private readonly delegate: HTTPEmbedding;

  constructor(
    private readonly networkPolicy = NetworkPolicy.disabled(),
    options: SiliconFlowEmbeddingOptions = {}
  ) {
    this.apiKey = options.apiKey
      ?? process.env.ZINCGRAPH_SILICONFLOW_API_KEY
      ?? process.env.SILICONFLOW_API_KEY
      ?? process.env.silicon;
    const model = options.model ?? DEFAULT_SILICONFLOW_MODEL;
    this.profile = options.profile ?? `siliconflow:${model}`;
    this.delegate = new HTTPEmbedding(networkPolicy, {
      endpoint: options.baseUrl ?? DEFAULT_SILICONFLOW_ENDPOINT,
      model,
      profile: this.profile,
      provider: this.provider,
      headers: {
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {})
      }
    });
  }

  async embed(texts: readonly string[]): Promise<EmbeddingResult[]> {
    this.networkPolicy.assertAllowed(this.provider);
    if (!this.apiKey) {
      throw new Error(
        'SiliconFlowEmbedding requires an API key via options.apiKey, ZINCGRAPH_SILICONFLOW_API_KEY, SILICONFLOW_API_KEY, or silicon.'
      );
    }
    if (!this.profile.startsWith(`${this.provider}:`)) {
      throw new Error(`SiliconFlowEmbedding profile must start with ${this.provider}:. Received ${this.profile}.`);
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
          message: 'SiliconFlowEmbedding requires an API key via options.apiKey, ZINCGRAPH_SILICONFLOW_API_KEY, SILICONFLOW_API_KEY, or silicon.',
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
          message: `SiliconFlowEmbedding profile must start with ${this.provider}:. Received ${this.profile}.`,
          retryable: false
        }
      };
    }
    return this.delegate.embedResult(texts);
  }
}
