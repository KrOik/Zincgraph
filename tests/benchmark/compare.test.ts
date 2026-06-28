import { describe, expect, test } from 'vitest';
import {
  TASKS,
  TASK_CATEGORIES,
  clamp,
  scoreTask,
  scoreFreshness,
  summarizeArmScores,
  createReport,
  fingerprintRoots,
  diffFingerprints,
  zeroScores,
  densityRawFor,
  aggregateRunRecords,
  analyzeOutput,
  applyNormalizedScores,
  persistDiagnosticTranscripts,
  countFreshnessCooccurrenceHits,
  countFreshnessTermHits,
  createRunSlots,
  loadBenchmarkPool,
  createSpawnOptions,
  runIsolatedUpdateTask,
  runPreflight,
  summarizeQualityOnlyArms,
  qualityOnlyTotal,
  summarizeTaskCategories
} from '../../bench/compare.mjs';
import { evaluateBenchmarkGoal } from '../../bench/goal-gate.mjs';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const approx = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 2);

describe('benchmark scorer', () => {
  test('benchmark task set expands meaningful categories without increasing default runs', () => {
    const categories = new Set(TASKS.map((task: any) => task.category));
    expect([...categories]).toEqual(expect.arrayContaining([
      TASK_CATEGORIES.GRAPH_TOPOLOGY,
      TASK_CATEGORIES.GRAPH_NAVIGATION,
      TASK_CATEGORIES.TEST_IMPACT,
      TASK_CATEGORIES.SEMANTIC_INTENT,
      TASK_CATEGORIES.COMPRESSION_FEEDBACK,
      TASK_CATEGORIES.CROSS_MODULE
    ]));
    expect(TASKS.map((task: any) => task.id)).toEqual(expect.arrayContaining([
      'impact-autosync-topology',
      'graph-navigation-autosync-pipeline',
      'affected-review-command-tests',
      'semantic-intent-routing',
      'compression-feedback-cycle',
      'cross-module-freshness-vector-flow'
    ]));
    const graphNavigationTask = TASKS.find((task: any) => task.id === 'graph-navigation-autosync-pipeline') as any;
    expect(graphNavigationTask.commands.codegraph).toHaveLength(3);
    expect(graphNavigationTask.commands['zincgraph-fusion']).toHaveLength(3);
    const affectedTask = TASKS.find((task: any) => task.id === 'affected-review-command-tests') as any;
    expect(affectedTask.commands.codegraph).toEqual([
      'node_modules/.bin/codegraph',
      'affected',
      'src/behavior/review-command.ts',
      '-p',
      '$PROJECT'
    ]);
    expect(affectedTask.commands['zincgraph-fusion']).toEqual([
      'node',
      'dist/cli.js',
      'affected',
      'src/behavior/review-command.ts',
      '-p',
      '$PROJECT'
    ]);
    expect(createRunSlots(undefined)).toEqual([0, 1, 2, 3, 4]);
  });

  test('semantic intent benchmark avoids route-trigger leakage in its query wording', () => {
    const task = TASKS.find((item: any) => item.id === 'semantic-intent-routing') as any;
    const command = Array.isArray(task.commands['zincgraph-fusion']) ? task.commands['zincgraph-fusion'].join(' ') : '';
    expect(command).toContain('priority ordering');
    expect(command).not.toMatch(/\bsimilar\b|\branking\b|\brelevance\b|\brerank\b|\bretrieve\b/i);
  });

  test('summarizes task categories by distinct task ids instead of arm result count', () => {
    const graphTopology = TASK_CATEGORIES.GRAPH_TOPOLOGY;
    const crossModule = TASK_CATEGORIES.CROSS_MODULE;
    const summary = summarizeTaskCategories([
      { id: 'a', category: graphTopology, arm: 'codegraph', applicable: true, status: 0 },
      { id: 'a', category: graphTopology, arm: 'zincgraph-fusion', applicable: true, status: 1 },
      { id: 'b', category: crossModule, arm: 'codegraph', applicable: false, status: null }
    ]);
    expect(summary[graphTopology]!.taskIds).toEqual(['a']);
    expect(summary[graphTopology]!.applicableResults).toBe(2);
    expect(summary[graphTopology]!.passedResults).toBe(1);
    expect(summary[crossModule]!.taskIds).toEqual(['b']);
  });

  test('clamps values to normalized score range', () => {
    expect(clamp(-1)).toBe(0);
    expect(clamp(2)).toBe(1);
    expect(clamp(0.25)).toBe(0.25);
  });

  test('matches the closed numeric scorer fixture', () => {
    const task = {
      id: 'fixture',
      goldenFiles: ['a.ts', 'b.ts'],
      goldenSymbols: ['foo'],
      relevantTerms: ['stale', 'fresh']
    };
    const result = {
      status: 0,
      outputBytes: 2048,
      goldenFileHits: 1,
      uniqueGoldenFileHits: 1,
      goldenSymbolHits: 1,
      relevantTermHits: 1,
      topHit: 1,
      medianLatencyMs: 200,
      structuralHits: 3,
      taskCapabilityHits: 1,
      taskCapabilityExpected: 2
    };
    const scores = scoreTask(result, task, { maxDensityRawForTask: 1.5, bestMedianLatencyMs: 100 });
    approx(scores.retrieval, 0.8333);
    approx(scores.runtime, 0.5);
    approx(scores.depth, 0.5);
    approx(scores.capability, 0.5);
  });

  test('freshness formulas are exact', () => {
    approx(scoreFreshness({ freshnessTermHits: 3, freshnessTermsExpected: 4, freshnessCooccurrenceHits: 2 }, { id: 'freshness-manifest' }), 0.625);
    approx(scoreFreshness({ updateStatusHit: 1, updatedResultEvidenceHit: 1, manifestTransitionHit: 0 }, { id: 'isolated-update-freshness' }), 0.75);
  });

  test('failed comparable tasks score zero and sidecar N/A is excluded', () => {
    const summary = summarizeArmScores([
      { arm: 'codegraph', applicable: true, status: 1, medianLatencyMs: 10, outputBytes: 5, scores: zeroScores() },
      { arm: 'zincgraph-fusion', applicable: true, status: 0, medianLatencyMs: 20, outputBytes: 5, scores: { retrieval: 1, density: 1, runtime: 1, depth: 1, freshness: 1, capability: 1 } },
      { arm: 'zincgraph-delegated', applicable: false, scores: zeroScores() }
    ]);
    expect(summary.arms.codegraph.totalScore).toBe(0);
    expect(summary.arms['zincgraph-fusion'].totalScore).toBe(100);
    expect(summary.arms['zincgraph-delegated'].raw.applicableTasks).toBe(0);
    expect(summary.arms['zincgraph-delegated'].totalScore).toBe(0);
    expect(summary.winner).toBe('zincgraph-fusion');
  });

  test('arm total score and winner exclude density and runtime diagnostics', () => {
    const summary = summarizeArmScores([
      {
        arm: 'codegraph',
        applicable: true,
        status: 0,
        medianLatencyMs: 10,
        outputBytes: 10,
        scores: { retrieval: 0.8, density: 1, runtime: 1, depth: 0.6, freshness: 0.2, capability: 1 }
      },
      {
        arm: 'zincgraph-fusion',
        applicable: true,
        status: 0,
        medianLatencyMs: 1000,
        outputBytes: 100000,
        scores: { retrieval: 1, density: 0, runtime: 0, depth: 1, freshness: 1, capability: 1 }
      }
    ]);
    expect(summary.arms.codegraph.totalScore).toBe(66.15);
    expect(summary.arms.codegraph.diagnosticTotalScore).toBe(78);
    expect(summary.arms['zincgraph-fusion'].totalScore).toBe(100);
    expect(summary.arms['zincgraph-fusion'].diagnosticTotalScore).toBe(65);
    expect(summary.winner).toBe('zincgraph-fusion');
    expect(summary.diagnosticWinner).toBe('codegraph');
  });

  test('quality-only scores exclude density and runtime while preserving original totals', () => {
    const arms = {
      codegraph: {
        totalScore: 80,
        dimensionScores: { retrieval: 0.8, density: 1, runtime: 1, depth: 0.6, freshness: 0.2, capability: 1 }
      },
      'zincgraph-fusion': {
        totalScore: 70,
        dimensionScores: { retrieval: 1, density: 0, runtime: 0, depth: 1, freshness: 1, capability: 1 }
      }
    };
    const quality = summarizeQualityOnlyArms(arms);
    expect(arms.codegraph.totalScore).toBe(80);
    expect(qualityOnlyTotal(arms.codegraph.dimensionScores)).toBe(66.15);
    expect(quality.arms['zincgraph-fusion'].totalScore).toBe(100);
    expect(quality.winner).toBe('zincgraph-fusion');
  });

  test('report includes confidence, score table, external-agent note, and scoped non-mutation proof', () => {
    const report = createReport({
      generatedAt: '2026-06-20T00:00:00Z',
      confidence: 'local-deterministic',
      projectPath: '/repo',
      benchmarkProjectPath: '/tmp/repo-copy',
      benchmarkPool: {
        schemaVersion: 1,
        scoreModelVersion: '2026-06-27-v1',
        repoCount: 6,
        tierCounts: { core: 3, extended: 2, stress: 1 },
        caseCounts: { core: 30, extended: 16, stress: 6 }
      },
      runsPerCommand: 1,
      winner: { byComparison: 'zincgraph-fusion', byTotal: 'zincgraph-fusion', diagnosticByLegacyTotal: 'codegraph' },
      preflight: { warnings: [] },
      normalization: { t: { densityDenominator: 1, bestMedianLatencyMs: 10, applicablePrimaryArms: ['codegraph'], successfulPrimaryArms: ['codegraph'] } },
      nonMutationProof: { watchedRoots: ['.codegraph', '.zincgraph'], passed: true, changedPaths: [], sqliteVolatilePaths: [] },
      arms: {
        codegraph: { totalScore: 50, diagnosticTotalScore: 50, dimensionScores: { retrieval: 0.5, density: 0.5, runtime: 0.5, depth: 0.5, freshness: 0.5, capability: 0.5 }, raw: { medianLatencyMs: 10, totalOutputBytes: 20 } }
      },
      tasks: [
        { id: 't', category: TASK_CATEGORIES.CROSS_MODULE, arm: 'codegraph', applicable: true, status: 0, medianLatencyMs: 10, outputBytes: 20, goldenFileHits: 1, goldenFiles: ['a'], goldenSymbolHits: 0, goldenSymbols: [], relevantTermHits: 1, relevantTerms: ['x'], scores: { retrieval: 0.5, density: 0.5 } }
      ]
    });
    expect(report).toContain('local-deterministic');
    expect(report).toContain('Benchmark score by arm');
    expect(report).toContain('primaryWinner: zincgraph-fusion');
    expect(report).toContain('diagnosticLegacyWinner: codegraph');
    expect(report).toContain('Quality-only score by arm');
    expect(report).toContain('not counted');
    expect(report).toContain('diagnostic-only');
    expect(report).toContain('external agent A/B benchmark was not run');
    expect(report).toContain('Non-mutation proof');
    expect(report).toContain('current repository state roots only (.codegraph, .zincgraph)');
    expect(report).toContain('Normalization baselines');
    expect(report).toContain('Benchmark category coverage');
    expect(report).toContain(TASK_CATEGORIES.CROSS_MODULE);
    expect(report).toContain('Benchmark Pool Contract');
    expect(report).toContain('repoCount: 6');
    expect(report).toContain('scoreModelVersion: 2026-06-27-v1');
  });

  test('loads benchmark pool manifest summary from the machine-readable contract', () => {
    const pool = loadBenchmarkPool();
    expect(pool.schemaVersion).toBe(1);
    expect(pool.scoreModelVersion).toBe('2026-06-27-v1');
    expect(pool.repoCount).toBe(6);
    expect(pool.tierCounts).toEqual({ core: 3, extended: 2, stress: 1 });
    expect(pool.caseCounts).toEqual({ core: 30, extended: 16, stress: 6 });
  });
});

