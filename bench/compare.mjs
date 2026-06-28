#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parsePoolBenchmarkArgs, runPoolBenchmark } from './pool-benchmark-runner.mjs';

export const WEIGHTS = Object.freeze({
  retrieval: 30,
  density: 20,
  runtime: 15,
  depth: 10,
  freshness: 15,
  capability: 10
});
export const QUALITY_WEIGHTS = Object.freeze({
  retrieval: WEIGHTS.retrieval,
  depth: WEIGHTS.depth,
  freshness: WEIGHTS.freshness,
  capability: WEIGHTS.capability
});
const DIMENSION_SCORE_KEYS = Object.freeze(['retrieval', 'density', 'runtime', 'depth', 'freshness', 'capability']);

const PRIMARY_ARMS = ['codegraph', 'zincgraph-fusion'];
const DELEGATED_ARM = 'zincgraph-delegated';
export const TASK_CATEGORIES = Object.freeze({
  SYMBOL_RETRIEVAL: 'symbol-retrieval',
  WORKFLOW_DISCOVERY: 'workflow-discovery',
  TOOL_SURFACE: 'tool-surface',
  FRESHNESS: 'freshness',
  BEHAVIOR_ANALYSIS: 'behavior-analysis',
  INDEX_STATUS: 'index-status',
  INCREMENTAL_UPDATE: 'incremental-update',
  GRAPH_TOPOLOGY: 'graph-topology',
  GRAPH_NAVIGATION: 'graph-navigation',
  TEST_IMPACT: 'test-impact',
  SEMANTIC_INTENT: 'semantic-intent',
  COMPRESSION_FEEDBACK: 'compression-feedback',
  CROSS_MODULE: 'cross-module-integration'
});
const STRUCTURAL_TERMS = [
  'caller', 'callee', 'calls', 'called', 'edge', 'import', 'dependency',
  'freshness', 'stale', 'pending', 'fresh', 'manifest', 'dedup', 'review', 'semantic'
];
const FRESHNESS_TERMS = ['stale', 'pending', 'fresh', 'manifest'];
const DEFAULT_RUNS = 5;
const OUTPUT_PREVIEW_BYTES = 500;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ZINCGRAPH_CLI = join(ROOT, 'dist/cli.js');
const CODEGRAPH_BIN = join(ROOT, 'node_modules/@colbymchenry/codegraph/npm-shim.js');
const CODEGRAPH_COMMAND = [process.execPath, CODEGRAPH_BIN];
const BENCHMARK_POOL_PATH = join(ROOT, 'bench/benchmark-pool.json');

