import { CcrStore } from './ccr-store.js';
import { FeedbackStore } from './feedback-store.js';
import type { CompressionFeedbackLoop } from './feedback-loop.js';
import type {
  GraphReviewFinding,
  GraphReviewFindingType
} from '../behavior/graph-review.js';

export interface ReviewCompressionOptions {
  queryContext?: string;
  /** Skip findings whose group was already discussed in a prior turn. */
  skipDiscussed?: boolean;
}

export interface AggregatedReviewFinding {
  type: GraphReviewFindingType;
  filePath: string;
  matchCount: number;
  summary: string;
  subjects: string[];
  ccrHash?: string;
  previouslyDiscussed: boolean;
  original: GraphReviewFinding[];
}

export interface ReviewCompressionResult {
  aggregated: AggregatedReviewFinding[];
  ccrHash: string;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  compressionRatio: number;
  discussedSignatures: string[];
}

export interface ReviewCompressorOptions {
  ccrStore: CcrStore;
  feedbackLoop?: CompressionFeedbackLoop | undefined;
  tracker?: CrossTurnContextTracker | undefined;
}

const APPROX_CHARS_PER_TOKEN = 4;

/**
 * Tracks finding signatures that have already been discussed across review
 * turns so subsequent reviews can downgrade or omit them.
 */
export class CrossTurnContextTracker {
  private readonly discussed = new Set<string>();

  get size(): number {
    return this.discussed.size;
  }

  has(signature: string): boolean {
    return this.discussed.has(signature);
  }

  mark(signature: string): void {
    this.discussed.add(signature);
  }

  markAll(signatures: readonly string[]): void {
    for (const sig of signatures) {
      this.discussed.add(sig);
    }
  }

  clear(): void {
    this.discussed.clear();
  }

  signatures(): string[] {
    return [...this.discussed].sort();
  }
}

export class PersistentCrossTurnContextTracker extends CrossTurnContextTracker {
  private readonly store: FeedbackStore;

  constructor(store: FeedbackStore) {
    super();
    this.store = store;
    super.markAll(this.store.listReviewSignatures().map((record) => record.signature));
  }

  override mark(signature: string): void {
    if (this.has(signature)) {
      return;
    }
    super.mark(signature);
    this.store.recordReviewSignature({ signature, discussedAt: Date.now() });
  }

  override markAll(signatures: readonly string[]): void {
    for (const signature of signatures) {
      this.mark(signature);
    }
  }

  override clear(): void {
    super.clear();
    this.store.clearReviewSignatures();
  }

  close(): void {
    this.store.close();
  }
}

export function findingSignature(finding: GraphReviewFinding): string {
  const filePath = extractFilePath(finding);
  const subject = extractSubject(finding);
  return `${finding.type}:${filePath}:${subject}`;
}

function extractFilePath(finding: GraphReviewFinding): string {
  const evidence = finding.evidence as Record<string, unknown>;
  const candidates = [
    evidence.filePath,
    (evidence.added as Record<string, unknown> | undefined)?.filePath,
    (evidence.existing as Record<string, unknown> | undefined)?.filePath,
    (evidence.node as Record<string, unknown> | undefined)?.filePath,
    (evidence.redundantImport as Record<string, unknown> | undefined)?.filePath,
    evidence.location
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return 'unknown';
}

function extractSubject(finding: GraphReviewFinding): string {
  const evidence = finding.evidence as Record<string, unknown>;
  switch (finding.type) {
    case 'same-signature': {
      const added = evidence.added as Record<string, unknown> | undefined;
      const existing = evidence.existing as Record<string, unknown> | undefined;
      return String(added?.name ?? existing?.qualifiedName ?? 'unknown');
    }
    case 'redundant-import': {
      const added = evidence.added as Record<string, unknown> | undefined;
      return String(added?.moduleName ?? 'unknown');
    }
    case 'yagni': {
      const abstraction = evidence.abstraction as Record<string, unknown> | undefined;
      return String(abstraction?.name ?? 'unknown');
    }
    case 'similar-class': {
      const added = evidence.added as Record<string, unknown> | undefined;
      return String(added?.name ?? 'unknown');
    }
    case 'dead-code': {
      const node = evidence.node as Record<string, unknown> | undefined;
      return String(node?.qualifiedName ?? 'unknown');
    }
    case 'cycle-dependency': {
      const cycle = evidence.cycle;
      return Array.isArray(cycle) ? (cycle as string[]).join('->') : 'cycle';
    }
    default:
      return 'unknown';
  }
}

function summarizeFinding(finding: GraphReviewFinding): string {
  const subject = extractSubject(finding);
  switch (finding.type) {
    case 'same-signature':
      return `function ${subject} duplicates an existing same-signature definition`;
    case 'redundant-import':
      return `import ${subject} is redundant (already reachable transitively)`;
    case 'yagni': {
      const callerCount = Number((finding.evidence as Record<string, unknown>).callerCount ?? 0);
      return `${subject} has only ${callerCount} caller(s) — consider inlining`;
    }
    case 'similar-class':
      return `class ${subject} mirrors an existing hierarchy`;
    case 'dead-code':
      return `${subject} has 0 graph callers (dead code)`;
    case 'cycle-dependency':
      return `dependency cycle: ${subject}`;
    default:
      return finding.message;
  }
}

function approxTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / APPROX_CHARS_PER_TOKEN));
}

function groupKey(finding: GraphReviewFinding): string {
  return `${finding.type}:${extractFilePath(finding)}`;
}