describe('benchmark runner aggregation', () => {
  test('any failed run fails the task and therefore scores zero', () => {
    const aggregate = aggregateRunRecords([
      { index: 0, status: 0, elapsedMs: 300, output: 'src/a.ts foo' },
      { index: 1, status: 1, elapsedMs: 100, output: 'command failed' },
      { index: 2, status: 0, elapsedMs: 200, output: 'src/a.ts foo' }
    ]);
    expect(aggregate.status).toBe(1);
    expect(aggregate.failureCount).toBe(1);
    expect(aggregate.runs).toHaveLength(3);
    const task = { id: 'fixture', goldenFiles: ['src/a.ts'], goldenSymbols: ['foo'], relevantTerms: [] };
    const result = analyzeOutput({ task, arm: 'codegraph', commandSpec: ['fixture'], status: aggregate.status, output: aggregate.scoringOutput, medianLatencyMs: aggregate.medianLatencyMs });
    expect(result.category).toBe('uncategorized');
    expect(scoreTask(result, task)).toEqual(zeroScores());
  });

  test('selects deterministic median-latency successful output for scoring', () => {
    const aggregate = aggregateRunRecords([
      { index: 0, status: 0, elapsedMs: 300, output: 'slow' },
      { index: 1, status: 0, elapsedMs: 100, output: 'fast' },
      { index: 2, status: 0, elapsedMs: 200, output: 'median' }
    ]);
    expect(aggregate.status).toBe(0);
    expect(aggregate.medianLatencyMs).toBe(200);
    expect(aggregate.selectedRunIndex).toBe(2);
    expect(aggregate.scoringOutput).toBe('median');
  });

  test('does not union partial evidence across successful runs for scoring', () => {
    const aggregate = aggregateRunRecords([
      { index: 0, status: 0, elapsedMs: 100, output: 'src/a.ts' },
      { index: 1, status: 0, elapsedMs: 200, output: 'fooSymbol' }
    ]);
    const task = { id: 'anti-gaming', goldenFiles: ['src/a.ts'], goldenSymbols: ['fooSymbol'], relevantTerms: [] };
    const result = analyzeOutput({ task, arm: 'codegraph', commandSpec: ['fixture'], status: aggregate.status, output: aggregate.scoringOutput, medianLatencyMs: aggregate.medianLatencyMs });
    expect(aggregate.selectedRunIndex).toBe(0);
    expect(result.goldenFileHits).toBe(1);
    expect(result.goldenSymbolHits).toBe(0);
  });

  test('diagnostic command echo does not count as scoring evidence or density bytes', () => {
    const diagnosticOnly = '$ codegraph explore manifest stale pending fresh src/a.ts fooSymbol\n';
    const aggregate = aggregateRunRecords([
      { index: 0, status: 0, elapsedMs: 100, scoringOutput: '', diagnosticOutput: diagnosticOnly }
    ]);
    const task = {
      id: 'freshness-manifest',
      goldenFiles: ['src/a.ts'],
      goldenSymbols: ['fooSymbol'],
      relevantTerms: ['stale', 'pending', 'fresh', 'manifest']
    };
    const result = analyzeOutput({ task, arm: 'codegraph', commandSpec: ['fixture'], status: aggregate.status, output: aggregate.scoringOutput, medianLatencyMs: aggregate.medianLatencyMs });
    expect(result.goldenFileHits).toBe(0);
    expect(result.goldenSymbolHits).toBe(0);
    expect(result.relevantTermHits).toBe(0);
    expect(result.freshnessTermHits).toBe(0);
    expect(result.freshnessCooccurrenceHits).toBe(0);
    expect(result.outputBytes).toBe(0);
    expect(densityRawFor(result)).toBe(0);
    expect(aggregate.runs[0].outputPreview).toContain('manifest stale pending fresh');
  });

  test('raw scoring evidence controls output bytes even when diagnostics contain echoed query terms', () => {
    const raw = 'src/a.ts fooSymbol';
    const diagnostic = `$ codegraph query manifest stale pending fresh src/b.ts otherSymbol\n${raw}`;
    const aggregate = aggregateRunRecords([
      { index: 0, status: 0, elapsedMs: 100, scoringOutput: raw, diagnosticOutput: diagnostic }
    ]);
    const task = {
      id: 'freshness-manifest',
      goldenFiles: ['src/a.ts', 'src/b.ts'],
      goldenSymbols: ['fooSymbol', 'otherSymbol'],
      relevantTerms: ['stale', 'pending', 'fresh', 'manifest']
    };
    const result = analyzeOutput({ task, arm: 'codegraph', commandSpec: ['fixture'], status: aggregate.status, output: aggregate.scoringOutput, medianLatencyMs: aggregate.medianLatencyMs });
    expect(result.outputBytes).toBe(Buffer.byteLength(raw));
    expect(result.goldenFileHits).toBe(1);
    expect(result.goldenSymbolHits).toBe(1);
    expect(result.relevantTermHits).toBe(0);
    expect(result.freshnessTermHits).toBe(0);
    expect(densityRawFor(result)).toBe(2 / 0.5);
    expect(aggregate.runs[0].diagnosticOutputBytes).toBe(Buffer.byteLength(diagnostic));
  });

  test('persists full diagnostic transcripts outside compact run records', () => {
    const resultDir = mkdtempSync(join(tmpdir(), 'zincgraph-transcripts-'));
    const aggregate = aggregateRunRecords([
      {
        index: 0,
        status: 0,
        elapsedMs: 100,
        scoringOutput: 'raw evidence',
        diagnosticOutput: '$ codegraph query raw evidence\nraw evidence\nfull diagnostic line'
      }
    ]);
    const tasks: any[] = [{
      id: 'echo-task',
      arm: 'codegraph',
      applicable: true,
      runs: aggregate.runs
    }];
    const manifest = persistDiagnosticTranscripts(tasks, resultDir);
    const transcriptPath = tasks[0].runs[0].diagnosticTranscriptPath;
    expect(manifest.count).toBe(1);
    expect(transcriptPath).toMatch(/^diagnostic-transcripts\//);
    expect(tasks[0].runs[0].diagnosticOutput).toBeUndefined();
    expect(readFileSync(join(resultDir, transcriptPath), 'utf8')).toContain('$ codegraph query raw evidence');
    expect(existsSync(join(resultDir, transcriptPath))).toBe(true);
  });

  test('isolated update task consumes requested run count via injectable runner', async () => {
    const calls: number[] = [];
    const task = TASKS.find((item: any) => item.id === 'isolated-update-freshness') as any;
    const result = await runIsolatedUpdateTask('zincgraph-fusion', task, 3, async (_arm: string, _task: any, index: number) => {
      calls.push(index);
      return {
        index,
        status: 0,
        elapsedMs: index + 1,
        output: 'src/changed.ts addedLocalBenchmarkFunction fresh transition manifest'
      };
    });
    expect(calls).toEqual([0, 1, 2]);
    expect(createRunSlots(3)).toEqual([0, 1, 2]);
    expect(result.runs).toHaveLength(3);
    expect(result.status).toBe(0);
    expect(result.selectedRunIndex).toBe(1);
    expect(result.updatedResultEvidenceHit).toBe(1);
    expect(result.manifestTransitionHit).toBe(1);
  });

  test('isolated update scoring ignores setup diagnostics when scoring output is separated', async () => {
    const task = TASKS.find((item: any) => item.id === 'isolated-update-freshness') as any;
    const scoringOutput = 'src/changed.ts addedLocalBenchmarkFunction fresh transition manifest';
    const result = await runIsolatedUpdateTask('zincgraph-fusion', task, 1, async (_arm: string, _task: any, index: number) => {
      expect(index).toBe(0);
      return {
        index,
        status: 0,
        elapsedMs: 42,
        scoringOutput,
        diagnosticOutput: [
          'Initializing CodeGraph',
          'Scanning files',
          'Parsing code',
          scoringOutput
        ].join('\n')
      };
    });

    expect(result.outputBytes).toBe(Buffer.byteLength(scoringOutput));
    expect(result.topHit).toBe(1);
    expect(result.updatedResultEvidenceHit).toBe(1);
    expect(result.manifestTransitionHit).toBe(1);
  });

  test('normalization baselines are emitted and attached to applicable task results', () => {
    const task = TASKS[0] as any;
    const results: any[] = [
      { id: task.id, arm: 'codegraph', applicable: true, status: 0, medianLatencyMs: 100, outputBytes: 1024, goldenFileHits: 1, goldenSymbolHits: 1, relevantTermHits: 1, topHit: 1, structuralHits: 1 },
      { id: task.id, arm: 'zincgraph-fusion', applicable: true, status: 0, medianLatencyMs: 200, outputBytes: 2048, goldenFileHits: 1, goldenSymbolHits: 0, relevantTermHits: 1, topHit: 1, structuralHits: 1 }
    ];
    const normalization = applyNormalizedScores(results);
    expect(normalization[task.id].densityDenominator).toBeGreaterThan(0);
    expect(normalization[task.id].bestMedianLatencyMs).toBe(100);
    expect(results[0].normalization).toEqual(normalization[task.id]);
  });

  test('failed primary arms do not affect density normalization denominator', () => {
    const task = TASKS[0] as any;
    const failedHighDensity: any = {
      id: task.id,
      arm: 'codegraph',
      applicable: true,
      status: 1,
      medianLatencyMs: 100,
      outputBytes: 512,
      goldenFileHits: 100,
      goldenSymbolHits: 100,
      relevantTermHits: 100,
      topHit: 1,
      structuralHits: 1
    };
    const successfulLowDensity: any = {
      id: task.id,
      arm: 'zincgraph-fusion',
      applicable: true,
      status: 0,
      medianLatencyMs: 200,
      outputBytes: 4096,
      goldenFileHits: 1,
      goldenSymbolHits: 1,
      relevantTermHits: 1,
      topHit: 1,
      structuralHits: 1
    };
    const results: any[] = [failedHighDensity, successfulLowDensity];
    const expectedSuccessfulDensity = (
      successfulLowDensity.goldenFileHits +
      successfulLowDensity.goldenSymbolHits +
      successfulLowDensity.relevantTermHits
    ) / (successfulLowDensity.outputBytes / 1024);
    const normalization = applyNormalizedScores(results);
    expect(normalization[task.id].applicablePrimaryArms).toEqual(['codegraph', 'zincgraph-fusion']);
    expect(normalization[task.id].successfulPrimaryArms).toEqual(['zincgraph-fusion']);
    expect(normalization[task.id].densityDenominator).toBe(expectedSuccessfulDensity);
    expect(successfulLowDensity.scores.density).toBe(1);
    expect(failedHighDensity.scores).toEqual(zeroScores());
  });

  test('no successful primary arms means no primary density baseline', () => {
    const task = TASKS[0] as any;
    const failedCodegraph: any = {
      id: task.id,
      arm: 'codegraph',
      applicable: true,
      status: 1,
      medianLatencyMs: 100,
      outputBytes: 512,
      goldenFileHits: 100,
      goldenSymbolHits: 100,
      relevantTermHits: 100,
      topHit: 1,
      structuralHits: 1
    };
    const failedFusion: any = {
      ...failedCodegraph,
      arm: 'zincgraph-fusion',
      medianLatencyMs: 200
    };
    const successfulSidecar: any = {
      id: task.id,
      arm: 'zincgraph-delegated',
      applicable: true,
      status: 0,
      medianLatencyMs: 50,
      outputBytes: 1024,
      goldenFileHits: 1,
      goldenSymbolHits: 1,
      relevantTermHits: 1,
      topHit: 1,
      structuralHits: 1
    };
    const results: any[] = [failedCodegraph, failedFusion, successfulSidecar];
    const normalization = applyNormalizedScores(results);
    expect(normalization[task.id].applicablePrimaryArms).toEqual(['codegraph', 'zincgraph-fusion']);
    expect(normalization[task.id].successfulPrimaryArms).toEqual([]);
    expect(normalization[task.id].densityDenominator).toBe(0);
    expect(normalization[task.id].bestMedianLatencyMs).toBe(0);
    expect(successfulSidecar.scores.density).toBe(0);
    expect(successfulSidecar.scores.runtime).toBe(0);
    expect(failedCodegraph.scores).toEqual(zeroScores());
    expect(failedFusion.scores).toEqual(zeroScores());
  });
});

describe('benchmark runner safety and preflight', () => {
  test('spawn options never request shell execution', () => {
    expect(createSpawnOptions('/tmp', 1).shell).toBe(false);
  });

  test('preflight warns but remains ok when zincgraph state is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zincgraph-preflight-ok-'));
    const bins = join(dir, 'bins');
    mkdirSync(join(dir, '.codegraph'), { recursive: true });
    mkdirSync(bins, { recursive: true });
    writeFileSync(join(dir, '.codegraph', 'codegraph.db'), 'db');
    writeFileSync(join(bins, 'zincgraph.js'), '');
    writeFileSync(join(bins, 'codegraph'), '');
    const preflight = runPreflight(dir, { zincgraphCli: join(bins, 'zincgraph.js'), codegraphBin: join(bins, 'codegraph') });
    expect(preflight.ok).toBe(true);
    expect(preflight.zincgraphState).toBe('missing');
    expect(preflight.warnings.some((warning: string) => warning.includes('.zincgraph/fusion.sqlite is missing'))).toBe(true);
  });

  test('preflight fails when codegraph database is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zincgraph-preflight-fail-'));
    const bins = join(dir, 'bins');
    mkdirSync(bins, { recursive: true });
    writeFileSync(join(bins, 'zincgraph.js'), '');
    writeFileSync(join(bins, 'codegraph'), '');
    const preflight = runPreflight(dir, { zincgraphCli: join(bins, 'zincgraph.js'), codegraphBin: join(bins, 'codegraph') });
    expect(preflight.ok).toBe(false);
    expect(preflight.warnings.some((warning: string) => warning.includes('codegraph init'))).toBe(true);
  });
});