export const TASKS = Object.freeze([
  {
    id: 'exact-autosync-api',
    category: TASK_CATEGORIES.SYMBOL_RETRIEVAL,
    description: 'Exact API/symbol retrieval for runAutoSyncOnce.',
    goldenFiles: ['src/freshness/auto-sync.ts'],
    goldenSymbols: ['runAutoSyncOnce'],
    relevantTerms: ['runAutoSyncOnce', 'AutoSyncPipeline', 'changed file'],
    commands: {
      codegraph: ['node_modules/.bin/codegraph', 'query', 'runAutoSyncOnce', '-p', '$PROJECT', '--json'],
      'zincgraph-fusion': ['node', 'dist/cli.js', 'search', 'runAutoSyncOnce', '-p', '$PROJECT', '--topk', '10'],
      'zincgraph-delegated': ['node', 'dist/cli.js', 'search', '--codegraph', 'runAutoSyncOnce', '-p', '$PROJECT', '--json']
    },
    expectedCapabilities: {
      codegraph: ['graph'],
      'zincgraph-fusion': ['graph-delegation', 'fusion'],
      'zincgraph-delegated': ['delegation', 'graph']
    }
  },
  {
    id: 'autosync-cli-flow',
    category: TASK_CATEGORIES.WORKFLOW_DISCOVERY,
    description: 'CLI to auto-sync runtime flow.',
    goldenFiles: ['src/cli.ts', 'src/freshness/auto-sync.ts'],
    goldenSymbols: ['auto-sync', 'runAutoSyncOnce'],
    relevantTerms: ['auto sync', 'changed files', 'runAutoSyncOnce'],
    commands: {
      codegraph: ['node_modules/.bin/codegraph', 'explore', 'auto sync command changed files', '-p', '$PROJECT'],
      'zincgraph-fusion': ['node', 'dist/cli.js', 'explore', 'auto sync command changed files', '-p', '$PROJECT', '--topk', '10']
    },
    expectedCapabilities: {
      codegraph: ['graph'],
      'zincgraph-fusion': ['graph-delegation', 'fusion', 'freshness']
    }
  },
  {
    id: 'mcp-fusion-registry',
    category: TASK_CATEGORIES.TOOL_SURFACE,
    description: 'Unified MCP registry and fusion tool surface.',
    goldenFiles: ['src/mcp/tool-registry.ts'],
    goldenSymbols: ['zincgraph_semantic_search', 'zincgraph_dedup_check'],
    relevantTerms: ['semantic search', 'tool registry', 'dedup'],
    commands: {
      codegraph: ['node_modules/.bin/codegraph', 'explore', 'zincgraph semantic search tool registry', '-p', '$PROJECT'],
      'zincgraph-fusion': ['node', 'dist/cli.js', 'explore', 'zincgraph semantic search tool registry', '-p', '$PROJECT', '--topk', '10']
    },
    expectedCapabilities: {
      codegraph: ['graph'],
      'zincgraph-fusion': ['graph-delegation', 'fusion', 'mcp']
    }
  },
  {
    id: 'freshness-manifest',
    category: TASK_CATEGORIES.FRESHNESS,
    description: 'Freshness and manifest semantics.',
    goldenFiles: ['src/freshness/manifest.ts', 'src/freshness/freshness-gate.ts', 'src/freshness/auto-sync.ts'],
    goldenSymbols: ['VectorManifestStore', 'FreshnessGate', 'AutoSyncPipeline'],
    relevantTerms: FRESHNESS_TERMS,
    commands: {
      codegraph: ['node_modules/.bin/codegraph', 'explore', 'manifest stale pending fresh freshness', '-p', '$PROJECT'],
      'zincgraph-fusion': ['node', 'dist/cli.js', 'explore', 'manifest stale pending fresh freshness', '-p', '$PROJECT', '--topk', '10']
    },
    expectedCapabilities: {
      codegraph: ['graph'],
      'zincgraph-fusion': ['graph-delegation', 'fusion', 'freshness']
    }
  },
  {
    id: 'behavior-dedup-review',
    category: TASK_CATEGORIES.BEHAVIOR_ANALYSIS,
    description: 'Graph review and semantic dedup behavior.',
    goldenFiles: ['src/behavior/dedup-check.ts', 'src/behavior/graph-review.ts'],
    goldenSymbols: ['runDedupCheck', 'analyzeGraphReview'],
    relevantTerms: ['semantic', 'dedup', 'graph review', 'similar'],
    commands: {
      codegraph: ['node_modules/.bin/codegraph', 'explore', 'semantic dedup graph review', '-p', '$PROJECT'],
      'zincgraph-fusion': [
        ['node', 'dist/cli.js', 'explore', 'semantic dedup graph review', '-p', '$PROJECT', '--topk', '10'],
        ['node', 'dist/cli.js', 'dedup', '--describe', 'auto sync path containment', '-p', '$PROJECT']
      ]
    },
    expectedCapabilities: {
      codegraph: ['graph'],
      'zincgraph-fusion': ['graph-delegation', 'fusion', 'dedup', 'review']
    }
  },
  {
    id: 'status-index-coverage',
    category: TASK_CATEGORIES.INDEX_STATUS,
    description: 'Index status and coverage parseability.',
    goldenFiles: [],
    goldenSymbols: [],
    relevantTerms: ['initialized', 'fileCount', 'nodeCount', 'edgeCount', 'languages'],
    commands: {
      codegraph: ['node_modules/.bin/codegraph', 'status', '$PROJECT', '--json'],
      'zincgraph-fusion': ['node', 'dist/cli.js', 'status', '$PROJECT', '--json'],
      'zincgraph-delegated': ['node', 'dist/cli.js', 'status', '$PROJECT', '--json']
    },
    expectedCapabilities: {
      codegraph: ['graph', 'index'],
      'zincgraph-fusion': ['delegation', 'graph', 'index'],
      'zincgraph-delegated': ['delegation', 'graph', 'index']
    }
  },
  {
    id: 'isolated-update-freshness',
    category: TASK_CATEGORIES.INCREMENTAL_UPDATE,
    description: 'Update/freshness behavior on isolated temp fixture.',
    isolated: true,
    goldenFiles: ['src/changed.ts'],
    goldenSymbols: ['addedLocalBenchmarkFunction'],
    relevantTerms: ['sync', 'fresh', 'transition', 'addedLocalBenchmarkFunction'],
    expectedCapabilities: {
      codegraph: ['graph', 'update'],
      'zincgraph-fusion': ['graph-delegation', 'freshness', 'update']
    }
  },
  {
    id: 'impact-autosync-topology',
    category: TASK_CATEGORIES.GRAPH_TOPOLOGY,
    description: 'Call graph impact around the auto-sync entry point.',
    goldenFiles: ['src/cli.ts', 'src/freshness/auto-sync.ts', 'tests/freshness/auto-sync.test.ts'],
    goldenSymbols: ['runAutoSyncOnce', 'AutoSyncPipeline'],
    relevantTerms: ['impact', 'caller', 'callee', 'auto-sync', 'changed files'],
    commands: {
      codegraph: ['node_modules/.bin/codegraph', 'impact', 'runAutoSyncOnce', '-p', '$PROJECT'],
      'zincgraph-fusion': ['node', 'dist/cli.js', 'impact', 'runAutoSyncOnce', '-p', '$PROJECT'],
      'zincgraph-delegated': ['node', 'dist/cli.js', 'impact', 'runAutoSyncOnce', '-p', '$PROJECT']
    },
    expectedCapabilities: {
      codegraph: ['graph', 'impact'],
      'zincgraph-fusion': ['graph-delegation', 'impact'],
      'zincgraph-delegated': ['delegation', 'graph', 'impact']
    }
  },
  {
    id: 'graph-navigation-autosync-pipeline',
    category: TASK_CATEGORIES.GRAPH_NAVIGATION,
    description: 'Direct node, caller, and callee navigation around the auto-sync pipeline.',
    goldenFiles: ['src/freshness/auto-sync.ts', 'src/bridge/codegraphAdapter.ts', 'src/vector/code-to-vectors.ts', 'src/index.ts'],
    goldenSymbols: ['runAutoSyncOnce', 'AutoSyncPipeline', 'syncCodeGraphProject', 'vectorizeProject'],
    relevantTerms: ['node', 'callers', 'callees', 'handleChange', 'freshness', 'sync'],
    commands: {
      codegraph: [
        ['node_modules/.bin/codegraph', 'node', 'runAutoSyncOnce', '-p', '$PROJECT'],
        ['node_modules/.bin/codegraph', 'callers', 'AutoSyncPipeline', '-p', '$PROJECT'],
        ['node_modules/.bin/codegraph', 'callees', 'runAutoSyncOnce', '-p', '$PROJECT']
      ],
      'zincgraph-fusion': [
        ['node', 'dist/cli.js', 'node', 'runAutoSyncOnce', '-p', '$PROJECT'],
        ['node', 'dist/cli.js', 'callers', 'AutoSyncPipeline', '-p', '$PROJECT'],
        ['node', 'dist/cli.js', 'callees', 'runAutoSyncOnce', '-p', '$PROJECT']
      ]
    },
    expectedCapabilities: {
      codegraph: ['graph'],
      'zincgraph-fusion': ['graph-delegation', 'fusion', 'graph']
    }
  },
  {
    id: 'affected-review-command-tests',
    category: TASK_CATEGORIES.TEST_IMPACT,
    description: 'Affected test selection for review-command changes.',
    goldenFiles: ['tests/behavior/review-command.test.ts', 'tests/cli.test.ts', 'tests/mcp/unified-server.test.ts'],
    goldenSymbols: ['runGraphReviewCommand', 'zincgraph_review', 'zincgraph_audit'],
    relevantTerms: ['affected test files', 'review-command', 'cli.test', 'unified-server'],
    commands: {
      codegraph: ['node_modules/.bin/codegraph', 'affected', 'src/behavior/review-command.ts', '-p', '$PROJECT'],
      'zincgraph-fusion': ['node', 'dist/cli.js', 'affected', 'src/behavior/review-command.ts', '-p', '$PROJECT']
    },
    expectedCapabilities: {
      codegraph: ['graph', 'impact'],
      'zincgraph-fusion': ['graph-delegation', 'impact']
    }
  },
  {
    id: 'semantic-intent-routing',
    category: TASK_CATEGORIES.SEMANTIC_INTENT,
    description: 'Natural-language semantic intent routing across compression ranking code.',
    goldenFiles: ['src/fusion/intent-router.ts', 'src/compression/ranking-adjuster.ts', 'src/compression/relevance-scorer.ts'],
    goldenSymbols: ['parseFusionQuery', 'createFeedbackAwarePolicy', 'RelevanceScorer'],
    relevantTerms: ['parseFusionQuery', 'routeParsedQuery', 'createFeedbackAwarePolicy', 'RelevanceScorer', 'compressionAggressiveness'],
    commands: {
      codegraph: ['node_modules/.bin/codegraph', 'explore', 'which code decides priority ordering when search results are mixed from multiple sources path:src/compression', '-p', '$PROJECT'],
      'zincgraph-fusion': ['node', 'dist/cli.js', 'search', 'which code decides priority ordering when search results are mixed from multiple sources path:src/compression', '-p', '$PROJECT', '--topk', '12']
    },
    expectedCapabilities: {
      codegraph: ['graph'],
      'zincgraph-fusion': ['graph-delegation', 'fusion', 'semantic-routing']
    }
  },
  {
    id: 'compression-feedback-cycle',
    category: TASK_CATEGORIES.COMPRESSION_FEEDBACK,
    description: 'Compression store, retrieval, and feedback-loop discoverability.',
    goldenFiles: ['src/compression/ccr-store.ts', 'src/compression/feedback-loop.ts', 'src/compression/fusion-compressor.ts'],
    goldenSymbols: ['CcrStore', 'CompressionFeedbackLoop', 'FusionCompressor'],
    relevantTerms: ['compression', 'retrieve', 'feedback', 'hash', 'stats'],
    commands: {
      codegraph: ['node_modules/.bin/codegraph', 'explore', 'compression retrieve feedback hash stats', '-p', '$PROJECT'],
      'zincgraph-fusion': [
        ['node', 'dist/cli.js', 'explore', 'compression retrieve feedback hash stats', '-p', '$PROJECT', '--topk', '10'],
        ['node', 'dist/cli.js', 'compression-stats', '$PROJECT']
      ]
    },
    expectedCapabilities: {
      codegraph: ['graph'],
      'zincgraph-fusion': ['graph-delegation', 'fusion', 'compression', 'feedback']
    }
  },
  {
    id: 'cross-module-freshness-vector-flow',
    category: TASK_CATEGORIES.CROSS_MODULE,
    description: 'Cross-module path from CLI auto-sync through freshness and vector indexing.',
    goldenFiles: ['src/cli.ts', 'src/freshness/auto-sync.ts', 'src/freshness/manifest.ts', 'src/vector/code-to-vectors.ts'],
    goldenSymbols: ['runAutoSyncOnce', 'VectorManifestStore', 'vectorizeProject'],
    relevantTerms: ['auto sync', 'freshness', 'manifest', 'vector', 'changed files'],
    commands: {
      codegraph: ['node_modules/.bin/codegraph', 'explore', 'auto sync freshness manifest vector changed files', '-p', '$PROJECT'],
      'zincgraph-fusion': ['node', 'dist/cli.js', 'explore', 'auto sync freshness manifest vector changed files', '-p', '$PROJECT', '--topk', '12', '--max-tokens', '12000']
    },
    expectedCapabilities: {
      codegraph: ['graph'],
      'zincgraph-fusion': ['graph-delegation', 'fusion', 'freshness', 'vector']
    }
  }
]);

