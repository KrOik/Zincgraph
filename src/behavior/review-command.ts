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

export interface GraphReviewCommandOptions {
  diff?: boolean;
  diffText?: string;
  snapshot?: CodeGraphSnapshot;
  evidence?: GraphEvidenceOptions;
  ponytail?: PonytailCommandDelegation;
  runPonytail?: typeof runPonytailReview;
  readSnapshot?: (projectPath: string) => CodeGraphSnapshot;
  readDiff?: (projectPath: string) => string;
}

export interface GraphReviewCommandResult {
  projectPath: string;
  ponytail: PonytailCommandDelegation;
  graph: GraphReviewResult | null;
  graphFindings: GraphReviewFinding[];
  graphAvailable: boolean;
  warnings: string[];
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
    return { projectPath: resolvedProject, ponytail, graph, graphFindings, graphAvailable: true, warnings };
  } catch (error) {
    warnings.push(`graph review unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return { projectPath: resolvedProject, ponytail, graph: null, graphFindings: [], graphAvailable: false, warnings };
  }
}

export function formatGraphReviewCommandResult(result: GraphReviewCommandResult): string[] {
  return [
    result.ponytail.marker,
    `project=${result.ponytail.projectPath}`,
    `promptLength=${result.ponytail.prompt.length}`,
    ...result.warnings.map((warning) => `warning: ${warning}`),
    ...formatGraphReviewFindings(result.graphFindings)
  ];
}