async function shortHash(content: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export class ReviewCompressor {
  private readonly ccrStore: CcrStore;
  private readonly feedbackLoop: CompressionFeedbackLoop | undefined;
  private readonly tracker: CrossTurnContextTracker | undefined;
  private closed = false;

  constructor(options: ReviewCompressorOptions) {
    this.ccrStore = options.ccrStore;
    this.feedbackLoop = options.feedbackLoop;
    this.tracker = options.tracker;
  }

  static createFromProject(projectPath: string, options?: Partial<ReviewCompressorOptions>): ReviewCompressor {
    const ccrStore = options?.ccrStore ?? new CcrStore({ projectPath });
    const tracker =
      options?.tracker ??
      new PersistentCrossTurnContextTracker(options?.feedbackLoop?.store ?? new FeedbackStore({ projectPath }));
    return new ReviewCompressor({ ccrStore, feedbackLoop: options?.feedbackLoop, tracker });
  }

  async compress(
    findings: readonly GraphReviewFinding[],
    options: ReviewCompressionOptions = {}
  ): Promise<ReviewCompressionResult> {
    const scope = options.queryContext?.trim() || 'global';
    const groups = new Map<string, GraphReviewFinding[]>();
    for (const finding of findings) {
      const key = groupKey(finding);
      const bucket = groups.get(key);
      if (bucket) {
        bucket.push(finding);
      } else {
        groups.set(key, [finding]);
      }
    }

    const fullPayload = JSON.stringify(findings);
    const fullHash = await shortHash(fullPayload);
    this.ccrStore.put(fullHash, fullPayload, 'json');

    const aggregated: AggregatedReviewFinding[] = [];
    const discussedSignatures: string[] = [];
    let tokensBefore = approxTokens(fullPayload);
    let tokensAfter = 0;

    for (const [key, group] of groups) {
      const [type, filePath] = key.split(':');
      const subjects = uniqueSubjects(group);
      const signatures = group.map(findingSignature);
      const scopedSignatures = signatures.map((signature) => scopeSignature(scope, signature));
      const allDiscussed = this.tracker ? scopedSignatures.every((sig) => this.tracker!.has(sig)) : false;

      const groupPayload = JSON.stringify(group);
      const groupHash = await shortHash(groupPayload);
      this.ccrStore.put(groupHash, groupPayload, 'json');

      if (this.feedbackLoop) {
        for (const finding of group) {
          this.feedbackLoop.recordCompression({
            hash: groupHash,
            nodeId: extractSubject(finding),
            source: 'graph',
            contentType: 'json',
            kind: finding.type,
            compressedAt: Date.now()
          });
        }
      }

      const summary = subjects.length > 1
        ? `${type} (${subjects.length} matches): ${subjects.slice(0, 5).join(', ')}${subjects.length > 5 ? ' …' : ''}`
        : `${type}: ${summarizeFinding(group[0]!)}`;

      aggregated.push({
        type: type as GraphReviewFindingType,
        filePath: filePath ?? 'unknown',
        matchCount: group.length,
        summary,
        subjects,
        ccrHash: groupHash,
        previouslyDiscussed: allDiscussed,
        original: group
      });

      tokensAfter += approxTokens(summary);
      for (const sig of scopedSignatures) {
        discussedSignatures.push(sig);
      }
    }

    if (this.tracker) {
      this.tracker.markAll(discussedSignatures);
    }

    const tokensSaved = Math.max(0, tokensBefore - tokensAfter);
    const compressionRatio = tokensBefore > 0 ? tokensSaved / tokensBefore : 0;

    const visible = options.skipDiscussed ? aggregated.filter((entry) => !entry.previouslyDiscussed) : aggregated;

    return {
      aggregated: visible,
      ccrHash: fullHash,
      tokensBefore,
      tokensAfter: visible.reduce((sum, entry) => sum + approxTokens(entry.summary), 0),
      tokensSaved,
      compressionRatio,
      discussedSignatures
    };
  }

  format(result: ReviewCompressionResult): string[] {
    return formatReviewCompressionResult(result);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const tracker = this.tracker as { close?: () => void } | undefined;
    tracker?.close?.();
    this.feedbackLoop?.close();
    this.ccrStore.close();
  }
}

function scopeSignature(scope: string, signature: string): string {
  return `${scope}::${signature}`;
}

export function formatReviewCompressionResult(result: ReviewCompressionResult): string[] {
  const lines: string[] = [
    `# Graph review (compressed): ${result.aggregated.length} finding group(s)`,
    `[Retrieve full findings: zincgraph_retrieve hash=${result.ccrHash}]`
  ];
  for (const entry of result.aggregated) {
    const tag = entry.previouslyDiscussed ? ' [previously discussed]' : '';
    const matches = entry.matchCount > 1 ? ` (${entry.matchCount} matches)` : '';
    lines.push(`- ${entry.summary}${matches}${tag}`);
    if (entry.ccrHash) {
      lines.push(`  [Retrieve details: zincgraph_retrieve hash=${entry.ccrHash}]`);
    }
  }
  if (result.tokensSaved > 0) {
    lines.push(`# Compression: ${result.tokensBefore} → ${result.tokensAfter} tokens (saved ${result.tokensSaved}, ratio ${result.compressionRatio.toFixed(2)})`);
  }
  return lines;
}

function uniqueSubjects(group: readonly GraphReviewFinding[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const finding of group) {
    const subject = extractSubject(finding);
    if (!seen.has(subject)) {
      seen.add(subject);
      result.push(subject);
    }
  }
  return result;
}