describe('benchmark freshness extraction', () => {
  test('distinguishes scattered terms from co-occurring evidence', () => {
    const scattered = 'stale\npending\nfresh\nmanifest';
    expect(countFreshnessTermHits(scattered)).toBe(4);
    expect(countFreshnessCooccurrenceHits(scattered)).toBeLessThan(4);
  });

  test('counts JSON transition object co-occurrence', () => {
    const json = JSON.stringify({ transition: { stale: 1, pending: 1, fresh: 1, manifest: true } });
    expect(countFreshnessTermHits(json)).toBe(4);
    expect(countFreshnessCooccurrenceHits(json)).toBe(4);
  });
});

describe('benchmark non-mutation proof', () => {
  test('recursive fingerprint detects nested zincgraph changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zincgraph-proof-'));
    mkdirSync(join(dir, '.zincgraph', 'nested'), { recursive: true });
    writeFileSync(join(dir, '.zincgraph', 'nested', 'file.txt'), 'before');
    const before = fingerprintRoots(dir, ['.zincgraph']);
    writeFileSync(join(dir, '.zincgraph', 'nested', 'file.txt'), 'after');
    const after = fingerprintRoots(dir, ['.zincgraph']);
    const diff = diffFingerprints(before, after);
    expect(diff.changedPaths).toContain('.zincgraph/nested/file.txt');
  });

  test('sqlite WAL mtime-only changes are volatile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zincgraph-proof-wal-'));
    mkdirSync(join(dir, '.codegraph'), { recursive: true });
    const wal = join(dir, '.codegraph', 'codegraph.db-wal');
    writeFileSync(wal, 'same');
    const before = fingerprintRoots(dir, ['.codegraph']);
    const stat = statSync(wal);
    utimesSync(wal, stat.atime, new Date(stat.mtimeMs + 5000));
    const after = fingerprintRoots(dir, ['.codegraph']);
    const diff = diffFingerprints(before, after);
    expect(diff.changedPaths).toEqual([]);
    expect(diff.sqliteVolatilePaths).toContain('.codegraph/codegraph.db-wal');
  });
});

