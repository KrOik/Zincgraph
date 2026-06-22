import type { EmbeddingAdapter, EmbeddingResult } from './index.js';
import { NetworkPolicy } from '../network-policy.js';

export class HTTPEmbedding implements EmbeddingAdapter {
  readonly provider = 'http' as const;
  readonly profile = 'http-opt-in';

  constructor(private readonly networkPolicy = NetworkPolicy.disabled()) {}

  async embed(_texts: readonly string[]): Promise<EmbeddingResult[]> {
    this.networkPolicy.assertAllowed(this.provider);
    throw new Error('HTTPEmbedding requires an explicit endpoint configuration.');
  }
}
