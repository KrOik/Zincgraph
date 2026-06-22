import type { EmbeddingAdapter, EmbeddingResult } from './index.js';
import { NetworkPolicy } from '../network-policy.js';

export class OpenAIEmbedding implements EmbeddingAdapter {
  readonly provider = 'openai' as const;
  readonly profile = 'openai-opt-in';

  constructor(private readonly networkPolicy = NetworkPolicy.disabled()) {}

  async embed(_texts: readonly string[]): Promise<EmbeddingResult[]> {
    this.networkPolicy.assertAllowed(this.provider);
    throw new Error('OpenAIEmbedding requires an explicit API client configuration.');
  }
}
