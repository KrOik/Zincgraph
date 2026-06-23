import type { FusionNode } from '../fusion/query-engine.js';
import { CcrStore } from './ccr-store.js';
import {
  applyStrategy,
  detectContentType,
  selectStrategy,
  type CompressionStrategyOptions
} from './compression-strategy.js';
import { CompressionFeedbackLoop } from './feedback-loop.js';
import type { FeedbackSource } from './feedback-store.js';

export interface FusionCompressionAdapter {
  compress(
    candidates: FusionNode[],
    options: CompressionOptions
  ): Promise<FusionCompressionResult>;
  retrieve(hash: string): Promise<string | null>;
  getStats(): CompressionStats;
}

export interface CompressionOptions {
  maxTokens: number;
  strategy?: 'auto' | 'aggressive' | 'conservative' | 'off';
  enabled?: boolean;
}

export interface FusionCompressionResult {
  compressedCandidates: FusionNode[];
  ccrHashes: Map<string, string>;
  tokensSaved: number;
  compressionRatio: number;
}

export interface CompressionStats {
  totalCompressions: number;
  totalTokensBefore: number;
  totalTokensAfter: number;
  totalTokensSaved: number;
  averageCompressionRatio: number;
  retrievalCount: number;
}

export interface FusionCompressorOptions {
  ccrStore: CcrStore;
  defaultMaxTokens?: number;
  defaultStrategy?: 'auto' | 'aggressive' | 'conservative' | 'off';
  feedbackLoop?: CompressionFeedbackLoop;
}

const COMPRESSION_MARKER = '__headroom_compressed';
const HASH_MARKER = '__headroom_hash';

export class FusionCompressor implements FusionCompressionAdapter {
  private readonly ccrStore: CcrStore;
  private readonly defaultMaxTokens: number;
  private readonly defaultStrategy: 'auto' | 'aggressive' | 'conservative' | 'off';
  private readonly feedbackLoop: CompressionFeedbackLoop | undefined;
  private stats: CompressionStats = {
    totalCompressions: 0,
    totalTokensBefore: 0,
    totalTokensAfter: 0,
    totalTokensSaved: 0,
    averageCompressionRatio: 0,
    retrievalCount: 0
  };

  constructor(options: FusionCompressorOptions) {
    this.ccrStore = options.ccrStore;
    this.defaultMaxTokens = options.defaultMaxTokens ?? 8000;
    this.defaultStrategy = options.defaultStrategy ?? 'auto';
    this.feedbackLoop = options.feedbackLoop;
  }

  async compress(candidates: FusionNode[], options: CompressionOptions): Promise<FusionCompressionResult> {
    const enabled = options.enabled ?? true;
    const maxTokens = options.maxTokens || this.defaultMaxTokens;
    const strategy = options.strategy ?? this.defaultStrategy;

    if (!enabled || strategy === 'off' || candidates.length === 0) {
      return {
        compressedCandidates: candidates,
        ccrHashes: new Map(),
        tokensSaved: 0,
        compressionRatio: 0
      };
    }

    const perCandidateBudget = Math.max(20, Math.floor(maxTokens / candidates.length));
    const strategyOptions: CompressionStrategyOptions = {
      maxTokens: perCandidateBudget,
      strategy
    };

    const compressedCandidates: FusionNode[] = [];
    const ccrHashes = new Map<string, string>();
    let totalTokensBefore = 0;
    let totalTokensAfter = 0;

    for (const node of candidates) {
      const selectedStrategy = selectStrategy(node, strategyOptions);
      const result = applyStrategy(node.content, selectedStrategy, perCandidateBudget, strategy);
      totalTokensBefore += result.tokensBefore;
      totalTokensAfter += result.tokensAfter;

      if (result.tokensAfter < result.tokensBefore) {
        const hash = await sha256Short(node.content);
        this.ccrStore.put(hash, node.content, detectContentType(node.content));
        ccrHashes.set(node.nodeId, hash);

        if (this.feedbackLoop) {
          const primarySource = node.sources[0] ?? 'graph';
          this.feedbackLoop.recordCompression({
            hash,
            nodeId: node.nodeId,
            source: primarySource as FeedbackSource,
            contentType: detectContentType(node.content),
            kind: node.kind,
            compressedAt: Date.now()
          });
        }

        const compressedNode: FusionNode = {
          ...node,
          content: result.compressed,
          annotations: [
            ...(node.annotations ?? []),
            {
              type: 'compression-info' as const,
              severity: 'info' as const,
              message: `Compressed: ${result.tokensBefore} → ${result.tokensAfter} tokens (${selectedStrategy})`,
              evidence: {
                [COMPRESSION_MARKER]: true,
                [HASH_MARKER]: hash,
                tokensBefore: result.tokensBefore,
                tokensAfter: result.tokensAfter,
                strategy: selectedStrategy
              }
            }
          ]
        };
        compressedCandidates.push(compressedNode);
      } else {
        compressedCandidates.push(node);
      }
    }

    const tokensSaved = Math.max(0, totalTokensBefore - totalTokensAfter);
    const compressionRatio = totalTokensBefore > 0 ? tokensSaved / totalTokensBefore : 0;

    this.stats.totalCompressions += 1;
    this.stats.totalTokensBefore += totalTokensBefore;
    this.stats.totalTokensAfter += totalTokensAfter;
    this.stats.totalTokensSaved += tokensSaved;
    this.stats.averageCompressionRatio =
      this.stats.totalTokensBefore > 0
        ? this.stats.totalTokensSaved / this.stats.totalTokensBefore
        : 0;

    return { compressedCandidates, ccrHashes, tokensSaved, compressionRatio };
  }

  async retrieve(hash: string): Promise<string | null> {
    const entry = this.ccrStore.get(hash);
    if (entry) {
      this.stats.retrievalCount += 1;
      return entry.content;
    }
    return null;
  }

  getStats(): CompressionStats {
    return { ...this.stats };
  }

  static createFromProject(projectPath: string, options?: Partial<FusionCompressorOptions>): FusionCompressor {
    const ccrStore = options?.ccrStore ?? new CcrStore({ projectPath });
    return new FusionCompressor({ ...options, ccrStore });
  }
}

export function createProjectFusionCompressor(projectPath: string, options?: Partial<FusionCompressorOptions>): FusionCompressor {
  const ccrStore = options?.ccrStore ?? new CcrStore({ projectPath });
  const feedbackLoop = resolveProjectFeedbackLoop(projectPath, options?.feedbackLoop);
  return new FusionCompressor({
    ...options,
    ccrStore,
    ...(feedbackLoop ? { feedbackLoop } : {})
  });
}

function resolveProjectFeedbackLoop(
  projectPath: string,
  feedbackLoop?: CompressionFeedbackLoop
): CompressionFeedbackLoop | undefined {
  if (feedbackLoop) {
    return feedbackLoop;
  }

  try {
    return CompressionFeedbackLoop.createFromProject(projectPath);
  } catch {
    console.warn(`Compression feedback initialization failed for ${projectPath}; using compressor without feedback.`);
    return undefined;
  }
}

async function sha256Short(content: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export { COMPRESSION_MARKER, HASH_MARKER };