describe('benchmark performance goal gate', () => {
  test('passes when quality margin, retrieval speed, and strict benchmark thresholds are met', () => {
    const summary: any = goalSummaryFixture({
      codegraphQuality: 70,
      zincgraphQuality: 75,
      codegraphLatency: 300,
      zincgraphLatency: 100
    });
    const result = evaluateBenchmarkGoal(summary);
    expect(result.passed).toBe(true);
    expect(result.metrics.speedup).toBe(3);
  });

  test('fails on quality regression, failed zincgraph task, or missed speed target', () => {
    const summary: any = goalSummaryFixture({
      codegraphQuality: 80,
      zincgraphQuality: 79,
      codegraphLatency: 200,
      zincgraphLatency: 150,
      zincgraphStatus: 1
    });
    const result = evaluateBenchmarkGoal(summary);
    expect(result.passed).toBe(false);
    expect(result.failures.join('\n')).toContain('Quality margin missed');
    expect(result.failures.join('\n')).toContain('Failed zincgraph-fusion tasks');
    expect(result.failures.join('\n')).toContain('Speed target missed');
  });

  test('warns when metrics pass but remain within 10% of goal thresholds', () => {
    const summary: any = goalSummaryFixture({
      codegraphQuality: 70,
      zincgraphQuality: 74.2,
      codegraphLatency: 300,
      zincgraphLatency: 95,
      fusionOutputBytes: 210_000,
      freshnessScore: 0.265,
      isolatedUpdateFreshnessLatency: 1_150
    });
    const result = evaluateBenchmarkGoal(summary);
    expect(result.passed).toBe(true);
    expect(result.warnings.join('\n')).toContain('Quality margin is within 10%');
    expect(result.warnings.join('\n')).toContain('Speed target is within 10%');
    expect(result.warnings.join('\n')).toContain('Output budget is within 10%');
    expect(result.warnings.join('\n')).toContain('Freshness dimension is within 10%');
    expect(result.warnings.join('\n')).toContain('isolated-update-freshness medianLatencyMs is within 10%');
  });
});