export function clamp(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function scoreTask(result, task, context = {}) {
  if (result.applicable === false) {
    return zeroScores();
  }
  if (result.status !== 0) {
    return zeroScores();
  }
  const goldenFiles = task.goldenFiles ?? result.goldenFiles ?? [];
  const goldenSymbols = task.goldenSymbols ?? result.goldenSymbols ?? [];
  const relevantTerms = task.relevantTerms ?? result.relevantTerms ?? [];
  const goldenFileHits = result.goldenFileHits ?? 0;
  const uniqueGoldenFileHits = result.uniqueGoldenFileHits ?? goldenFileHits;
  const goldenSymbolHits = result.goldenSymbolHits ?? 0;
  const relevantTermHits = result.relevantTermHits ?? 0;
  const fileRecall = goldenFileHits / Math.max(1, goldenFiles.length);
  const symbolRecall = goldenSymbols.length > 0 ? goldenSymbolHits / Math.max(1, goldenSymbols.length) : 0;
  const termRecall = relevantTermHits / Math.max(1, relevantTerms.length);
  const retrieval = clamp((fileRecall + Math.max(symbolRecall, termRecall) + (result.topHit ?? 0)) / 3);
  const densityRaw = densityRawFor(result);
  const densityDenominator = context.maxDensityRawForTask ?? densityRaw;
  const density = densityDenominator > 0 ? clamp(densityRaw / densityDenominator) : 0;
  const bestLatency = context.bestMedianLatencyMs ?? result.bestMedianLatencyMs ?? 0;
  const runtime = bestLatency > 0 && result.medianLatencyMs > 0 ? clamp(bestLatency / result.medianLatencyMs) : 0;
  const depth = clamp(
    (uniqueGoldenFileHits / Math.max(1, goldenFiles.length) * 0.5) +
    (Math.min(result.structuralHits ?? 0, 6) / 6 * 0.5)
  );
  const freshness = scoreFreshness(result, task);
  const capability = clamp((result.taskCapabilityHits ?? 0) / Math.max(1, result.taskCapabilityExpected ?? 1));
  return { retrieval, density, runtime, depth, freshness, capability };
}

export function scoreFreshness(result, task) {
  if (task.id === 'freshness-manifest') {
    const freshnessTermsExpected = result.freshnessTermsExpected ?? 4;
    return clamp(
      0.5 * ((result.freshnessTermHits ?? 0) / Math.max(1, freshnessTermsExpected)) +
      0.5 * (Math.min(result.freshnessCooccurrenceHits ?? 0, 4) / 4)
    );
  }
  if (task.id === 'isolated-update-freshness') {
    return clamp(
      0.5 * (result.updateStatusHit ?? 0) +
      0.25 * (result.updatedResultEvidenceHit ?? 0) +
      0.25 * (result.manifestTransitionHit ?? 0)
    );
  }
  const expectedCapabilities = task.expectedCapabilities?.[result.arm] ?? [];
  const relevantTerms = task.relevantTerms ?? [];
  if (!String(result.arm ?? '').startsWith('zincgraph')) {
    return 0;
  }
  const freshnessRelevant = expectedCapabilities.includes('freshness') ||
    relevantTerms.some((term) => /fresh|stale|pending|manifest|sync|changed file|vector/i.test(String(term)));
  if (freshnessRelevant) {
    const expectedTerms = new Set([
      ...relevantTerms.filter((term) => /fresh|stale|pending|manifest|sync|changed file|vector/i.test(String(term))),
      ...FRESHNESS_TERMS
    ]);
    const hits = countHits([...expectedTerms], String(result.outputPreview ?? '').toLowerCase());
    return clamp(hits / Math.max(1, Math.min(4, expectedTerms.size)));
  }
  return 0;
}

export function densityRawFor(result) {
  const relevanceHits = (result.goldenFileHits ?? 0) + (result.goldenSymbolHits ?? 0) + (result.relevantTermHits ?? 0);
  return relevanceHits / Math.max((result.outputBytes ?? 0) / 1024, 0.5);
}

export function zeroScores() {
  return { retrieval: 0, density: 0, runtime: 0, depth: 0, freshness: 0, capability: 0 };
}

export function weightedTotal(dimensionScores, weights = WEIGHTS) {
  return round2(Object.entries(weights).reduce((sum, [key, weight]) => sum + ((dimensionScores[key] ?? 0) * weight), 0));
}

export function summarizeArmScores(tasks, includeDelegatedInWinner = false) {
  const arms = {};
  for (const arm of new Set(tasks.map((task) => task.arm))) {
    const armTasks = tasks.filter((task) => task.arm === arm && task.applicable !== false);
    const denominator = armTasks.length || 1;
    const dimensionScores = Object.fromEntries(DIMENSION_SCORE_KEYS.map((key) => [
      key,
      round4(armTasks.reduce((sum, task) => sum + (task.scores?.[key] ?? 0), 0) / denominator)
    ]));
    arms[arm] = {
      totalScore: qualityOnlyTotal(dimensionScores),
      diagnosticTotalScore: weightedTotal(dimensionScores),
      dimensionScores,
      raw: {
        medianLatencyMs: round2(median(armTasks.map((task) => task.medianLatencyMs).filter(Number.isFinite))),
        totalOutputBytes: armTasks.reduce((sum, task) => sum + (task.outputBytes ?? 0), 0),
        tasksPassed: armTasks.filter((task) => task.status === 0).length,
        applicableTasks: armTasks.length
      }
    };
  }
  const winnerPool = Object.entries(arms).filter(([arm]) => includeDelegatedInWinner || arm !== DELEGATED_ARM);
  const winner = winnerPool.sort((a, b) => b[1].totalScore - a[1].totalScore)[0]?.[0] ?? null;
  const diagnosticWinner = [...winnerPool].sort((a, b) => (b[1].diagnosticTotalScore ?? 0) - (a[1].diagnosticTotalScore ?? 0))[0]?.[0] ?? null;
  return { arms, winner, diagnosticWinner };
}

export function summarizeQualityOnlyArms(arms) {
  const qualityArms = Object.fromEntries(Object.entries(arms).map(([name, arm]) => [
    name,
    {
      totalScore: qualityOnlyTotal(arm.dimensionScores),
      dimensionScores: Object.fromEntries(Object.keys(QUALITY_WEIGHTS).map((key) => [key, arm.dimensionScores[key] ?? 0])),
      note: 'Excludes density and runtime; density/output and runtime/CLI latency remain diagnostic-only.'
    }
  ]));
  const winner = Object.entries(qualityArms).sort((left, right) => right[1].totalScore - left[1].totalScore)[0]?.[0] ?? null;
  return { weights: QUALITY_WEIGHTS, arms: qualityArms, winner };
}

export function qualityOnlyTotal(dimensionScores, weights = QUALITY_WEIGHTS) {
  const denominator = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  if (denominator <= 0) return 0;
  const weighted = Object.entries(weights)
    .reduce((sum, [key, weight]) => sum + ((dimensionScores[key] ?? 0) * weight), 0);
  return round2((weighted / denominator) * 100);
}

export function summarizeTaskCategories(tasks) {
  const categories = new Map();
  for (const task of tasks) {
    const category = task.category ?? 'uncategorized';
    const current = categories.get(category) ?? {
      taskIds: new Set(),
      arms: new Set(),
      totalResults: 0,
      applicableResults: 0,
      passedResults: 0
    };
    current.taskIds.add(task.id);
    if (task.arm) current.arms.add(task.arm);
    current.totalResults += 1;
    if (task.applicable !== false) {
      current.applicableResults += 1;
      if (task.status === 0) {
        current.passedResults += 1;
      }
    }
    categories.set(category, current);
  }
  return Object.fromEntries([...categories.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([category, value]) => [
    category,
    {
      taskIds: [...value.taskIds].sort(),
      arms: [...value.arms].sort(),
      totalResults: value.totalResults,
      applicableResults: value.applicableResults,
      passedResults: value.passedResults
    }
  ]));
}

export function createReport(summary) {
  const armRows = Object.entries(summary.arms)
    .map(([name, arm]) => `| ${name} | ${arm.totalScore.toFixed(2)} | ${(arm.diagnosticTotalScore ?? arm.totalScore).toFixed(2)} | ${fmtScore(arm.dimensionScores.retrieval)} | ${fmtScore(arm.dimensionScores.depth)} | ${fmtScore(arm.dimensionScores.freshness)} | ${fmtScore(arm.dimensionScores.capability)} | ${fmtScore(arm.dimensionScores.density)} | ${fmtScore(arm.dimensionScores.runtime)} | ${arm.raw.medianLatencyMs} | ${arm.raw.totalOutputBytes} |`)
    .join('\n');
  const taskRows = summary.tasks
    .filter((task) => task.applicable !== false)
    .map((task) => `| ${task.id} | ${task.category ?? 'uncategorized'} | ${task.arm} | ${task.status} | ${task.medianLatencyMs} | ${task.outputBytes} | ${task.goldenFileHits}/${task.goldenFiles.length} | ${task.goldenSymbolHits}/${task.goldenSymbols.length} | ${task.relevantTermHits}/${task.relevantTerms.length} | ${fmtScore(task.scores.retrieval)} | ${fmtScore(task.scores.density)} |`)
    .join('\n');
  const categoryCoverage = summary.taskCategories ?? summarizeTaskCategories(summary.tasks ?? []);
  const categoryRows = Object.entries(categoryCoverage)
    .map(([category, value]) => `| ${category} | ${value.taskIds.length} | ${value.taskIds.join(', ')} | ${value.applicableResults} | ${value.passedResults} |`)
    .join('\n');
  const normalizationRows = Object.entries(summary.normalization ?? {})
    .map(([taskId, baseline]) => `| ${taskId} | ${baseline.densityDenominator} | ${baseline.bestMedianLatencyMs} | ${(baseline.applicablePrimaryArms ?? []).join(', ') || 'none'} | ${(baseline.successfulPrimaryArms ?? []).join(', ') || 'none'} |`)
    .join('\n');
  const qualityOnly = summary.qualityOnly ?? summarizeQualityOnlyArms(summary.arms);
  const primaryWinner = summary.winner.byComparison ?? summary.winner.byTotal ?? qualityOnly.winner;
  const diagnosticWinner = summary.winner.diagnosticByLegacyTotal ?? summary.winner.byDiagnosticTotal ?? null;
  const qualityRows = Object.entries(qualityOnly.arms)
    .map(([name, arm]) => `| ${name} | ${arm.totalScore.toFixed(2)} | ${fmtScore(arm.dimensionScores.retrieval)} | ${fmtScore(arm.dimensionScores.depth)} | ${fmtScore(arm.dimensionScores.freshness)} | ${fmtScore(arm.dimensionScores.capability)} |`)
    .join('\n');
  const warnings = summary.preflight.warnings.length ? summary.preflight.warnings.map((warning) => `- ${warning}`).join('\n') : '- none';
  const proof = summary.nonMutationProof;
  const benchmarkPool = summary.benchmarkPool ?? null;
  const proofLines = [
    `- scope: current repository state roots only (${(proof.watchedRoots ?? ['.codegraph', '.zincgraph']).join(', ')}); this is not a whole-repo or whole-filesystem immutability claim`,
    `- passed: ${proof.passed}`,
    `- changedPaths: ${proof.changedPaths.length ? proof.changedPaths.join(', ') : 'none'}`,
    `- sqliteVolatilePaths: ${proof.sqliteVolatilePaths.length ? proof.sqliteVolatilePaths.join(', ') : 'none'}`
  ].join('\n');
  const benchmarkPoolLines = benchmarkPool
    ? [
        `- schemaVersion: ${benchmarkPool.schemaVersion}`,
        `- scoreModelVersion: ${benchmarkPool.scoreModelVersion}`,
        `- repoCount: ${benchmarkPool.repoCount}`,
        `- tiers: core=${benchmarkPool.tierCounts.core}, extended=${benchmarkPool.tierCounts.extended}, stress=${benchmarkPool.tierCounts.stress}`,
        `- caseCounts: core=${benchmarkPool.caseCounts.core}, extended=${benchmarkPool.caseCounts.extended}, stress=${benchmarkPool.caseCounts.stress}`
      ].join('\n')
    : '- not loaded';
  return `# CodeGraph vs Zincgraph Local Benchmark Report

- generatedAt: ${summary.generatedAt}
- confidence: ${summary.confidence}
- sourceProjectPath: ${summary.projectPath}
- benchmarkProjectPath: ${summary.benchmarkProjectPath}
- runsPerCommand: ${summary.runsPerCommand}
- primaryWinner: ${primaryWinner}
- diagnosticLegacyWinner: ${diagnosticWinner ?? 'n/a'}

## Benchmark score by arm

Default CLI output size/density and CLI latency/runtime are **not counted** in the benchmark comparison score. They are shown only as diagnostics.

| Arm | Benchmark total | Legacy diagnostic total | Retrieval | Depth | Freshness | Capability | Diagnostic density | Diagnostic runtime | Median latency ms | Output bytes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${armRows}

## Quality-only score by arm

User-corrected comparison: density/output and runtime/CLI latency are diagnostic-only and excluded from benchmark scoring.

| Arm | Quality-only total | Retrieval | Depth | Freshness | Capability |
|---|---:|---:|---:|---:|---:|
${qualityRows}

Quality-only winner: ${qualityOnly.winner}

## Benchmark category coverage

| Category | Distinct tasks | Task ids | Applicable arm results | Passed arm results |
|---|---:|---|---:|---:|
${categoryRows || '| none | 0 | none | 0 | 0 |'}

## Raw task metrics

| Task | Category | Arm | Status | Median ms | Output bytes | File hits | Symbol hits | Term hits | Retrieval | Density |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
${taskRows}

## Normalization baselines

| Task | Density denominator | Best median latency ms | Applicable primary arms | Successful primary arms |
|---|---:|---:|---|---|
${normalizationRows || '| none | 0 | 0 | none | none |'}

## Interpretation

This is a **local deterministic benchmark**, not a universal headless-agent benchmark. It measures the installed CodeGraph and Zincgraph surfaces on a disposable copy of this repository, with exact scoring formulas from the PRD. CodeGraph remains the primary graph-speed baseline. Zincgraph can earn additional value through fusion, freshness, dedup/review, compression feedback, semantic routing, cross-module context, and wrapper capability. Per the user-corrected comparison, runtime/CLI latency and density/output size are diagnostic-only and excluded from the benchmark comparison score.

## Benchmark Pool Contract

${benchmarkPoolLines}

## Preflight warnings

${warnings}

## Scoped Non-mutation proof for current repository state

${proofLines}

## Optional external agent A/B

The external agent A/B benchmark was not run in this local suite. Running it requires cloned/indexed corpora and paid/headless agent credentials. See \`bench/agent-eval/README.md\` for the extension path based on the existing CodeGraph benchmark.
`;
}

function fmtScore(value) {
  return ((value ?? 0) * 100).toFixed(1);
}

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

function round4(value) {
  return Number.isFinite(value) ? Math.round(value * 10000) / 10000 : 0;
}

function sumTierCases(repos, tier) {
  return repos
    .filter((repo) => repo.tier === tier)
    .reduce((total, repo) => total + (repo.cases?.count ?? 0), 0);
}

function median(values) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) return 0;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

