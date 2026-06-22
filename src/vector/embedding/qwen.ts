import type { EmbeddingAdapter, EmbeddingResult } from './index.js';
import { NetworkPolicy } from '../network-policy.js';

export class QwenEmbedding implements EmbeddingAdapter {
  readonly provider = 'qwen' as const;
  readonly profile = 'qwen-opt-in';

  constructor(private readonly networkPolicy = NetworkPolicy.disabled()) {}

  async embed(_texts: readonly string[]): Promise<EmbeddingResult[]> {
    this.networkPolicy.assertAllowed(this.provider);
    throw new Error('QwenEmbedding requires an explicit DashScope client configuration.');
  }
}
