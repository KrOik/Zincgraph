import type { ContextCapsule, FusionNode } from './query-engine.js';

export interface CompactContextNode {
  nodeId: string;
  filePath: string;
  language: string;
  kind: string;
  qualifiedName: string;
  score: number;
  sources: FusionNode['sources'];
  sourceScores: FusionNode['sourceScores'];
  freshnessState?: FusionNode['freshnessState'];
  rankFeatures?: FusionNode['rankFeatures'];
  warnings?: string[];
  annotations?: Array<Pick<NonNullable<FusionNode['annotations']>[number], 'type' | 'severity' | 'message'>>;
}

export interface CompactContextCapsule {
  query: string;
  strippedQuery: string;
  intent: ContextCapsule['intent'];
  route: ContextCapsule['route'];
  filters: ContextCapsule['filters'];
  nodes: CompactContextNode[];
  policy: Pick<ContextCapsule['policy'], 'textBranch' | 'nativeFts' | 'relevanceMode'>;
  freshness: Pick<ContextCapsule['freshness'], 'fresh' | 'pending' | 'stale' | 'failed' | 'total' | 'isFresh' | 'warnings'>;
  warnings: string[];
  context: {
    maxTokens: number;
    usedTokens: number;
    includedNodeIds: string[];
    droppedNodeIds: string[];
    truncated: boolean;
    blockCount: number;
  };
}

export function summarizeContextCapsule(capsule: ContextCapsule): CompactContextCapsule {
  return {
    query: capsule.query,
    strippedQuery: capsule.strippedQuery,
    intent: capsule.intent,
    route: capsule.route,
    filters: capsule.filters,
    nodes: capsule.nodes.map(summarizeNode),
    policy: {
      textBranch: capsule.policy.textBranch,
      nativeFts: capsule.policy.nativeFts,
      ...(capsule.policy.relevanceMode ? { relevanceMode: capsule.policy.relevanceMode } : {})
    },
    freshness: {
      fresh: capsule.freshness.fresh,
      pending: capsule.freshness.pending,
      stale: capsule.freshness.stale,
      failed: capsule.freshness.failed,
      total: capsule.freshness.total,
      isFresh: capsule.freshness.isFresh,
      warnings: capsule.freshness.warnings
    },
    warnings: capsule.warnings,
    context: {
      maxTokens: capsule.context.maxTokens,
      usedTokens: capsule.context.usedTokens,
      includedNodeIds: capsule.context.includedNodeIds,
      droppedNodeIds: capsule.context.droppedNodeIds,
      truncated: capsule.context.truncated,
      blockCount: capsule.context.blocks.length
    }
  };
}

function summarizeNode(node: FusionNode): CompactContextNode {
  return {
    nodeId: node.nodeId,
    filePath: node.filePath,
    language: node.language,
    kind: node.kind,
    qualifiedName: node.qualifiedName,
    score: Number(node.score.toFixed(4)),
    sources: node.sources,
    sourceScores: node.sourceScores,
    ...(node.freshnessState ? { freshnessState: node.freshnessState } : {}),
    ...(node.rankFeatures ? { rankFeatures: node.rankFeatures } : {}),
    ...(node.warnings?.length ? { warnings: node.warnings } : {}),
    ...(node.annotations?.length
      ? {
        annotations: node.annotations.map((annotation) => ({
          type: annotation.type,
          severity: annotation.severity,
          message: annotation.message
        }))
      }
      : {})
  };
}
