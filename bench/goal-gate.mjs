#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_SUMMARY_PATH = join(resolve(import.meta.dirname, '..'), 'bench/results/latest/summary.json');
export const DEFAULT_SPEEDUP_TARGET = 3;
export const EXCLUDED_RETRIEVAL_TASK_IDS = new Set(['status-index-coverage', 'isolated-update-freshness']);
export const DEFAULT_THRESHOLDS = Object.freeze({
  qualityMargin: 4,
  zincgraphFusionOutputBytes: 220000,
  isolatedUpdateFreshnessMedianMs: 1200,
  graphNavigationAutosyncPipelineMedianMs: 1500,
  affectedReviewCommandTestsMedianMs: 500,
  behaviorDedupReviewMedianMs: 750,
  impactAutosyncTopologyDensityScore: 40,
  impactAutosyncTopologyFileHits: 2,
  exactAutosyncApiDensityScore: 50,
  crossModuleFreshnessVectorFlowFileHits: 4,
  freshnessManifestSymbolHits: 3,
  freshnessDimensionScore: 25
});

export function isRetrievalTask(task) {
  return task?.applicable !== false &&
    (task.arm === 'codegraph' || task.arm === 'zincgraph-fusion') &&
    Number.isFinite(task.medianLatencyMs) &&
    !EXCLUDED_RETRIEVAL_TASK_IDS.has(task.id);
}

export function median(values) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!finite.length) return 0;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

