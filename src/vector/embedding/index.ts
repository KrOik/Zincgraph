export { getAdapter } from './registry.js';
export { EmbeddingProviderError, embedOrThrow, embedWithResult, toProviderErrorDetail } from './registry.js';
export type {
  AdapterRegistryOptions,
  EmbeddingAdapter,
  EmbeddingBatchFailure,
  EmbeddingBatchResult,
  EmbeddingBatchSuccess,
  EmbeddingProviderErrorDetail,
  EmbeddingProviderErrorKind,
  EmbeddingProvider,
  EmbeddingResult
} from './registry.js';
export { resolveActiveEmbedding } from './config.js';
export { cacheResolvedEmbedding, updateEmbeddingMetadataCache } from './config.js';
export type { ActiveEmbeddingConfigInput, ResolvedEmbeddingConfig } from './config.js';
export {
  DEFAULT_LOCAL_EMBEDDING_DIMENSION,
  expandSemanticQueryText,
  expandSemanticQueryTokens,
  LocalTokenEmbedding,
  cosineSimilarity,
  defaultLocalEmbeddingProfile,
  sparseCosineSimilarity,
  tokenizeCodeText
} from './local.js';
export { OpenAIEmbedding } from './openai.js';
export type { OpenAIEmbeddingOptions } from './openai.js';
export { QwenEmbedding } from './qwen.js';
export type { QwenEmbeddingOptions } from './qwen.js';
export { HTTPEmbedding } from './http.js';
export type { HTTPEmbeddingOptions } from './http.js';
export { SiliconFlowEmbedding } from './siliconflow.js';
export type { SiliconFlowEmbeddingOptions } from './siliconflow.js';
export { NetworkPolicy, RemoteProviderBlockedError } from '../network-policy.js';
