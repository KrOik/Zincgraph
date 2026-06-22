import { LocalTokenEmbedding } from './local.js';
import { HTTPEmbedding } from './http.js';
import { OpenAIEmbedding } from './openai.js';
import { QwenEmbedding } from './qwen.js';
import { NetworkPolicy } from '../network-policy.js';

export type EmbeddingProvider = 'local' | 'openai' | 'qwen' | 'http';

export interface EmbeddingResult {
  sparse: Record<number, number>;
  dense: number[];
  tokens: string[];
}

export interface EmbeddingAdapter {
  readonly provider: EmbeddingProvider;
  readonly profile: string;
  embed(texts: readonly string[]): Promise<EmbeddingResult[]>;
}

export interface AdapterRegistryOptions {
  networkPolicy?: NetworkPolicy;
  dimension?: number;
}

export function getAdapter(provider: EmbeddingProvider = 'local', options: AdapterRegistryOptions = {}): EmbeddingAdapter {
  const policy = options.networkPolicy ?? NetworkPolicy.disabled();
  switch (provider) {
    case 'local':
      return new LocalTokenEmbedding(
        options.dimension === undefined ? {} : { dimension: options.dimension }
      );
    case 'openai':
      return new OpenAIEmbedding(policy);
    case 'qwen':
      return new QwenEmbedding(policy);
    case 'http':
      return new HTTPEmbedding(policy);
  }
}

export { LocalTokenEmbedding, cosineSimilarity, sparseCosineSimilarity, tokenizeCodeText } from './local.js';
export { OpenAIEmbedding } from './openai.js';
export { QwenEmbedding } from './qwen.js';
export { HTTPEmbedding } from './http.js';
export { NetworkPolicy, RemoteProviderBlockedError } from '../network-policy.js';