export function evaluateBenchmarkGoal(summary, options = {}) {
  if (isPoolBenchmarkSummary(summary)) {
    return evaluatePoolBenchmarkGoal(summary);
  }
  const speedupTarget = options.speedupTarget ?? DEFAULT_SPEEDUP_TARGET;
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) };
  const failures = [];
  const warnings = [];
  const codegraphQuality = summary?.qualityOnly?.arms?.codegraph?.totalScore ?? summary?.arms?.codegraph?.totalScore;
  const zincgraphQuality = summary?.qualityOnly?.arms?.['zincgraph-fusion']?.totalScore ?? summary?.arms?.['zincgraph-fusion']?.totalScore;
  const qualityMargin = Number.isFinite(codegraphQuality) && Number.isFinite(zincgraphQuality)
    ? zincgraphQuality - codegraphQuality
    : NaN;
  if (!Number.isFinite(codegraphQuality) || !Number.isFinite(zincgraphQuality)) {
    failures.push('Missing quality-only scores for codegraph or zincgraph-fusion.');
  } else if (qualityMargin < thresholds.qualityMargin) {
    failures.push(
      `Quality margin missed: zincgraph-fusion ${zincgraphQuality} must be >= ` +
      `codegraph ${codegraphQuality} + ${thresholds.qualityMargin}.`
    );
  } else {
    pushMarginWarning(warnings, 'Quality margin', qualityMargin, '>=', thresholds.qualityMargin);
  }

  const fusionOutputBytes = summary?.arms?.['zincgraph-fusion']?.raw?.totalOutputBytes;
  if (!Number.isFinite(fusionOutputBytes) || fusionOutputBytes > thresholds.zincgraphFusionOutputBytes) {
    failures.push(`Output budget missed: zincgraph-fusion output ${fusionOutputBytes} must be <= ${thresholds.zincgraphFusionOutputBytes}.`);
  } else {
    pushMarginWarning(warnings, 'Output budget', fusionOutputBytes, '<=', thresholds.zincgraphFusionOutputBytes);
  }

  const freshnessScore = 100 * (summary?.qualityOnly?.arms?.['zincgraph-fusion']?.dimensionScores?.freshness ??
    summary?.arms?.['zincgraph-fusion']?.dimensionScores?.freshness ?? NaN);
  if (!Number.isFinite(freshnessScore) || freshnessScore < thresholds.freshnessDimensionScore) {
    failures.push(`Freshness dimension missed: ${round2(freshnessScore)} must be >= ${thresholds.freshnessDimensionScore}.`);
  } else {
    pushMarginWarning(warnings, 'Freshness dimension', freshnessScore, '>=', thresholds.freshnessDimensionScore);
  }

  const zincgraphTasks = (summary?.tasks ?? [])
    .filter((task) => task.arm === 'zincgraph-fusion' && task.applicable !== false);
  const failedZincgraphTasks = zincgraphTasks.filter((task) => task.status !== 0);
  if (failedZincgraphTasks.length > 0) {
    failures.push(`Failed zincgraph-fusion tasks: ${failedZincgraphTasks.map((task) => task.id).join(', ')}.`);
  }

  const retrievalTasks = (summary?.tasks ?? []).filter(isRetrievalTask);
  const codegraphLatencyMs = median(retrievalTasks
    .filter((task) => task.arm === 'codegraph')
    .map((task) => task.medianLatencyMs));
  const zincgraphLatencyMs = median(retrievalTasks
    .filter((task) => task.arm === 'zincgraph-fusion')
    .map((task) => task.medianLatencyMs));
  if (codegraphLatencyMs <= 0 || zincgraphLatencyMs <= 0) {
    failures.push('Missing positive retrieval latency medians for codegraph or zincgraph-fusion.');
  } else if (zincgraphLatencyMs > codegraphLatencyMs / speedupTarget) {
    failures.push(
      `Speed target missed: zincgraph-fusion retrieval median ${round2(zincgraphLatencyMs)}ms must be <= ` +
      `${round2(codegraphLatencyMs / speedupTarget)}ms (codegraph ${round2(codegraphLatencyMs)}ms / ${speedupTarget}).`
    );
  } else {
    pushMarginWarning(warnings, 'Speed target', zincgraphLatencyMs, '<=', codegraphLatencyMs / speedupTarget);
  }

  const taskChecks = [
    ['isolated-update-freshness', 'medianLatencyMs', '<=', thresholds.isolatedUpdateFreshnessMedianMs],
    ['graph-navigation-autosync-pipeline', 'medianLatencyMs', '<=', thresholds.graphNavigationAutosyncPipelineMedianMs],
    ['affected-review-command-tests', 'medianLatencyMs', '<=', thresholds.affectedReviewCommandTestsMedianMs],
    ['behavior-dedup-review', 'medianLatencyMs', '<=', thresholds.behaviorDedupReviewMedianMs],
    ['impact-autosync-topology', 'densityScore', '>=', thresholds.impactAutosyncTopologyDensityScore],
    ['impact-autosync-topology', 'goldenFileHits', '>=', thresholds.impactAutosyncTopologyFileHits],
    ['exact-autosync-api', 'densityScore', '>=', thresholds.exactAutosyncApiDensityScore],
    ['cross-module-freshness-vector-flow', 'goldenFileHits', '>=', thresholds.crossModuleFreshnessVectorFlowFileHits],
    ['freshness-manifest', 'goldenSymbolHits', '>=', thresholds.freshnessManifestSymbolHits]
  ];
  for (const [taskId, metric, operator, threshold] of taskChecks) {
    const task = taskById(summary, taskId);
    const value = metricValue(task, metric);
    const passed = operator === '<=' ? value <= threshold : value >= threshold;
    if (!Number.isFinite(value) || !passed) {
      failures.push(`${taskId} ${metric} missed: ${round2(value)} must be ${operator} ${threshold}.`);
      continue;
    }
    pushMarginWarning(warnings, `${taskId} ${metric}`, value, operator, threshold);
  }

  return {
    passed: failures.length === 0,
    failures,
    warnings,
    metrics: {
      codegraphQuality,
      zincgraphQuality,
      codegraphRetrievalMedianMs: round2(codegraphLatencyMs),
      zincgraphRetrievalMedianMs: round2(zincgraphLatencyMs),
      speedup: zincgraphLatencyMs > 0 ? round2(codegraphLatencyMs / zincgraphLatencyMs) : 0,
      speedupTarget,
      qualityMargin: Number.isFinite(qualityMargin) ? round2(qualityMargin) : 0,
      fusionOutputBytes,
      freshnessScore: round2(freshnessScore),
      retrievalTaskIds: [...new Set(retrievalTasks.map((task) => task.id))]
    }
  };
}