export function fingerprintRoots(projectPath, roots = ['.codegraph', '.zincgraph']) {
  const out = {};
  for (const root of roots) {
    const absolute = join(projectPath, root);
    if (!existsSync(absolute)) {
      out[root] = { exists: false, size: 0, mtimeMs: 0 };
      continue;
    }
    collectFingerprints(projectPath, absolute, out);
  }
  return out;
}

function collectFingerprints(projectPath, absolutePath, out) {
  const stat = statSync(absolutePath);
  const rel = relative(projectPath, absolutePath).split(sep).join('/');
  if (stat.isDirectory()) {
    out[rel || '.'] = { exists: true, directory: true, size: 0, mtimeMs: Math.round(stat.mtimeMs) };
    for (const child of readdirSync(absolutePath).sort()) {
      collectFingerprints(projectPath, join(absolutePath, child), out);
    }
    return;
  }
  const entry = {
    exists: true,
    file: stat.isFile(),
    socket: stat.isSocket(),
    symbolicLink: stat.isSymbolicLink?.() ?? false,
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs)
  };
  if (stat.isFile() && stat.size <= 5 * 1024 * 1024) {
    entry.sha256 = createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
  }
  out[rel] = entry;
}

export function diffFingerprints(before, after) {
  const changedPaths = [];
  const sqliteVolatilePaths = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    const left = before[key];
    const right = after[key];
    if (JSON.stringify(left) === JSON.stringify(right)) continue;
    if (isSqliteVolatilePath(key) && left && right && left.exists && right.exists && left.size === right.size && left.sha256 === right.sha256) {
      sqliteVolatilePaths.push(key);
      continue;
    }
    changedPaths.push(key);
  }
  return { changedPaths, sqliteVolatilePaths };
}

