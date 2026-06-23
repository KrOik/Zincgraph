import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { runPonytailReview, type PonytailCommandDelegation } from '../bridge/ponytailAdapter.js';
import {
  GraphReviewAnalyzer,
  formatGraphReviewFindings,
  loadSnapshotForReview,
  readGitDiff,
  type GraphEvidenceOptions,
  type GraphReviewFinding,
  type GraphReviewResult
} from './graph-review.js';
import type { CodeGraphSnapshot } from '../vector/code-to-vectors.js';
import {
  ReviewCompressor,
  formatReviewCompressionResult,
  type ReviewCompressionOptions,
  type ReviewCompressionResult
} from '../compression/review-compressor.js';
import type { CompressionFeedbackLoop } from '../compression/feedback-loop.js';

export interface GraphReviewCommandOptions {
  diff?: boolean;
  diffText?: string;
  snapshot?: CodeGraphSnapshot;
  evidence?: GraphEvidenceOptions;
  ponytail?: PonytailCommandDelegation;
  runPonytail?: typeof runPonytailReview;
  readSnapshot?: (projectPath: string) => CodeGraphSnapshot;
  readDiff?: (projectPath: string) => string;
  /** When set, review findings are compressed before output. */
  compress?: boolean | ReviewCompressionOptions;
  compressor?: ReviewCompressor;
  feedbackLoop?: CompressionFeedbackLoop;
}

export interface GraphReviewCommandResult {
  projectPath: string;
  ponytail: PonytailCommandDelegation;
  graph: GraphReviewResult | null;
  graphFindings: GraphReviewFinding[];
  graphAvailable: boolean;
  warnings: string[];
  compressed?: ReviewCompressionResult;
}

export async function runGraphReviewCommand(
  projectPath: string,
  options: GraphReviewCommandOptions = {}
): Promise<GraphReviewCommandResult> {
  const resolvedProject = resolve(projectPath);
  const ponytail = options.ponytail ?? (options.runPonytail ?? runPonytailReview)(resolvedProject, { diff: options.diff ?? false });
  const warnings: string[] = [];
  try {
    const snapshot = options.snapshot ?? (options.readSnapshot ?? loadSnapshotForReview)(resolvedProject);
    const diffText = options.diffText ?? (options.diff ? (options.readDiff ?? readGitDiff)(resolvedProject) : '');
    const graph = new GraphReviewAnalyzer().analyze({ snapshot, diffText, evidence: options.evidence });
    const graphFindings = options.diff ? graph.reviewFindings : graph.findings;
    const base: Omit<GraphReviewCommandResult, 'compressed'> = { projectPath: resolvedProject, ponytail, graph, graphFindings, graphAvailable: true, warnings };
    if (options.compress) {
      const compressor = options.compressor ?? ReviewCompressor.createFromProject(resolvedProject, { feedbackLoop: options.feedbackLoop });
      const compressionOptions: ReviewCompressionOptions = typeof options.compress === 'object' ? options.compress : {};
      const compressed = await compressor.compress(graphFindings, {
        ...compressionOptions,
        queryContext: compressionOptions.queryContext ?? buildReviewCompressionScope(resolvedProject, snapshot, diffText, Boolean(options.diff))
      });
      return { ...base, compressed };
    }
    return base;
  } catch (error) {
    warnings.push(`graph review unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return { projectPath: resolvedProject, ponytail, graph: null, graphFindings: [], graphAvailable: false, warnings };
  }
}

function buildReviewCompressionScope(
  projectPath: string,
  snapshot: CodeGraphSnapshot,
  diffText: string,
  diffMode: boolean
): string {
  const fingerprint = diffMode
    ? diffText
    : JSON.stringify(snapshot.nodes.map((node) => [
        node.id,
        node.filePath,
        node.kind,
        node.qualifiedName,
        node.language,
        node.startLine ?? '',
        node.endLine ?? '',
        node.signature ?? ''
      ]));
  const hash = createHash('sha256').update(`${projectPath}\n${fingerprint}`).digest('hex').slice(0, 16);
  return `${diffMode ? 'diff' : 'snapshot'}:${hash}`;
}

export function formatGraphReviewCommandResult(result: GraphReviewCommandResult): string[] {
  const lines = [
    result.ponytail.marker,
    `project=${result.ponytail.projectPath}`,
    `promptLength=${result.ponytail.prompt.length}`,
    ...result.warnings.map((warning) => `warning: ${warning}`)
  ];
  if (result.compressed) {
    lines.push(...formatReviewCompressionResult(result.compressed));
    return lines;
  }
  lines.push(...formatGraphReviewFindings(result.graphFindings));
  return lines;
}
