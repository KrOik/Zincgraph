export type EvidenceSource = 'graph' | 'vector' | 'fts';

export type BehaviorAnnotationType =
  | 'stdlib-replacement'
  | 'native-replacement'
  | 'semantic-duplicate'
  | 'dead-code'
  | 'no-callers'
  | 'compression-info';

export type BehaviorAnnotationSeverity = 'info' | 'suggestion' | 'warning';

export interface BehaviorAnnotation {
  type: BehaviorAnnotationType;
  severity: BehaviorAnnotationSeverity;
  message: string;
  evidence: Record<string, unknown>;
}

export interface BudgetableCandidate {
  nodeId: string;
  filePath: string;
  qualifiedName: string;
  kind: string;
  score: number;
  sources: readonly EvidenceSource[];
  content?: string;
  annotations?: readonly BehaviorAnnotation[];
}

export interface ContextBudgetOptions {
  maxTokens?: number;
  maxLinesPerCandidate?: number;
}

export interface ContextCandidateExcerpt {
  nodeId: string;
  qualifiedName: string;
  kind: string;
  sources: EvidenceSource[];
  score: number;
  excerpt: string;
  tokenEstimate: number;
  annotations?: BehaviorAnnotation[];
}

export interface ContextBlock {
  filePath: string;
  tokenEstimate: number;
  candidates: ContextCandidateExcerpt[];
}

export interface ContextBudgetResult {
  maxTokens: number;
  usedTokens: number;
  blocks: ContextBlock[];
  includedNodeIds: string[];
  droppedNodeIds: string[];
  truncated: boolean;
}

interface SizedExcerpt {
  excerpt: string;
  tokenEstimate: number;
}

const DEFAULT_MAX_TOKENS = 8_000;
const DEFAULT_MAX_LINES = 22;

export function applyContextBudget(
  candidates: readonly BudgetableCandidate[],
  options: ContextBudgetOptions = {}
): ContextBudgetResult {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxLines = options.maxLinesPerCandidate ?? DEFAULT_MAX_LINES;
  const sorted = [...candidates].sort(compareCandidatePriority);
  const blocksByFile = new Map<string, ContextBlock>();
  const includedNodeIds: string[] = [];
  const droppedNodeIds: string[] = [];
  let usedTokens = 0;
  let truncated = false;

  for (const candidate of sorted) {
    const baseExcerpt = truncateContent(candidate.content ?? candidate.qualifiedName, maxLines);
    const metadataTokenEstimate = estimateTokens(candidate.qualifiedName) + 4;
    const remainingTokens = maxTokens - usedTokens;
    const sizedExcerpt = fitExcerptToBudget(baseExcerpt, metadataTokenEstimate, remainingTokens);
    if (!sizedExcerpt) {
      droppedNodeIds.push(candidate.nodeId);
      truncated = true;
      continue;
    }
    if (sizedExcerpt.excerpt !== baseExcerpt) {
      truncated = true;
    }

    const block = blocksByFile.get(candidate.filePath) ?? {
      filePath: candidate.filePath,
      tokenEstimate: 0,
      candidates: []
    };
    block.candidates.push({
      nodeId: candidate.nodeId,
      qualifiedName: candidate.qualifiedName,
      kind: candidate.kind,
      sources: [...candidate.sources],
      score: candidate.score,
      excerpt: sizedExcerpt.excerpt,
      tokenEstimate: sizedExcerpt.tokenEstimate,
      ...(candidate.annotations?.length ? { annotations: [...candidate.annotations] } : {})
    });
    block.tokenEstimate += sizedExcerpt.tokenEstimate;
    blocksByFile.set(candidate.filePath, block);
    includedNodeIds.push(candidate.nodeId);
    usedTokens += sizedExcerpt.tokenEstimate;
  }

  return {
    maxTokens,
    usedTokens,
    blocks: [...blocksByFile.values()],
    includedNodeIds,
    droppedNodeIds,
    truncated
  };
}

export function compareCandidatePriority(left: BudgetableCandidate, right: BudgetableCandidate): number {
  const priorityDelta = sourcePriority(right.sources) - sourcePriority(left.sources);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return right.score - left.score;
}

export function truncateContent(content: string, maxLines = DEFAULT_MAX_LINES): string {
  const lines = content.split(/\r?\n/);
  if (lines.length <= maxLines) {
    return content;
  }
  return [...lines.slice(0, maxLines), `... truncated ${lines.length - maxLines} lines`].join('\n');
}

function sourcePriority(sources: readonly EvidenceSource[]): number {
  if (sources.includes('graph')) {
    return 3_000 + (sources.includes('vector') ? 20 : 0) + (sources.includes('fts') ? 10 : 0);
  }
  if (sources.includes('vector')) {
    return 2_000 + (sources.includes('fts') ? 10 : 0);
  }
  if (sources.includes('fts')) {
    return 1_000;
  }
  return 0;
}

function fitExcerptToBudget(excerpt: string, metadataTokenEstimate: number, remainingTokens: number): SizedExcerpt | null {
  if (remainingTokens <= metadataTokenEstimate) {
    return null;
  }

  const tokenEstimate = estimateTokens(excerpt) + metadataTokenEstimate;
  if (tokenEstimate <= remainingTokens) {
    return { excerpt, tokenEstimate };
  }

  const excerptBudget = remainingTokens - metadataTokenEstimate;
  const words = excerpt.trim().split(/\s+/).filter(Boolean);
  if (excerptBudget <= 0 || words.length === 0) {
    return null;
  }

  const fittedExcerpt = words.slice(0, excerptBudget).join(' ');
  return {
    excerpt: fittedExcerpt,
    tokenEstimate: estimateTokens(fittedExcerpt) + metadataTokenEstimate
  };
}

function estimateTokens(text: string): number {
  const tokens = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, tokens);
}