function isSqliteVolatilePath(path) {
  return /\.codegraph\/.*\.(db-wal|db-shm)$/.test(path) || /\.zincgraph\/.*\.(sqlite-wal|sqlite-shm)$/.test(path);
}

function parseArgs(argv) {
  const args = { project: process.cwd(), runs: DEFAULT_RUNS, keepTemp: false, includeDelegatedInWinner: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--project') args.project = argv[++i] ?? args.project;
    else if (arg === '--runs') args.runs = normalizeRunCount(argv[++i] ?? String(DEFAULT_RUNS));
    else if (arg === '--keep-temp') args.keepTemp = true;
    else if (arg === '--include-delegated-in-winner') args.includeDelegatedInWinner = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node bench/compare.mjs [--project <path>] [--runs <n>] [--keep-temp] [--include-delegated-in-winner]');
      process.exit(0);
    }
  }
  return args;
}

export function normalizeRunCount(value) {
  const parsed = Number.parseInt(String(value ?? DEFAULT_RUNS), 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : DEFAULT_RUNS;
}

export function createRunSlots(runs) {
  return Array.from({ length: normalizeRunCount(runs) }, (_, index) => index);
}

export function loadBenchmarkPool(poolPath = BENCHMARK_POOL_PATH) {
  const parsed = JSON.parse(readFileSync(poolPath, 'utf8'));
  const repos = Array.isArray(parsed.repos) ? parsed.repos : [];
  return {
    path: poolPath,
    schemaVersion: parsed.schemaVersion ?? null,
    scoreModelVersion: parsed.scoreModel?.version ?? null,
    repoCount: repos.length,
    tierCounts: {
      core: repos.filter((repo) => repo.tier === 'core').length,
      extended: repos.filter((repo) => repo.tier === 'extended').length,
      stress: repos.filter((repo) => repo.tier === 'stress').length
    },
    caseCounts: {
      core: sumTierCases(repos, 'core'),
      extended: sumTierCases(repos, 'extended'),
      stress: sumTierCases(repos, 'stress')
    },
    raw: parsed
  };
}

async function main() {
  const options = parsePoolBenchmarkArgs(process.argv.slice(2));
  const result = await runPoolBenchmark(options);
  console.log(JSON.stringify(result.summary, null, 2));
  console.log(`\n${result.report}`);
  if (!result.summary.accepted) {
    process.exitCode = 1;
  }
}

export function runPreflight(projectPath, paths = {}) {
  const zincgraphCli = paths.zincgraphCli ?? ZINCGRAPH_CLI;
  const codegraphBin = paths.codegraphBin ?? CODEGRAPH_BIN;
  const warnings = [];
  if (!existsSync(zincgraphCli)) warnings.push(`Missing dist CLI: ${zincgraphCli}. Run npm run build first.`);
  if (!existsSync(codegraphBin)) warnings.push(`Missing CodeGraph binary: ${codegraphBin}`);
  if (!existsSync(join(projectPath, '.codegraph/codegraph.db'))) {
    warnings.push('Missing current repo .codegraph/codegraph.db. Run zincgraph init or codegraph init before comparing.');
  }
  const zincgraphState = existsSync(join(projectPath, '.zincgraph/fusion.sqlite')) ? 'present' : 'missing';
  if (zincgraphState === 'missing') {
    warnings.push('Current repo .zincgraph/fusion.sqlite is missing; runner will not vectorize current repo automatically.');
  }
  return { ok: warnings.filter((warning) => warning.startsWith('Missing dist') || warning.startsWith('Missing CodeGraph') || warning.startsWith('Missing current repo .codegraph')).length === 0, warnings, zincgraphState };
}

async function prepareBenchmarkProject(sourceProjectPath, resultDir) {
  const workspace = await mkdtemp(join(tmpdir(), 'zincgraph-benchmark-project-'));
  for (const name of ['src', 'tests', 'docs']) {
    const from = join(sourceProjectPath, name);
    if (existsSync(from)) cpSync(from, join(workspace, name), { recursive: true });
  }
  for (const name of ['package.json', 'tsconfig.json', 'vitest.config.ts']) {
    const from = join(sourceProjectPath, name);
    if (existsSync(from)) cpSync(from, join(workspace, name));
  }
  const init = runCommand([...CODEGRAPH_COMMAND, 'init', workspace], ROOT, 120_000);
  if (init.status !== 0) {
    throw new Error(`Failed to initialize CodeGraph benchmark workspace: ${init.stderr || init.stdout}`);
  }
  const vectorize = runCommand(['node', 'dist/cli.js', 'vectorize', workspace], ROOT, 120_000);
  if (vectorize.status !== 0) {
    writeFileSync(join(resultDir, 'benchmark-workspace-vectorize-warning.log'), vectorize.stdout + vectorize.stderr);
  }
  return workspace;
}

export async function runBenchmarkTask(task, arm, commandSpec, projectPath, runs) {
  const commandList = Array.isArray(commandSpec[0]) ? commandSpec : [commandSpec];
  const runRecords = [];
  for (const index of createRunSlots(runs)) {
    const sequenceScoringOutput = [];
    const sequenceDiagnosticOutput = [];
    const t0 = performance.now();
    let status = 0;
    for (const command of commandList) {
      const expanded = expandCommand(command, projectPath);
      const result = runCommand(expanded, ROOT, 90_000);
      status = result.status;
      const rawOutput = `${result.stdout}${result.stderr}`;
      sequenceScoringOutput.push(rawOutput);
      sequenceDiagnosticOutput.push(`$ ${expanded.join(' ')}\n${rawOutput}`);
      if (result.status !== 0) break;
    }
    const t1 = performance.now();
    runRecords.push({
      index,
      status,
      elapsedMs: t1 - t0,
      scoringOutput: sequenceScoringOutput.join('\n'),
      diagnosticOutput: sequenceDiagnosticOutput.join('\n')
    });
  }
  const aggregate = aggregateRunRecords(runRecords);
  return attachRunAggregation(
    analyzeOutput({
      task,
      arm,
      commandSpec,
      status: aggregate.status,
      output: aggregate.scoringOutput,
      medianLatencyMs: aggregate.medianLatencyMs
    }),
    aggregate
  );
}

export function aggregateRunRecords(records) {
  const runs = records.map((record, fallbackIndex) => {
    const scoringOutput = String(record.scoringOutput ?? record.output ?? '');
    const diagnosticOutput = String(record.diagnosticOutput ?? record.output ?? scoringOutput);
    const status = Number.isFinite(record.status) ? record.status : 1;
    const elapsedMs = Number.isFinite(record.elapsedMs) ? record.elapsedMs : 0;
    const scoringOutputBytes = Buffer.byteLength(scoringOutput);
    const diagnosticOutputBytes = Buffer.byteLength(diagnosticOutput);
    return {
      index: Number.isInteger(record.index) ? record.index : fallbackIndex,
      status,
      elapsedMs,
      scoringOutput,
      diagnosticOutput,
      scoringOutputBytes,
      diagnosticOutputBytes,
      outputBytes: scoringOutputBytes,
      outputPreview: diagnosticOutput.slice(0, OUTPUT_PREVIEW_BYTES),
      scoringOutputPreview: scoringOutput.slice(0, OUTPUT_PREVIEW_BYTES),
      errorPreview: status === 0 ? null : diagnosticOutput.slice(0, OUTPUT_PREVIEW_BYTES)
    };
  });
  const successfulRuns = runs.filter((run) => run.status === 0);
  const selectedRun = selectScoringRun(successfulRuns);
  const failureCount = runs.length - successfulRuns.length;
  return {
    status: runs.length > 0 && failureCount === 0 ? 0 : (runs.find((run) => run.status !== 0)?.status ?? 1),
    failureCount,
    successfulRunCount: successfulRuns.length,
    medianLatencyMs: round2(median(runs.map((run) => run.elapsedMs))),
    selectedRunIndex: selectedRun?.index ?? null,
    scoringOutput: selectedRun?.scoringOutput ?? '',
    diagnosticOutputBytes: runs.reduce((sum, run) => sum + run.diagnosticOutputBytes, 0),
    runs: runs.map(({ scoringOutput, ...run }) => ({
      ...run,
      elapsedMs: round2(run.elapsedMs)
    }))
  };
}

export function persistDiagnosticTranscripts(tasks, resultDir) {
  const transcriptDirName = 'diagnostic-transcripts';
  const transcriptDir = join(resultDir, transcriptDirName);
  let count = 0;
  for (const task of tasks) {
    if (task.applicable === false || !Array.isArray(task.runs)) continue;
    for (const run of task.runs) {
      const diagnosticOutput = run.diagnosticOutput;
      if (diagnosticOutput === undefined) continue;
      mkdirSync(transcriptDir, { recursive: true });
      const fileName = `${safeFileSegment(task.id)}--${safeFileSegment(task.arm)}--run-${run.index}.txt`;
      const relativePath = `${transcriptDirName}/${fileName}`;
      writeFileSync(join(resultDir, relativePath), diagnosticOutput);
      run.diagnosticTranscriptPath = relativePath;
      delete run.diagnosticOutput;
      count += 1;
    }
  }
  return {
    directory: transcriptDirName,
    count,
    note: 'Full diagnostic transcripts include echoed commands for replay; scoring fields use raw stdout/stderr only.'
  };
}

function safeFileSegment(value) {
  return String(value ?? 'unknown').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

export function selectScoringRun(successfulRuns) {
  if (!successfulRuns.length) return null;
  const medianLatency = median(successfulRuns.map((run) => run.elapsedMs));
  return [...successfulRuns].sort((a, b) => {
    const latencyDelta = Math.abs(a.elapsedMs - medianLatency) - Math.abs(b.elapsedMs - medianLatency);
    if (latencyDelta !== 0) return latencyDelta;
    const indexDelta = a.index - b.index;
    if (indexDelta !== 0) return indexDelta;
    return (a.scoringOutputBytes ?? a.outputBytes ?? Buffer.byteLength(String(a.scoringOutput ?? a.output ?? ''))) -
      (b.scoringOutputBytes ?? b.outputBytes ?? Buffer.byteLength(String(b.scoringOutput ?? b.output ?? '')));
  })[0];
}

function attachRunAggregation(result, aggregate) {
  return {
    ...result,
    runs: aggregate.runs,
    failureCount: aggregate.failureCount,
    successfulRunCount: aggregate.successfulRunCount,
    selectedRunIndex: aggregate.selectedRunIndex,
    diagnosticOutputBytes: aggregate.diagnosticOutputBytes
  };
}

export async function runIsolatedUpdateTask(arm, task, runs, runner = runSingleIsolatedUpdateRun) {
  const runRecords = [];
  for (const index of createRunSlots(runs)) {
    runRecords.push(await runner(arm, task, index));
  }
  const aggregate = aggregateRunRecords(runRecords);
  const analyzed = attachRunAggregation(
    analyzeOutput({
      task,
      arm,
      commandSpec: arm === 'codegraph' ? ['isolated-codegraph-update'] : ['isolated-zincgraph-update'],
      status: aggregate.status,
      output: aggregate.scoringOutput,
      medianLatencyMs: aggregate.medianLatencyMs
    }),
    aggregate
  );
  analyzed.updateStatusHit = aggregate.status === 0 ? 1 : 0;
  analyzed.updatedResultEvidenceHit = aggregate.scoringOutput.toLowerCase().includes('addedlocalbenchmarkfunction') ? 1 : 0;
  analyzed.manifestTransitionHit = arm === 'zincgraph-fusion' && /"fresh"|fresh|transition|transitions/i.test(aggregate.scoringOutput) ? 1 : 0;
  return analyzed;
}

async function runSingleIsolatedUpdateRun(arm, task, index = 0) {
  const fixture = await mkdtemp(join(tmpdir(), `zincgraph-${arm}-update-`));
  const srcDir = join(fixture, 'src');
  mkdirSync(srcDir, { recursive: true });
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'zincgraph-benchmark-fixture', type: 'module' }, null, 2));
  await writeFile(join(srcDir, 'changed.ts'), 'export function existingLocalBenchmarkFunction() { return "old"; }\n');
  const diagnosticOutput = [];
  const scoringOutput = [];
  let status = 0;
  try {
    const setupStart = performance.now();
    let updateStart = setupStart;
    const init = runCommand([...CODEGRAPH_COMMAND, 'init', fixture], ROOT, 90_000);
    diagnosticOutput.push(init.stdout, init.stderr);
    status = init.status;
    if (status === 0 && arm === 'zincgraph-fusion') {
      const vectorize = runCommand(['node', 'dist/cli.js', 'vectorize', fixture], ROOT, 90_000);
      diagnosticOutput.push(vectorize.stdout, vectorize.stderr);
      status = vectorize.status;
    }
    if (status === 0) {
      updateStart = performance.now();
      await appendFile(join(srcDir, 'changed.ts'), 'export function addedLocalBenchmarkFunction() { return "new"; }\n');
      const syncCommand = arm === 'codegraph'
        ? [...CODEGRAPH_COMMAND, 'sync', fixture]
        : ['node', 'dist/cli.js', 'auto-sync', fixture, '--file', 'src/changed.ts'];
      const sync = runCommand(syncCommand, ROOT, 90_000);
      diagnosticOutput.push(sync.stdout, sync.stderr);
      scoringOutput.push(sync.stdout, sync.stderr);
      status = sync.status;
      const queryCommand = arm === 'codegraph'
        ? [...CODEGRAPH_COMMAND, 'query', 'addedLocalBenchmarkFunction', '-p', fixture, '--json']
        : ['node', 'dist/cli.js', 'search', 'addedLocalBenchmarkFunction', '-p', fixture, '--topk', '5'];
      const query = runCommand(queryCommand, ROOT, 90_000);
      diagnosticOutput.push(query.stdout, query.stderr);
      scoringOutput.push(query.stdout, query.stderr);
      if (status === 0) status = query.status;
    }
    const t1 = performance.now();
    return {
      index,
      status,
      elapsedMs: t1 - updateStart,
      scoringOutput: scoringOutput.join('\n'),
      diagnosticOutput: diagnosticOutput.join('\n')
    };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function notApplicableTask(task, arm) {
  return {
    id: task.id,
    category: task.category ?? 'uncategorized',
    arm,
    applicable: false,
    status: null,
    command: [],
    medianLatencyMs: 0,
    outputBytes: 0,
    goldenFiles: task.goldenFiles,
    goldenSymbols: task.goldenSymbols,
    relevantTerms: task.relevantTerms,
    goldenFileHits: 0,
    uniqueGoldenFileHits: 0,
    goldenSymbolHits: 0,
    relevantTermHits: 0,
    topHit: 0,
    structuralHits: 0,
    freshnessTermHits: 0,
    freshnessCooccurrenceHits: 0,
    updateStatusHit: 0,
    updatedResultEvidenceHit: 0,
    manifestTransitionHit: 0,
    capabilityTags: [],
    expectedCapabilityTags: [],
    taskCapabilityHits: 0,
    taskCapabilityExpected: 1,
    runs: [],
    failureCount: 0,
    successfulRunCount: 0,
    selectedRunIndex: null,
    diagnosticOutputBytes: 0,
    scores: zeroScores(),
    error: 'not_applicable'
  };
}

export function analyzeOutput({ task, arm, commandSpec, status, output, medianLatencyMs }) {
  const lower = output.toLowerCase();
  const top = output.slice(0, Math.max(1, Math.floor(output.length * 0.25))).toLowerCase();
  const goldenFiles = task.goldenFiles ?? [];
  const goldenSymbols = task.goldenSymbols ?? [];
  const relevantTerms = task.relevantTerms ?? [];
  const fileHits = countHits(goldenFiles, lower);
  const symbolHits = countHits(goldenSymbols, lower);
  const termHits = countHits(relevantTerms, lower);
  const topHit = [...goldenFiles, ...goldenSymbols, ...relevantTerms].some((item) => top.includes(String(item).toLowerCase())) ? 1 : 0;
  const expectedCapabilityTags = task.expectedCapabilities?.[arm] ?? [];
  const capabilityTags = status === 0 ? [...expectedCapabilityTags] : [];
  const freshnessTermHits = task.id === 'freshness-manifest' ? countFreshnessTermHits(output) : 0;
  const freshnessCooccurrenceHits = task.id === 'freshness-manifest' ? countFreshnessCooccurrenceHits(output) : 0;
  return {
    id: task.id,
    category: task.category ?? 'uncategorized',
    arm,
    applicable: true,
    status,
    command: flattenCommandSpec(commandSpec).map((part) => part === '$PROJECT' ? 'PROJECT' : String(part)),
    medianLatencyMs,
    outputBytes: Buffer.byteLength(output),
    goldenFiles,
    goldenSymbols,
    relevantTerms,
    goldenFileHits: fileHits,
    uniqueGoldenFileHits: fileHits,
    goldenSymbolHits: symbolHits,
    relevantTermHits: termHits,
    topHit,
    structuralHits: countHits(STRUCTURAL_TERMS, lower),
    freshnessTermHits,
    freshnessTermsExpected: 4,
    freshnessCooccurrenceHits,
    updateStatusHit: 0,
    updatedResultEvidenceHit: 0,
    manifestTransitionHit: 0,
    capabilityTags,
    expectedCapabilityTags,
    taskCapabilityHits: capabilityTags.filter((tag) => expectedCapabilityTags.includes(tag)).length,
    taskCapabilityExpected: Math.max(1, expectedCapabilityTags.length),
    densityRaw: 0,
    scores: zeroScores(),
    outputPreview: output.slice(0, OUTPUT_PREVIEW_BYTES),
    error: status === 0 ? null : output.slice(0, OUTPUT_PREVIEW_BYTES)
  };
}

function countHits(items, lowerOutput) {
  return new Set(items.filter((item) => lowerOutput.includes(String(item).toLowerCase()))).size;
}

export function countFreshnessTermHits(output) {
  return FRESHNESS_TERMS.filter((term) => containsExactTerm(output, term)).length;
}

export function countFreshnessCooccurrenceHits(output) {
  let maxHits = 0;
  for (const unit of extractFreshnessEvidenceUnits(output)) {
    const hits = countFreshnessTermHits(unit);
    if (hits >= 2) maxHits = Math.max(maxHits, hits);
  }
  return maxHits;
}

function containsExactTerm(output, term) {
  return new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i').test(output);
}

function extractFreshnessEvidenceUnits(output) {
  const text = String(output ?? '');
  const units = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  try {
    collectJsonEvidenceUnits(JSON.parse(text), units);
  } catch {
    // Non-JSON command output is already represented by line-level evidence units.
  }
  return units;
}

function collectJsonEvidenceUnits(value, units) {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonEvidenceUnits(item, units);
    return;
  }
  if (value && typeof value === 'object') {
    units.push(JSON.stringify(value));
    for (const item of Object.values(value)) collectJsonEvidenceUnits(item, units);
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function applyNormalizedScores(results) {
  const normalization = {};
  for (const task of TASKS) {
    const primary = results.filter((result) => result.id === task.id && PRIMARY_ARMS.includes(result.arm) && result.applicable !== false);
    const successfulPrimary = primary.filter((result) => result.status === 0);
    // If no primary arm succeeds, comparable density/runtime baselines are intentionally absent:
    // failed primary data remains diagnostic-only and sidecar/non-primary arms do not create a primary baseline.
    const densityMax = Math.max(0, ...successfulPrimary.map(densityRawFor));
    const latencyMin = Math.min(...successfulPrimary.filter((result) => result.medianLatencyMs > 0).map((result) => result.medianLatencyMs));
    const baseline = {
      densityDenominator: round4(densityMax),
      bestMedianLatencyMs: round2(Number.isFinite(latencyMin) ? latencyMin : 0),
      primaryArms: PRIMARY_ARMS,
      applicablePrimaryArms: primary.map((result) => result.arm),
      successfulPrimaryArms: successfulPrimary.map((result) => result.arm)
    };
    normalization[task.id] = baseline;
    for (const result of results.filter((item) => item.id === task.id && item.applicable !== false)) {
      result.densityRaw = densityRawFor(result);
      result.normalization = baseline;
      result.scores = scoreTask(result, task, {
        maxDensityRawForTask: densityMax,
        bestMedianLatencyMs: Number.isFinite(latencyMin) ? latencyMin : 0
      });
    }
  }
  return normalization;
}

function flattenCommandSpec(spec) {
  if (!Array.isArray(spec)) return [];
  if (Array.isArray(spec[0])) return spec.flat();
  return spec;
}

function expandCommand(command, projectPath) {
  return command.flatMap((part) => {
    if (part === '$PROJECT') return [projectPath];
    if (part === 'dist/cli.js') return [ZINCGRAPH_CLI];
    if (part === 'node_modules/.bin/codegraph') return CODEGRAPH_COMMAND;
    return [part];
  });
}

export function createSpawnOptions(cwd, timeout = 60_000) {
  return {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: 50 * 1024 * 1024,
    shell: false
  };
}

function runCommand(command, cwd, timeout = 60_000) {
  const t0 = performance.now();
  const result = spawnSync(command[0], command.slice(1), createSpawnOptions(cwd, timeout));
  const t1 = performance.now();
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
    elapsedMs: t1 - t0
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