function goalSummaryFixture(input: {
  codegraphQuality: number;
  zincgraphQuality: number;
  codegraphLatency: number;
  zincgraphLatency: number;
  zincgraphStatus?: number;
  fusionOutputBytes?: number;
  freshnessScore?: number;
  isolatedUpdateFreshnessLatency?: number;
}) {
  return {
    qualityOnly: {
      arms: {
        codegraph: { totalScore: input.codegraphQuality },
        'zincgraph-fusion': {
          totalScore: input.zincgraphQuality,
          dimensionScores: { freshness: input.freshnessScore ?? 0.3 }
        }
      }
    },
    arms: {
      'zincgraph-fusion': {
        raw: { totalOutputBytes: input.fusionOutputBytes ?? 100_000 }
      }
    },
    tasks: [
      {
        id: 'exact-autosync-api',
        arm: 'codegraph',
        applicable: true,
        status: 0,
        medianLatencyMs: input.codegraphLatency
      },
      {
        id: 'exact-autosync-api',
        arm: 'zincgraph-fusion',
        applicable: true,
        status: input.zincgraphStatus ?? 0,
        medianLatencyMs: input.zincgraphLatency,
        scores: { density: 0.6 }
      },
      {
        id: 'isolated-update-freshness',
        arm: 'zincgraph-fusion',
        applicable: true,
        status: 0,
        medianLatencyMs: input.isolatedUpdateFreshnessLatency ?? 300
      },
      {
        id: 'graph-navigation-autosync-pipeline',
        arm: 'zincgraph-fusion',
        applicable: true,
        status: 0,
        medianLatencyMs: 100
      },
      {
        id: 'affected-review-command-tests',
        arm: 'zincgraph-fusion',
        applicable: true,
        status: 0,
        medianLatencyMs: 100
      },
      {
        id: 'behavior-dedup-review',
        arm: 'zincgraph-fusion',
        applicable: true,
        status: 0,
        medianLatencyMs: 100
      },
      {
        id: 'impact-autosync-topology',
        arm: 'zincgraph-fusion',
        applicable: true,
        status: 0,
        medianLatencyMs: 100,
        goldenFileHits: 2,
        scores: { density: 0.5 }
      },
      {
        id: 'cross-module-freshness-vector-flow',
        arm: 'zincgraph-fusion',
        applicable: true,
        status: 0,
        medianLatencyMs: 100,
        goldenFileHits: 4
      },
      {
        id: 'freshness-manifest',
        arm: 'zincgraph-fusion',
        applicable: true,
        status: 0,
        medianLatencyMs: 100,
        goldenSymbolHits: 3
      }
    ]
  };
}