function isPoolBenchmarkSummary(summary) {
  return Array.isArray(summary?.repoResults) && Array.isArray(summary?.caseResults) && summary?.scoreModel?.version;
}

function evaluatePoolBenchmarkGoal(summary) {
  const failures = [];
  const warnings = [];
  if (summary.accepted !== true) {
    failures.push('Pool benchmark summary is not accepted.');
  }
  if (summary.hardGate?.passed !== true) {
    failures.push('Pool hard gate did not pass.');
  }
  if (summary.scoreFloors?.passed !== true) {
    failures.push('Pool score floors did not pass.');
  }
  if (summary.nonMutationProof?.passed !== true) {
    failures.push('Pool non-mutation proof did not pass.');
  }
  if (summary.poolValidation?.ok !== true) {
    failures.push('Pool validation did not pass.');
  }
  const repoCount = Number(summary.repoCount ?? 0);
  const caseCount = Number(summary.caseCount ?? 0);
  if (repoCount !== 6) {
    failures.push(`Expected 6 repos in the pool summary, got ${repoCount}.`);
  }
  if (caseCount !== 52) {
    failures.push(`Expected 52 cases in the pool summary, got ${caseCount}.`);
  }
  const coreRepoFloor = summary.scoreFloors?.coreRepoFloor === true;
  const coreCaseFloor = summary.scoreFloors?.coreCaseFloor === true;
  const baselineFloor = summary.scoreFloors?.baselineFloor === true;
  if (!coreRepoFloor) {
    failures.push('Core repo score floor was not met.');
  }
  if (!coreCaseFloor) {
    failures.push('Core case score floor was not met.');
  }
  if (!baselineFloor) {
    failures.push('Baseline floor was not met.');
  }
  return {
    passed: failures.length === 0,
    failures,
    warnings,
    metrics: {
      repoCount,
      caseCount,
      globalQualityScore: round2(summary.globalQualityScore),
      baselineFound: Boolean(summary.baseline?.found),
      baselineGlobalQualityScore: Number(summary.baseline?.globalQualityScore ?? 0),
      coreRepoFloor,
      coreCaseFloor,
      baselineFloor
    }
  };
}

function taskById(summary, id, arm = 'zincgraph-fusion') {
  return (summary?.tasks ?? []).find((task) => task.id === id && task.arm === arm && task.applicable !== false);
}

function metricValue(task, metric) {
  if (!task) return NaN;
  if (metric === 'densityScore') return 100 * (task.scores?.density ?? NaN);
  return task[metric];
}

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

function pushMarginWarning(warnings, label, value, operator, threshold) {
  if (!Number.isFinite(value) || !Number.isFinite(threshold) || threshold <= 0) {
    return;
  }
  if (operator === '>=') {
    if (value >= threshold && value < threshold * 1.1) {
      warnings.push(`${label} is within 10% of the gate: ${round2(value)} vs >= ${round2(threshold)}.`);
    }
    return;
  }
  if (operator === '<=' && value <= threshold && value > threshold * 0.9) {
    warnings.push(`${label} is within 10% of the gate: ${round2(value)} vs <= ${round2(threshold)}.`);
  }
}

function main() {
  const summaryPath = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_SUMMARY_PATH;
  if (!existsSync(summaryPath)) {
    console.error(`Missing benchmark summary: ${summaryPath}`);
    process.exit(1);
  }
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const result = evaluateBenchmarkGoal(summary);
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) {
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
