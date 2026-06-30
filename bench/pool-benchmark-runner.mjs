#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getAllRepoFixtures } from './fixtures/index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ZINCGRAPH_CLI = join(ROOT, 'dist/cli.js');
const CODEGRAPH_BIN = join(ROOT, 'node_modules/@colbymchenry/codegraph/npm-shim.js');
const POOL_SYNC_SCRIPT = join(ROOT, 'bench/pool-sync.mjs');
export const DEFAULT_POOL_PATH = join(ROOT, 'bench/benchmark-pool.json');
export const DEFAULT_LOCAL_METADATA_PATH = join(ROOT, 'bench/benchmark-pool.local.json');
export const DEFAULT_RESULTS_ROOT = join(ROOT, 'bench/results');
export const DEFAULT_RUNS = 1;
export const SCORE_MODEL_VERSION = '2026-06-27-v1';
const ENABLED_CASE_SCORE_FLOOR = 85;
export const BASE_WEIGHTS = Object.freeze({
  retrieval: 30,
  relation: 20,
  multi_impl: 15,
  freshness: 20,
  impact: 15
});
export const TIER_WEIGHTS = Object.freeze({
  core: 0.60,
  extended: 0.30,
  stress: 0.10
});
const DEFAULT_CONCURRENCY = 2;

const REQUIRED_CASE_ARRAY_FIELDS = Object.freeze([
  'goldenFiles',
  'goldenSymbols',
  'goldenRelations',
  'goldenImplementations',
  'acceptableAlternates',
  'invalidImplementations',
  'requiredEvidenceTerms',
  'forbiddenFalsePositives',
  'goldenTests',
  'goldenRuntimeArtifacts',
  'requiredConsequenceTerms'
]);

export function parsePoolBenchmarkArgs(argv) {
  const options = {
    poolPath: DEFAULT_POOL_PATH,
    localMetadataPath: DEFAULT_LOCAL_METADATA_PATH,
    resultsRoot: DEFAULT_RESULTS_ROOT,
    runs: DEFAULT_RUNS,
    accept: false,
    tiers: null,
    repos: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--pool') {
      options.poolPath = resolve(argv[++index] ?? options.poolPath);
      continue;
    }
    if (arg === '--local-metadata') {
      options.localMetadataPath = resolve(argv[++index] ?? options.localMetadataPath);
      continue;
    }
    if (arg === '--results-root') {
      options.resultsRoot = resolve(argv[++index] ?? options.resultsRoot);
      continue;
    }
    if (arg === '--runs') {
      options.runs = Math.max(1, Number.parseInt(argv[++index] ?? String(DEFAULT_RUNS), 10) || DEFAULT_RUNS);
      continue;
    }
    if (arg === '--tier') {
      if (!options.tiers) options.tiers = [];
      options.tiers.push(String(argv[++index] ?? ''));
      continue;
    }
    if (arg === '--repo') {
      if (!options.repos) options.repos = [];
      options.repos.push(String(argv[++index] ?? ''));
      continue;
    }
    if (arg === '--accept') {
      options.accept = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node bench/pool-benchmark.mjs [--pool <path>] [--local-metadata <path>] [--results-root <path>] [--runs <n>] [--accept] [--tier <tier>] [--repo <repoId>]');
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.tiers) options.tiers = [...new Set(options.tiers.filter(Boolean))];
  if (options.repos) options.repos = [...new Set(options.repos.filter(Boolean))];
  return options;
}

export function loadPoolContract(poolPath = DEFAULT_POOL_PATH) {
  const raw = JSON.parse(readFileSync(poolPath, 'utf8'));
  const repos = Array.isArray(raw.repos) ? raw.repos : [];
  return {
    path: poolPath,
    raw,
    schemaVersion: raw.schemaVersion ?? null,
    scoreModelVersion: raw.scoreModel?.version ?? null,
    repos,
    repoById: Object.fromEntries(repos.map((repo) => [repo.id, repo]))
  };
}

export function loadRepoFixtureMap() {
  return Object.fromEntries(getAllRepoFixtures().map(({ repoId, cases }) => [repoId, cases]));
}

export function normalizeTierSet(tiers) {
  return [...new Set((tiers ?? []).filter(Boolean))].sort();
}

export async function runPoolBenchmark(options = {}) {
  const pool = loadPoolContract(options.poolPath ?? DEFAULT_POOL_PATH);
  const localMetadataPath = resolve(options.localMetadataPath ?? DEFAULT_LOCAL_METADATA_PATH);
  const resultsRoot = resolve(options.resultsRoot ?? DEFAULT_RESULTS_ROOT);
  const runs = Math.max(1, Number.parseInt(String(options.runs ?? DEFAULT_RUNS), 10) || DEFAULT_RUNS);
  const accept = options.accept === true;
  const fixtureMap = loadRepoFixtureMap();
  const enabledRepos = selectEnabledRepos(pool.raw, localMetadataPath, options);
  const enabledTiers = normalizeTierSet(enabledRepos.map((repo) => repo.tier));
  const materialization = synchronizePoolMaterialization({
    poolPath: pool.path,
    localMetadataPath,
    enabledTiers,
    enabledRepoIds: enabledRepos.map((repo) => repo.id)
  });
  const fixtureValidation = validatePoolAgainstFixtures(pool, fixtureMap, enabledRepos, localMetadataPath);
  const poolValidation = combinePoolValidationResults({ materialization, fixtureValidation });
  const baseline = loadAcceptedBaselineSummary(resultsRoot, {
    schemaVersion: 1,
    scoreModelVersion: pool.scoreModelVersion,
    enabledTiers
  });
  const proofRoots = ['.codegraph', '.zincgraph', 'bench/benchmark-pool.json'];
  if (existsSync(localMetadataPath)) {
    proofRoots.push(relative(ROOT, localMetadataPath).split(sep).join('/'));
  }
  const before = fingerprintRoots(ROOT, proofRoots);
  const beforeRepoStates = fingerprintSourceRepoStates(ROOT, enabledRepos, localMetadataPath);
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\\.\\d{3}Z$/, 'Z');
  const resultDir = join(resultsRoot, timestamp);
  mkdirSync(resultDir, { recursive: true });
  const readiness = [];

  const repoPaths = new Map(enabledRepos.map((repo) => [repo.id, join(ROOT, repo.path)]));
  for (const repo of enabledRepos) {
    readiness.push(ensureRepoReady(repoPaths.get(repo.id), repo.id));
  }

  const caseJobs = enabledRepos.flatMap((repo) => (fixtureMap[repo.id] ?? []).map((caseSpec, index) => ({
    repo,
    caseSpec,
    repoPath: repoPaths.get(repo.id),
    index
  })));
  const caseResults = await mapWithConcurrency(caseJobs, DEFAULT_CONCURRENCY, async ({ repo, caseSpec, repoPath }) => (
    evaluateCaseAsync(repo, caseSpec, repoPath, runs)
  ));
  const caseResultsByRepo = new Map(enabledRepos.map((repo) => [repo.id, []]));
  for (const caseResult of caseResults) {
    caseResultsByRepo.get(caseResult.repoId)?.push(caseResult);
  }
  const repoResults = enabledRepos.map((repo) => summarizeRepoFromCaseResults(repo, caseResultsByRepo.get(repo.id) ?? []));
  const tierResults = summarizeTierResults(repoResults, enabledTiers);
  const globalQualityScore = weightedTierScore(tierResults);
  const after = fingerprintRoots(ROOT, proofRoots);
  const afterRepoStates = fingerprintSourceRepoStates(ROOT, enabledRepos, localMetadataPath);
  const nonMutationProof = buildNonMutationProof(before, after, beforeRepoStates, afterRepoStates);
  const hardGate = evaluateHardGates({
    poolValidation,
    readiness,
    repoResults,
    caseResults,
    nonMutationProof,
    enabledTiers
  });
  const scoreFloors = evaluateScoreFloors({ repoResults, caseResults, globalQualityScore, baseline, enabledTiers });
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    passed: hardGate.passed && scoreFloors.passed,
    accepted: hardGate.passed && scoreFloors.passed,
    scoreModel: {
      version: SCORE_MODEL_VERSION,
      baseWeights: BASE_WEIGHTS
    },
    pool: pool.raw,
    enabledTiers,
    repoCount: enabledRepos.length,
    caseCount: caseResults.length,
    repoResults,
    tierResults,
    globalQualityScore: round2(globalQualityScore),
    baseline,
    hardGate,
    scoreFloors,
    nonMutationProof,
    poolValidation,
    materialization,
    resultsDir: relative(ROOT, resultDir).split(sep).join('/'),
    queryRuns: runs,
    caseResults,
    acceptedSummaryCandidate: accept
  };
  const report = createPoolReport(summary);
  writeFileSync(join(resultDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(resultDir, 'report.md'), report);
  rmSync(join(resultsRoot, 'latest'), { recursive: true, force: true });
  mkdirSync(resultsRoot, { recursive: true });
  safeCopyTree(resultDir, join(resultsRoot, 'latest'));
  return { summary, report, resultDir };
}

function synchronizePoolMaterialization({ poolPath, localMetadataPath, enabledTiers = [], enabledRepoIds = [] }) {
  if (!enabledTiers.length && !enabledRepoIds.length) {
    return { ok: true, skipped: true, actions: [], warnings: [], errors: [] };
  }
  const command = [
    process.execPath,
    POOL_SYNC_SCRIPT,
    '--pool',
    poolPath,
    '--local-metadata',
    localMetadataPath,
    ...enabledTiers.flatMap((tier) => ['--tier', tier]),
    ...enabledRepoIds.flatMap((repoId) => ['--repo', repoId])
  ];
  const result = runCommand(command, ROOT, 300_000);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout || 'null');
  } catch (error) {
    return {
      ok: false,
      command,
      errors: [`Failed to parse pool sync output: ${error instanceof Error ? error.message : String(error)}`],
      warnings: [],
      rawStdoutPreview: String(result.stdout ?? '').slice(0, 500),
      rawStderrPreview: String(result.stderr ?? '').slice(0, 500)
    };
  }
  return {
    ok: result.status === 0 && parsed?.ok === true,
    command,
    ...parsed
  };
}

function combinePoolValidationResults({ materialization, fixtureValidation }) {
  const errors = [
    ...(materialization?.errors ?? []),
    ...(fixtureValidation?.errors ?? [])
  ];
  const warnings = [
    ...(materialization?.warnings ?? []),
    ...(fixtureValidation?.warnings ?? [])
  ];
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    materialization,
    fixtureValidation,
    expectedCounts: fixtureValidation?.expectedCounts ?? { core: 0, extended: 0, stress: 0 },
    fixtureCounts: fixtureValidation?.fixtureCounts ?? { core: 0, extended: 0, stress: 0 }
  };
}

async function collectArmBenchmarkResults({ arm, enabledRepos, enabledTiers, fixtureMap, repoPaths, runs }) {
  const caseJobs = enabledRepos.flatMap((repo) => (fixtureMap[repo.id] ?? []).map((caseSpec, index) => ({
    repo,
    caseSpec,
    repoPath: repoPaths.get(repo.id),
    index,
    arm
  })));
  const caseResults = await mapWithConcurrency(caseJobs, DEFAULT_CONCURRENCY, async ({ repo, caseSpec, repoPath, arm: currentArm }) => (
    evaluateCaseForArmAsync(repo, caseSpec, repoPath, runs, currentArm)
  ));
  const caseResultsByRepo = new Map(enabledRepos.map((repo) => [repo.id, []]));
  for (const caseResult of caseResults) {
    caseResultsByRepo.get(caseResult.repoId)?.push(caseResult);
  }
  const repoResults = enabledRepos.map((repo) => summarizeRepoFromCaseResults(repo, caseResultsByRepo.get(repo.id) ?? []));
  const tierResults = summarizeTierResults(repoResults, enabledTiers);
  const globalQualityScore = weightedTierScore(tierResults);
  return {
    arm,
    caseResults,
    repoResults,
    tierResults,
    globalQualityScore: round2(globalQualityScore),
    dimensions: meanDimensionScores(caseResults),
    raw: {
      medianLatencyMs: round2(median(caseResults.map((item) => item.medianLatencyMs).filter(Number.isFinite))),
      totalOutputBytes: caseResults.reduce((sum, item) => sum + (item.outputBytes ?? 0), 0),
      tasksPassed: caseResults.filter((item) => item.passed).length,
      applicableTasks: caseResults.length
    }
  };
}

function buildComparisonArmSnapshot(armSummary, hardGate, scoreFloors) {
  return {
    totalScore: armSummary.globalQualityScore,
    dimensionScores: armSummary.dimensions,
    raw: armSummary.raw,
    repoResults: armSummary.repoResults,
    tierResults: armSummary.tierResults,
    hardGate,
    scoreFloors,
    caseResults: armSummary.caseResults
  };
}

function indexRepoResults(repoResults) {
  return Object.fromEntries(repoResults.map((repo) => [repo.repoId, repo]));
}

function compareCaseResultsByRepo(caseResultsByArm, baselineArm, targetArm) {
  const baseline = caseResultsByArm[baselineArm] ?? [];
  const target = caseResultsByArm[targetArm] ?? [];
  const keyed = new Map();
  for (const item of [...baseline, ...target]) {
    const key = `${item.repoId}::${item.queryId}`;
    const current = keyed.get(key) ?? {
      repoId: item.repoId,
      tier: item.tier,
      queryId: item.queryId,
      family: item.family,
      difficulty: item.difficulty,
      byArm: {}
    };
    current.byArm[item.arm] = item;
    keyed.set(key, current);
  }
  return [...keyed.values()].sort((left, right) => {
    const tierDelta = String(left.tier ?? '').localeCompare(String(right.tier ?? ''));
    if (tierDelta !== 0) return tierDelta;
    const repoDelta = String(left.repoId ?? '').localeCompare(String(right.repoId ?? ''));
    if (repoDelta !== 0) return repoDelta;
    return String(left.queryId ?? '').localeCompare(String(right.queryId ?? ''));
  }).map((item) => {
    const baselineItem = item.byArm[baselineArm] ?? null;
    const targetItem = item.byArm[targetArm] ?? null;
    const baselineScore = Number(baselineItem?.totalScore ?? 0);
    const targetScore = Number(targetItem?.totalScore ?? 0);
    return {
      ...item,
      winner: targetScore === baselineScore ? 'tie' : (targetScore > baselineScore ? targetArm : baselineArm),
      delta: round2(targetScore - baselineScore)
    };
  });
}

function compareRepoResultsByArm(armSummaries, arms, targetArm, baselineArm) {
  const targetRepos = indexRepoResults(armSummaries[targetArm]?.repoResults ?? []);
  const baselineRepos = indexRepoResults(armSummaries[baselineArm]?.repoResults ?? []);
  return Object.values(arms.reduce((acc, arm) => {
    const repoResults = armSummaries[arm]?.repoResults ?? [];
    for (const repo of repoResults) {
      const current = acc[repo.repoId] ?? {
        repoId: repo.repoId,
        tier: repo.tier,
        caseCount: repo.caseCount,
        byArm: {}
      };
      current.byArm[arm] = repo;
      acc[repo.repoId] = current;
    }
    return acc;
  }, {})).sort((left, right) => String(left.repoId).localeCompare(String(right.repoId))).map((item) => {
    const baselineRepo = baselineRepos[item.repoId] ?? null;
    const targetRepo = targetRepos[item.repoId] ?? null;
    const baselineScore = Number(baselineRepo?.score ?? 0);
    const targetScore = Number(targetRepo?.score ?? 0);
    return {
      ...item,
      winner: targetScore === baselineScore ? 'tie' : (targetScore > baselineScore ? targetArm : baselineArm),
      delta: round2(targetScore - baselineScore)
    };
  });
}

function compareTierResultsByArm(armSummaries, arms, targetArm, baselineArm) {
  const tiers = new Set();
  for (const arm of arms) {
    for (const tier of Object.keys(armSummaries[arm]?.tierResults ?? {})) tiers.add(tier);
  }
  return Object.fromEntries([...tiers].sort().map((tier) => {
    const byArm = {};
    for (const arm of arms) {
      if (armSummaries[arm]?.tierResults?.[tier]) byArm[arm] = armSummaries[arm].tierResults[tier];
    }
    const baselineScore = Number(byArm[baselineArm]?.score ?? 0);
    const targetScore = Number(byArm[targetArm]?.score ?? 0);
    return [tier, {
      byArm,
      winner: targetScore === baselineScore ? 'tie' : (targetScore > baselineScore ? targetArm : baselineArm),
      delta: round2(targetScore - baselineScore)
    }];
  }));
}

export async function runPoolComparison(options = {}) {
  const pool = loadPoolContract(options.poolPath ?? DEFAULT_POOL_PATH);
  const localMetadataPath = resolve(options.localMetadataPath ?? DEFAULT_LOCAL_METADATA_PATH);
  const resultsRoot = resolve(options.resultsRoot ?? DEFAULT_RESULTS_ROOT);
  const runs = Math.max(1, Number.parseInt(String(options.runs ?? DEFAULT_RUNS), 10) || DEFAULT_RUNS);
  const accept = options.accept === true;
  const fixtureMap = loadRepoFixtureMap();
  const enabledRepos = selectEnabledRepos(pool.raw, localMetadataPath, options);
  const enabledTiers = normalizeTierSet(enabledRepos.map((repo) => repo.tier));
  const materialization = synchronizePoolMaterialization({
    poolPath: pool.path,
    localMetadataPath,
    enabledTiers,
    enabledRepoIds: enabledRepos.map((repo) => repo.id)
  });
  const fixtureValidation = validatePoolAgainstFixtures(pool, fixtureMap, enabledRepos, localMetadataPath);
  const poolValidation = combinePoolValidationResults({ materialization, fixtureValidation });
  const baseline = loadAcceptedBaselineSummary(resultsRoot, {
    schemaVersion: 1,
    scoreModelVersion: pool.scoreModelVersion,
    enabledTiers
  });
  const proofRoots = ['.codegraph', '.zincgraph', 'bench/benchmark-pool.json'];
  if (existsSync(localMetadataPath)) {
    proofRoots.push(relative(ROOT, localMetadataPath).split(sep).join('/'));
  }
  const before = fingerprintRoots(ROOT, proofRoots);
  const beforeRepoStates = fingerprintSourceRepoStates(ROOT, enabledRepos, localMetadataPath);
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\\.\\d{3}Z$/, 'Z');
  const resultDir = join(resultsRoot, timestamp);
  mkdirSync(resultDir, { recursive: true });
  const readiness = [];
  const repoPaths = new Map(enabledRepos.map((repo) => [repo.id, join(ROOT, repo.path)]));
  for (const repo of enabledRepos) {
    readiness.push(ensureRepoReady(repoPaths.get(repo.id), repo.id));
  }

  const arms = ['codegraph', 'zincgraph-fusion'];
  const armSummaries = {};
  for (const arm of arms) {
    armSummaries[arm] = await collectArmBenchmarkResults({
      arm,
      enabledRepos,
      enabledTiers,
      fixtureMap,
      repoPaths,
      runs
    });
  }

  const after = fingerprintRoots(ROOT, proofRoots);
  const afterRepoStates = fingerprintSourceRepoStates(ROOT, enabledRepos, localMetadataPath);
  const nonMutationProof = buildNonMutationProof(before, after, beforeRepoStates, afterRepoStates);
  const targetArm = 'zincgraph-fusion';
  const baselineArm = 'codegraph';
  const targetSummary = armSummaries[targetArm];
  const baselineSummary = armSummaries[baselineArm];
  const targetHardGate = evaluateHardGates({
    poolValidation,
    readiness,
    repoResults: targetSummary.repoResults,
    caseResults: targetSummary.caseResults,
    nonMutationProof,
    enabledTiers
  });
  const targetScoreFloors = evaluateScoreFloors({
    repoResults: targetSummary.repoResults,
    caseResults: targetSummary.caseResults,
    globalQualityScore: targetSummary.globalQualityScore,
    baseline,
    enabledTiers
  });
  const baselineHardGate = evaluateHardGates({
    poolValidation,
    readiness,
    repoResults: baselineSummary.repoResults,
    caseResults: baselineSummary.caseResults,
    nonMutationProof,
    enabledTiers
  });
  const baselineScoreFloors = evaluateScoreFloors({
    repoResults: baselineSummary.repoResults,
    caseResults: baselineSummary.caseResults,
    globalQualityScore: baselineSummary.globalQualityScore,
    baseline,
    enabledTiers
  });
  const comparisonRepoResults = compareRepoResultsByArm(armSummaries, arms, targetArm, baselineArm);
  const comparisonTierResults = compareTierResultsByArm(armSummaries, arms, targetArm, baselineArm);
  const comparisonCaseResults = compareCaseResultsByRepo(
    Object.fromEntries(arms.map((arm) => [arm, armSummaries[arm].caseResults])),
    baselineArm,
    targetArm
  );
  const targetRepoResults = targetSummary.repoResults;
  const targetTierResults = targetSummary.tierResults;
  const targetGlobalQualityScore = targetSummary.globalQualityScore;
  const primaryWinner = (baselineSummary.globalQualityScore > targetGlobalQualityScore) ? baselineArm : targetArm;
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    passed: targetHardGate.passed && targetScoreFloors.passed,
    accepted: targetHardGate.passed && targetScoreFloors.passed,
    scoreModel: {
      version: SCORE_MODEL_VERSION,
      baseWeights: BASE_WEIGHTS
    },
    pool: pool.raw,
    enabledTiers,
    repoCount: enabledRepos.length,
    caseCount: enabledRepos.reduce((count, repo) => count + (fixtureMap[repo.id] ?? []).length, 0),
    targetArm,
    baselineArm,
    primaryWinner,
    repoResults: targetRepoResults,
    tierResults: targetTierResults,
    globalQualityScore: round2(targetGlobalQualityScore),
    baseline,
    hardGate: targetHardGate,
    scoreFloors: targetScoreFloors,
    nonMutationProof,
    poolValidation,
    materialization,
    comparison: {
      targetArm,
      baselineArm,
      primaryWinner,
      qualityMargin: round2(targetGlobalQualityScore - baselineSummary.globalQualityScore),
      arms: Object.fromEntries(arms.map((arm) => [
        arm,
        buildComparisonArmSnapshot(
          armSummaries[arm],
          arm === targetArm ? targetHardGate : baselineHardGate,
          arm === targetArm ? targetScoreFloors : baselineScoreFloors
        )
      ])),
      repoResults: comparisonRepoResults,
      tierResults: comparisonTierResults,
      caseResults: comparisonCaseResults
    },
    resultsDir: relative(ROOT, resultDir).split(sep).join('/'),
    queryRuns: runs,
    caseResults: targetSummary.caseResults,
    acceptedSummaryCandidate: accept
  };
  const report = createPoolComparisonReport(summary);
  writeFileSync(join(resultDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(resultDir, 'report.md'), report);
  rmSync(join(resultsRoot, 'latest'), { recursive: true, force: true });
  mkdirSync(resultsRoot, { recursive: true });
  safeCopyTree(resultDir, join(resultsRoot, 'latest'));
  return { summary, report, resultDir };
}

export function evaluateRepo(repo, cases, repoPath, runs) {
  const caseResults = cases.map((caseSpec) => evaluateCase(repo, caseSpec, repoPath, runs));
  return summarizeRepoFromCaseResults(repo, caseResults);
}

export function evaluateCase(repo, caseSpec, repoPath, runs = DEFAULT_RUNS) {
  return evaluateCaseForArm(repo, caseSpec, repoPath, runs, 'zincgraph-fusion');
}

export async function evaluateCaseAsync(repo, caseSpec, repoPath, runs = DEFAULT_RUNS) {
  return evaluateCaseForArmAsync(repo, caseSpec, repoPath, runs, 'zincgraph-fusion');
}

export function evaluateCaseForArm(repo, caseSpec, repoPath, runs = DEFAULT_RUNS, arm = 'zincgraph-fusion') {
  return {
    ...buildCaseResult(repo, caseSpec, repoPath, runCaseQueryForArm(repoPath, caseSpec.query, caseSpec.requiredTopK ?? 5, runs, arm)),
    arm
  };
}

export async function evaluateCaseForArmAsync(repo, caseSpec, repoPath, runs = DEFAULT_RUNS, arm = 'zincgraph-fusion') {
  const run = await runCaseQueryForArmAsync(repoPath, caseSpec.query, caseSpec.requiredTopK ?? 5, runs, arm);
  return {
    ...buildCaseResult(repo, caseSpec, repoPath, run),
    arm
  };
}

export function summarizeRepoFromCaseResults(repo, caseResults) {
  const passedCases = caseResults.filter((item) => item.hardGatePassed ?? item.passed);
  const score = round2(mean(caseResults.map((item) => item.totalScore)));
  const dimensions = meanDimensionScores(caseResults);
  const hardGate = {
    allQueriesSucceeded: caseResults.every((item) => item.queryStatus === 0),
    staleLeakageZero: caseResults.every((item) => item.staleLeakageCount === 0),
    passed: caseResults.every((item) => item.hardGatePassed ?? item.passed)
  };
  return {
    repoId: repo.id,
    tier: repo.tier,
    path: repo.path,
    repoUrl: repo.repoUrl,
    acquisition: repo.acquisition,
    caseCount: caseResults.length,
    passedCaseCount: passedCases.length,
    score,
    dimensions,
    hardGate,
    caseResults
  };
}

function buildCaseResult(repo, caseSpec, repoPath, run) {
  const capsule = run.capsule;
  const nodes = sortEvidenceNodes(capsule?.nodes ?? []);
  const topNodes = nodes.slice(0, Math.max(1, caseSpec.requiredTopK ?? 5));
  const allNodeText = buildEvidenceText(nodes, capsule?.edges ?? []);
  const topNodeText = buildEvidenceText(topNodes, capsule?.edges ?? []);
  const derivedRelations = deriveRelations(capsule, nodes, repoPath);
  const matchedGoldenFiles = uniqueMatches(caseSpec.goldenFiles ?? [], nodes.map((node) => node.filePath));
  const matchedGoldenSymbols = uniqueMatches(caseSpec.goldenSymbols ?? [], symbolIdentifiers(nodes));
  const matchedGoldenRelations = uniqueMatches(
    (caseSpec.goldenRelations ?? []).map((relation) => relationKey(relation)),
    derivedRelations.map((relation) => relationKey(relation))
  );
  const matchedGoldenImplementations = uniqueMatches(caseSpec.goldenImplementations ?? [], symbolIdentifiers(topNodes));
  const matchedAlternates = uniqueMatches(caseSpec.acceptableAlternates ?? [], symbolIdentifiers(topNodes));
  const matchedInvalidImplementations = uniqueMatches(caseSpec.invalidImplementations ?? [], symbolIdentifiers(topNodes));
  const matchedGoldenTests = uniqueMatches(caseSpec.goldenTests ?? [], nodes.map((node) => node.filePath));
  const matchedRuntimeArtifacts = uniqueMatches(caseSpec.goldenRuntimeArtifacts ?? [], nodes.map((node) => node.filePath));
  const matchedConsequenceTerms = uniqueTokenMatches(caseSpec.requiredConsequenceTerms ?? [], topNodeText);
  const forbiddenFalsePositiveHits = uniqueFalsePositiveHits(caseSpec.forbiddenFalsePositives ?? [], topNodes, allNodeText);
  const freshnessMatches = evaluateFreshness(caseSpec, topNodes, allNodeText);
  const impactMatches = evaluateImpact(caseSpec, topNodes, topNodeText, nodes);
  const applicability = {
    relation: (caseSpec.goldenRelations ?? []).length > 0,
    multi_impl:
      (caseSpec.goldenImplementations ?? []).length > 0 ||
      (caseSpec.acceptableAlternates ?? []).length > 0 ||
      /multiimplementation|connector|provider|plugin/i.test(String(caseSpec.family ?? '')),
    freshness:
      /freshness/i.test(String(caseSpec.family ?? '')) ||
      (caseSpec.freshnessSetup?.newTargets?.length ?? 0) > 0 ||
      (caseSpec.freshnessSetup?.staleTargets?.length ?? 0) > 0,
    impact:
      /impact/i.test(String(caseSpec.family ?? '')) ||
      caseSpec.impactRequired === true
  };
  const retrievalScore = computeRetrievalScore(caseSpec, nodes, topNodes, forbiddenFalsePositiveHits);
  const relationScore = applicability.relation ? clamp01(matchedGoldenRelations.length / Math.max(1, (caseSpec.goldenRelations ?? []).length)) : 0;
  const multiImplScore = applicability.multi_impl
    ? computeMultiImplScore(
      matchedGoldenImplementations.length > 0,
      matchedInvalidImplementations.length > 0,
      matchedAlternates.length > 0
    )
    : 0;
  const freshnessScore = applicability.freshness ? computeFreshnessScore(caseSpec, topNodes, freshnessMatches) : 0;
  const impactScore = applicability.impact ? computeImpactScore(caseSpec, topNodes, impactMatches) : 0;
  const dimensionScores = {
    retrieval: retrievalScore,
    relation: relationScore,
    multi_impl: multiImplScore,
    freshness: freshnessScore,
    impact: impactScore
  };
  const applicableDimensions = Object.entries(applicability).filter(([, enabled]) => enabled).map(([key]) => key);
  const totalScore = scoreCase(dimensionScores, applicableDimensions);
  const queryStatus = run.status;
  const staleLeakageCount = freshnessMatches.staleHits.length;
  const hardGateReasons = [];
  if (queryStatus !== 0) hardGateReasons.push(`query failed with status ${queryStatus}`);
  if (forbiddenFalsePositiveHits.length > 0) hardGateReasons.push(`forbidden false positives in topK: ${forbiddenFalsePositiveHits.join(', ')}`);
  if (staleLeakageCount > 0) hardGateReasons.push(`stale leakage in topK: ${freshnessMatches.staleHits.join(', ')}`);
  if (applicability.relation && matchedGoldenRelations.length < (caseSpec.goldenRelations ?? []).length) {
    const matchedRelationKeys = new Set(matchedGoldenRelations);
    const missingRelationKeys = (caseSpec.goldenRelations ?? [])
      .map((relation) => relationKey(relation))
      .filter((key) => !matchedRelationKeys.has(key));
    hardGateReasons.push(`missing relation evidence: ${missingRelationKeys.join(', ')}`);
  }
  if (applicability.multi_impl && multiImplScore === 0) {
    hardGateReasons.push('multi-implementation evidence missing or invalid-only');
  }
  if (applicability.freshness && freshnessScore < 0.5) {
    hardGateReasons.push('freshness evidence below gate');
  }
  if (applicability.impact && impactScore < 0.5) {
    hardGateReasons.push('impact evidence below gate');
  }
  return {
    repoId: repo.id,
    tier: repo.tier,
    queryId: caseSpec.queryId,
    family: caseSpec.family,
    query: caseSpec.query,
    difficulty: caseSpec.difficulty,
    requiredTopK: caseSpec.requiredTopK ?? 5,
    queryStatus,
    runCount: run.runs.length,
    selectedRunIndex: run.selectedRunIndex,
    medianLatencyMs: run.medianLatencyMs,
    outputBytes: Buffer.byteLength(run.scoringOutput),
    topNodes: topNodes.map((node) => ({
      nodeId: node.nodeId,
      filePath: node.filePath,
      kind: node.kind,
      language: node.language,
      qualifiedName: node.qualifiedName,
      score: round4(node.score),
      freshnessState: node.freshnessState ?? null
    })),
    goldenFiles: caseSpec.goldenFiles ?? [],
    goldenSymbols: caseSpec.goldenSymbols ?? [],
    goldenRelations: caseSpec.goldenRelations ?? [],
    goldenImplementations: caseSpec.goldenImplementations ?? [],
    acceptableAlternates: caseSpec.acceptableAlternates ?? [],
    invalidImplementations: caseSpec.invalidImplementations ?? [],
    goldenTests: caseSpec.goldenTests ?? [],
    goldenRuntimeArtifacts: caseSpec.goldenRuntimeArtifacts ?? [],
    requiredConsequenceTerms: caseSpec.requiredConsequenceTerms ?? [],
    requiredEvidenceTerms: caseSpec.requiredEvidenceTerms ?? [],
    forbiddenFalsePositives: caseSpec.forbiddenFalsePositives ?? [],
    matchedGoldenFiles,
    matchedGoldenSymbols,
    matchedGoldenRelations,
    matchedGoldenImplementations,
    matchedGoldenTests,
    matchedRuntimeArtifacts,
    matchedConsequenceTerms,
    forbiddenFalsePositiveHits,
    freshness: freshnessMatches,
    impact: impactMatches,
    applicability,
    dimensionScores,
    totalScore,
    staleLeakageCount,
    hardGatePassed: hardGateReasons.length === 0,
    passed: hardGateReasons.length === 0,
    hardGateReasons,
    capsule
  };
}

export function runCaseQuery(repoPath, query, topk, runs) {
  return runCaseQueryForArm(repoPath, query, topk, runs, 'zincgraph-fusion');
}

export function runCaseQueryForArm(repoPath, query, topk, runs, arm = 'zincgraph-fusion') {
  const records = [];
  for (let index = 0; index < Math.max(1, runs); index += 1) {
    const command = buildArmQueryCommand(arm, repoPath, query, topk);
    const result = runCommand(command, ROOT, 120_000);
    let capsule = null;
    let status = result.status;
    let stderr = result.stderr;
    if (result.status === 0) {
      try {
        capsule = normalizeQueryCapsule(arm, JSON.parse(result.stdout || 'null'));
      } catch (error) {
        status = 1;
        stderr = `parse failure: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    records.push({
      index,
      status,
      elapsedMs: result.elapsedMs,
      stdout: result.stdout ?? '',
      stderr,
      capsule
    });
  }
  const successful = records.filter((record) => record.status === 0 && record.capsule);
  const selected = selectMedianRun(successful);
  return {
    status: successful.length === records.length ? 0 : (records.find((record) => record.status !== 0)?.status ?? 1),
    selectedRunIndex: selected?.index ?? null,
    medianLatencyMs: round2(median(records.map((record) => record.elapsedMs))),
    scoringOutput: selected?.stdout ?? '',
    runs: records.map((record) => ({
      index: record.index,
      status: record.status,
      elapsedMs: round2(record.elapsedMs),
      stdoutBytes: Buffer.byteLength(record.stdout),
      stderrBytes: Buffer.byteLength(record.stderr)
    })),
    capsule: selected?.capsule ?? successful[0]?.capsule ?? null
  };
}

export async function runCaseQueryAsync(repoPath, query, topk, runs) {
  return runCaseQueryForArmAsync(repoPath, query, topk, runs, 'zincgraph-fusion');
}

export async function runCaseQueryForArmAsync(repoPath, query, topk, runs, arm = 'zincgraph-fusion') {
  const records = [];
  for (let index = 0; index < Math.max(1, runs); index += 1) {
    const command = buildArmQueryCommand(arm, repoPath, query, topk);
    const result = await runCommandAsync(command, ROOT, 120_000);
    let capsule = null;
    let status = result.status;
    let stderr = result.stderr;
    if (result.status === 0) {
      try {
        capsule = normalizeQueryCapsule(arm, JSON.parse(result.stdout || 'null'));
      } catch (error) {
        status = 1;
        stderr = `parse failure: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    records.push({
      index,
      status,
      elapsedMs: result.elapsedMs,
      stdout: result.stdout ?? '',
      stderr,
      capsule
    });
  }
  const successful = records.filter((record) => record.status === 0 && record.capsule);
  const selected = selectMedianRun(successful);
  return {
    status: successful.length === records.length ? 0 : (records.find((record) => record.status !== 0)?.status ?? 1),
    selectedRunIndex: selected?.index ?? null,
    medianLatencyMs: round2(median(records.map((record) => record.elapsedMs))),
    scoringOutput: selected?.stdout ?? '',
    runs: records.map((record) => ({
      index: record.index,
      status: record.status,
      elapsedMs: round2(record.elapsedMs),
      stdoutBytes: Buffer.byteLength(record.stdout),
      stderrBytes: Buffer.byteLength(record.stderr)
    })),
    capsule: selected?.capsule ?? successful[0]?.capsule ?? null
  };
}

export function buildArmQueryCommand(arm, repoPath, query, topk) {
  if (arm === 'codegraph') {
    return [process.execPath, CODEGRAPH_BIN, 'query', query, '-p', repoPath, '--json', '-l', String(topk)];
  }
  if (arm === 'zincgraph-fusion') {
    return [process.execPath, ZINCGRAPH_CLI, 'explore', '--full-json', '--fast-full-json', '-p', repoPath, '--topk', String(topk), query];
  }
  throw new Error(`Unsupported benchmark arm: ${arm}`);
}

export function normalizeQueryCapsule(arm, parsed) {
  if (arm === 'codegraph') {
    const items = Array.isArray(parsed) ? parsed : [];
    return {
      nodes: items.map((item, index) => normalizeCodegraphQueryNode(item, index)),
      edges: []
    };
  }
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.nodes)) return parsed;
    if (parsed.capsule && typeof parsed.capsule === 'object' && Array.isArray(parsed.capsule.nodes)) return parsed.capsule;
  }
  if (Array.isArray(parsed)) {
    return {
      nodes: parsed.map((item, index) => normalizeCodegraphQueryNode(item, index)),
      edges: []
    };
  }
  return { nodes: [], edges: [] };
}

function normalizeCodegraphQueryNode(item, index) {
  const node = item?.node ?? item ?? {};
  return {
    nodeId: String(node.id ?? `${node.kind ?? 'node'}:${node.filePath ?? node.qualifiedName ?? node.name ?? index}`),
    kind: node.kind ?? null,
    name: node.name ?? null,
    qualifiedName: node.qualifiedName ?? null,
    filePath: node.filePath ?? null,
    language: node.language ?? null,
    signature: node.signature ?? null,
    content: node.content ?? null,
    freshnessState: node.freshnessState ?? null,
    score: item?.score ?? node.score ?? null,
    toolRank: index
  };
}

export function validatePoolAgainstFixtures(pool, fixtureMap, enabledRepos, localMetadataPath) {
  const errors = [];
  const warnings = [];
  const raw = pool.raw ?? {};
  const repos = enabledRepos.length ? enabledRepos : pool.repos;
  if (raw.schemaVersion !== 1) errors.push(`Expected schemaVersion=1, got ${String(raw.schemaVersion)}.`);
  if (raw.scoreModel?.version !== SCORE_MODEL_VERSION) errors.push(`Expected scoreModel.version=${SCORE_MODEL_VERSION}, got ${String(raw.scoreModel?.version)}.`);
  if ((pool.repos?.length ?? 0) !== 6) errors.push(`Expected 6 repos, got ${String(pool.repos?.length ?? 0)}.`);
  const requiredFields = Array.isArray(raw.caseSchema?.requiredFields) ? raw.caseSchema.requiredFields : [];
  const localMetadata = existsSync(localMetadataPath) ? JSON.parse(readFileSync(localMetadataPath, 'utf8')) : null;
  for (const repo of repos) {
    const cases = fixtureMap[repo.id] ?? [];
    if (!existsSync(join(ROOT, repo.path))) {
      errors.push(`Missing materialized repo at ${repo.path}.`);
    }
    if (cases.length !== (repo.cases?.count ?? -1)) {
      errors.push(`Fixture count mismatch for ${repo.id}: got ${cases.length}, expected ${repo.cases?.count}.`);
    }
    validateFixtureCases({ repo, cases, requiredFields, errors });
    validateRepoProvenance({ repo, localMetadata, errors, warnings });
  }
  const fixtureCounts = {
    core: sumTierCasesFromFixtures(fixtureMap, 'core'),
    extended: sumTierCasesFromFixtures(fixtureMap, 'extended'),
    stress: sumTierCasesFromFixtures(fixtureMap, 'stress')
  };
  if (raw.caseCounts && JSON.stringify(fixtureCounts) !== JSON.stringify(raw.caseCounts)) {
    errors.push(`Fixture case counts ${JSON.stringify(fixtureCounts)} do not match contract ${JSON.stringify(raw.caseCounts)}.`);
  }
  const stressRepo = (Array.isArray(raw.repos) ? raw.repos : []).find((repo) => repo.tier === 'stress') ?? null;
  const stressEnabled = repos.some((repo) => repo.tier === 'stress');
  if (stressEnabled) {
    if (!localMetadata) {
      errors.push(`Stress local metadata is required at ${localMetadataPath} when the stress repo is enabled.`);
    } else {
      validateStressLocalMetadata({ localMetadata, stressRepo, rootDir: ROOT, errors });
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    expectedCounts: {
      core: sumTierCases(repos, 'core'),
      extended: sumTierCases(repos, 'extended'),
      stress: sumTierCases(repos, 'stress')
    },
    fixtureCounts
  };
}

function validateFixtureCases({ repo, cases, requiredFields, errors }) {
  cases.forEach((caseSpec, index) => {
    const prefix = `Fixture ${repo.id}[${index}]`;
    for (const field of requiredFields) {
      if (!Object.prototype.hasOwnProperty.call(caseSpec, field)) {
        errors.push(`${prefix} missing required field ${field}.`);
      }
    }
    if (caseSpec.repoId !== repo.id) {
      errors.push(`${prefix} repoId mismatch: got ${String(caseSpec.repoId)}, expected ${repo.id}.`);
    }
    if (caseSpec.tier !== repo.tier) {
      errors.push(`${prefix} tier mismatch: got ${String(caseSpec.tier)}, expected ${repo.tier}.`);
    }
    if (!String(caseSpec.queryId ?? '').trim()) {
      errors.push(`${prefix} queryId is required.`);
    }
    if (!String(caseSpec.query ?? '').trim()) {
      errors.push(`${prefix} query is required.`);
    }
    if (!String(caseSpec.family ?? '').trim()) {
      errors.push(`${prefix} family is required.`);
    }
    if (!Number.isInteger(caseSpec.requiredTopK) || caseSpec.requiredTopK <= 0) {
      errors.push(`${prefix} requiredTopK must be a positive integer.`);
    }
    for (const field of REQUIRED_CASE_ARRAY_FIELDS) {
      if (!Array.isArray(caseSpec[field])) {
        errors.push(`${prefix} ${field} must be an array.`);
      }
    }
    if (!caseSpec.freshnessSetup || typeof caseSpec.freshnessSetup !== 'object') {
      errors.push(`${prefix} freshnessSetup must be an object.`);
    } else {
      if (!Array.isArray(caseSpec.freshnessSetup.newTargets)) {
        errors.push(`${prefix} freshnessSetup.newTargets must be an array.`);
      }
      if (!Array.isArray(caseSpec.freshnessSetup.staleTargets)) {
        errors.push(`${prefix} freshnessSetup.staleTargets must be an array.`);
      }
    }
    if ((caseSpec.goldenFiles?.length ?? 0) === 0 && (caseSpec.goldenSymbols?.length ?? 0) === 0) {
      errors.push(`${prefix} must declare at least one golden file or golden symbol.`);
    }
  });
}

function validateRepoProvenance({ repo, localMetadata, errors, warnings }) {
  const archiveEntry = localMetadata?.archives?.[repo.id] ?? null;
  if (repo.tier === 'stress') return;
  if (!archiveEntry) {
    warnings.push(`Repo ${repo.id} is materialized without archive provenance metadata in bench/benchmark-pool.local.json.`);
    return;
  }
  if (String(archiveEntry.repoUrl ?? '') !== String(repo.repoUrl ?? '')) {
    errors.push(`Archive metadata repoUrl mismatch for ${repo.id}.`);
  }
  if (String(archiveEntry.extractedPath ?? '') !== String(repo.path ?? '')) {
    errors.push(`Archive metadata extractedPath mismatch for ${repo.id}.`);
  }
  if (!/^[0-9a-f]{64}$/iu.test(String(archiveEntry.archiveSha256 ?? ''))) {
    errors.push(`Archive metadata archiveSha256 must be a 64-hex SHA-256 for ${repo.id}.`);
  }
  if (!/^[0-9a-f]{7,40}$/iu.test(String(archiveEntry.sourceCommitSha ?? ''))) {
    errors.push(`Archive metadata sourceCommitSha must look like a git SHA for ${repo.id}.`);
  }
  if (!String(archiveEntry.materializedAt ?? '').trim()) {
    errors.push(`Archive metadata materializedAt is required for ${repo.id}.`);
  }
  if (archiveEntry.dirty !== false) {
    errors.push(`Archive metadata dirty must be false for ${repo.id}.`);
  }
  const archivePath = join(ROOT, String(archiveEntry.archivePath ?? ''));
  if (!existsSync(archivePath)) {
    errors.push(`Archive file missing for ${repo.id}: ${String(archiveEntry.archivePath ?? '')}.`);
  }
}

export function selectEnabledRepos(rawPool, localMetadataPath, options = {}) {
  const tiers = options.tiers?.length ? normalizeTierSet(options.tiers) : null;
  const repos = Array.isArray(rawPool.repos) ? rawPool.repos : [];
  const localMetadata = existsSync(localMetadataPath) ? JSON.parse(readFileSync(localMetadataPath, 'utf8')) : null;
  return repos.filter((repo) => {
    if (tiers && !tiers.includes(repo.tier)) return false;
    if (options.repos?.length && !options.repos.includes(repo.id)) return false;
    if (repo.tier === 'stress' && localMetadata && localMetadata.enabled !== true) return false;
    return true;
  });
}

export function validateStressLocalMetadata({ localMetadata, stressRepo, rootDir, errors }) {
  if (!localMetadata || !stressRepo) return;
  if (localMetadata.enabled !== true) errors.push('Stress local metadata must declare enabled=true when the stress repo is enabled.');
  if (localMetadata.dirty !== false) errors.push('Stress local metadata must declare dirty=false when enabled.');
  if (String(localMetadata.repoUrl ?? '') !== String(stressRepo.repoUrl ?? '')) errors.push(`Stress local metadata repoUrl must match pool stress repo URL ${String(stressRepo.repoUrl ?? '')}.`);
  if (!String(localMetadata.fetchedAt ?? '').trim()) errors.push('Stress local metadata fetchedAt is required when enabled.');

  const repoPath = resolve(rootDir, String(stressRepo.path ?? ''));
  const gitTopLevel = runCommand(['git', '-C', repoPath, 'rev-parse', '--show-toplevel'], rootDir, 10_000);
  const resolvedTopLevel = gitTopLevel.status === 0 ? resolve(gitTopLevel.stdout.trim()) : null;
  const hasOwnGitRoot = resolvedTopLevel === repoPath;
  if (hasOwnGitRoot) {
    const headResult = runCommand(['git', '-C', repoPath, 'rev-parse', 'HEAD'], rootDir, 10_000);
    if (headResult.status !== 0) {
      errors.push(`Unable to read stress repo HEAD for non-mutation validation: ${headResult.stderr || headResult.stdout || 'git rev-parse HEAD failed'}`);
    } else if (String(localMetadata.commitSha ?? '') !== headResult.stdout.trim()) {
      errors.push(`Stress local metadata commitSha must match local HEAD ${headResult.stdout.trim()}.`);
    }
    return;
  }

  const archiveEntry = getStressArchiveEntry(localMetadata, String(stressRepo.id ?? 'airbyte'));
  if (!archiveEntry) {
    errors.push(`Stress repo ${String(stressRepo.id ?? 'airbyte')} is neither a git repo with its own top-level nor backed by archive provenance.`);
    return;
  }
  if (archiveEntry.dirty !== false) errors.push('Stress archive metadata must declare dirty=false when enabled.');
  if (String(archiveEntry.repoUrl ?? '') !== String(stressRepo.repoUrl ?? '')) errors.push(`Stress archive metadata repoUrl must match pool stress repo URL ${String(stressRepo.repoUrl ?? '')}.`);
  if (!/^[0-9a-f]{64}$/iu.test(String(archiveEntry.archiveSha256 ?? ''))) errors.push('Stress archive metadata archiveSha256 must be a 64-hex SHA-256.');
  if (!/^[0-9a-f]{7,40}$/iu.test(String(archiveEntry.sourceCommitSha ?? ''))) errors.push('Stress archive metadata sourceCommitSha must look like a git SHA.');
  if (String(archiveEntry.extractedPath ?? '') !== String(stressRepo.path ?? '')) errors.push(`Stress archive metadata extractedPath must match ${String(stressRepo.path ?? '')}.`);
  if (!String(archiveEntry.materializedAt ?? '').trim()) errors.push('Stress archive metadata materializedAt is required.');
  if (String(localMetadata.commitSha ?? '') !== String(archiveEntry.sourceCommitSha ?? '')) errors.push(`Stress local metadata commitSha must match archive sourceCommitSha ${String(archiveEntry.sourceCommitSha ?? '')}.`);
}

export function getStressArchiveEntry(localMetadata, repoId) {
  const archives = localMetadata?.archives;
  if (!archives || typeof archives !== 'object') return null;
  const keyed = archives[repoId];
  if (keyed && typeof keyed === 'object') return keyed;
  if (archives.sourceCommitSha || archives.archiveSha256 || archives.extractedPath || archives.archivePath) {
    return archives;
  }
  return null;
}

export function fingerprintSourceRepoStates(rootDir, repos, localMetadataPath = DEFAULT_LOCAL_METADATA_PATH) {
  const localMetadata = existsSync(localMetadataPath) ? JSON.parse(readFileSync(localMetadataPath, 'utf8')) : null;
  const states = {};
  for (const repo of repos) {
    const repoPath = resolve(rootDir, String(repo.path ?? ''));
    const localRoots = fingerprintRoots(repoPath, ['.codegraph', '.zincgraph']);
    const gitTopLevel = runCommand(['git', '-C', repoPath, 'rev-parse', '--show-toplevel'], rootDir, 10_000);
    const resolvedTopLevel = gitTopLevel.status === 0 ? resolve(gitTopLevel.stdout.trim()) : null;
    const state = {
      exists: existsSync(repoPath),
      path: relative(rootDir, repoPath).split(sep).join('/'),
      localRoots
    };
    if (resolvedTopLevel === repoPath) {
      const headResult = runCommand(['git', '-C', repoPath, 'rev-parse', 'HEAD'], rootDir, 10_000);
      const dirtyResult = runCommand(['git', '-C', repoPath, 'status', '--porcelain'], rootDir, 10_000);
      state.git = {
        topLevel: resolvedTopLevel,
        head: headResult.status === 0 ? headResult.stdout.trim() : null,
        dirty: dirtyResult.status === 0 ? dirtyResult.stdout.trim().length > 0 : null
      };
    } else {
      const archiveEntry = getStressArchiveEntry(localMetadata, String(repo.id ?? ''));
      state.archive = archiveEntry
        ? {
            archivePath: String(archiveEntry.archivePath ?? ''),
            archiveSha256: String(archiveEntry.archiveSha256 ?? ''),
            sourceCommitSha: String(archiveEntry.sourceCommitSha ?? ''),
            extractedPath: String(archiveEntry.extractedPath ?? ''),
            materializedAt: String(archiveEntry.materializedAt ?? ''),
            dirty: archiveEntry.dirty === true
          }
        : null;
    }
    states[String(repo.id ?? state.path)] = state;
  }
  return states;
}

export function ensureRepoReady(repoPath, repoId) {
  const dbPath = join(repoPath, '.codegraph', 'codegraph.db');
  if (existsSync(dbPath)) {
    return { repoId, ok: true, action: 'present' };
  }
  const init = runCommand([process.execPath, CODEGRAPH_BIN, 'init', repoPath], ROOT, 120_000);
  if (init.status !== 0) {
    return {
      repoId,
      ok: false,
      action: 'init-failed',
      error: init.stderr || init.stdout || `codegraph init failed for ${repoPath}`
    };
  }
  return { repoId, ok: true, action: 'initialized' };
}

export function loadAcceptedBaselineSummary(resultsRoot, criteria) {
  const artifacts = collectSummaryArtifacts(resultsRoot);
  const candidates = artifacts
    .map((artifact) => {
      try {
        return { artifact, summary: JSON.parse(readFileSync(artifact, 'utf8')) };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter(({ summary }) => {
      const sameVersion = summary.schemaVersion === criteria.schemaVersion;
      const sameScoreModel = summary.scoreModel?.version === criteria.scoreModelVersion;
      const sameTiers = JSON.stringify(normalizeTierSet(summary.enabledTiers ?? [])) === JSON.stringify(normalizeTierSet(criteria.enabledTiers ?? []));
      return summary.accepted === true &&
        summary.acceptedSummaryCandidate === true &&
        sameVersion &&
        sameScoreModel &&
        sameTiers;
    })
    .sort((left, right) => String(right.summary.generatedAt ?? '').localeCompare(String(left.summary.generatedAt ?? '')));
  const winner = candidates[0];
  if (!winner) return { found: false };
  return {
    found: true,
    path: relative(ROOT, winner.artifact).split(sep).join('/'),
    generatedAt: winner.summary.generatedAt,
    scoreModelVersion: winner.summary.scoreModel?.version ?? null,
    enabledTiers: winner.summary.enabledTiers ?? [],
    globalQualityScore: Number(winner.summary.globalQualityScore ?? 0)
  };
}

export function createPoolReport(summary) {
  const repoRows = (summary.repoResults ?? []).map((repo) => {
    const gate = repo.hardGate?.passed ? 'pass' : 'fail';
    return `| ${repo.repoId} | ${repo.tier} | ${repo.caseCount} | ${repo.passedCaseCount} | ${repo.score.toFixed(2)} | ${gate} |`;
  }).join('\n');
  const tierRows = Object.entries(summary.tierResults ?? {}).map(([tier, value]) => `| ${tier} | ${value.repoCount} | ${value.caseCount} | ${value.score.toFixed(2)} |`).join('\n');
  const failingCases = (summary.caseResults ?? []).filter((item) => !item.hardGatePassed || item.totalScore < 70);
  const failingCaseRows = failingCases.map((item) => `| ${item.repoId} | ${item.queryId} | ${item.totalScore.toFixed(2)} | ${item.hardGateReasons.join('; ') || 'n/a'} |`).join('\n');
  const baselineLine = summary.baseline?.found
    ? `baseline: ${summary.baseline.path} (${summary.baseline.globalQualityScore.toFixed(2)})`
    : 'baseline: first run or no accepted artifact matched';
  return `# Open-Source Pool Benchmark Report

- generatedAt: ${summary.generatedAt}
- accepted: ${summary.accepted}
- scoreModelVersion: ${summary.scoreModel?.version ?? 'n/a'}
- enabledTiers: ${(summary.enabledTiers ?? []).join(', ')}
- repoCount: ${summary.repoCount}
- caseCount: ${summary.caseCount}
- globalQualityScore: ${summary.globalQualityScore.toFixed(2)}
- hardGate: ${summary.hardGate?.passed ? 'passed' : 'failed'}
- scoreFloors: ${summary.scoreFloors?.passed ? 'passed' : 'failed'}
- nonMutationProof: ${summary.nonMutationProof?.passed ? 'passed' : 'failed'}
- poolMaterialization: ${summary.materialization?.ok ? 'passed' : 'failed'}
- ${baselineLine}

## Repo Scores

| Repo | Tier | Cases | Passed cases | Score | Hard gate |
|---|---|---:|---:|---:|---|
${repoRows || '| none | none | 0 | 0 | 0.00 | n/a |'}

## Tier Scores

| Tier | Repos | Cases | Score |
|---|---:|---:|---:|
${tierRows || '| none | 0 | 0 | 0.00 |'}

## Hard Gate Summary

- pool validation: ${summary.hardGate?.poolValidation?.ok ? 'pass' : 'fail'}
- pool materialization: ${summary.materialization?.ok ? 'pass' : 'fail'}
- repo readiness: ${(summary.hardGate?.readiness ?? []).every((item) => item.ok) ? 'pass' : 'fail'}
- core queries succeeded: ${summary.hardGate?.allCoreQueriesSucceeded ? 'pass' : 'fail'}
- freshness leakage zero: ${summary.hardGate?.freshnessLeakageZero ? 'pass' : 'fail'}
- non-mutation proof: ${summary.nonMutationProof?.passed ? 'pass' : 'fail'}
- source repo states: ${(summary.nonMutationProof?.changedRepoStates ?? []).length === 0 ? 'pass' : 'fail'}

## Score Floors

- core case floor: ${summary.scoreFloors?.coreCaseFloor ? 'pass' : 'fail'}
- core repo floor: ${summary.scoreFloors?.coreRepoFloor ? 'pass' : 'fail'}
- baseline floor: ${summary.scoreFloors?.baselineFloor ? 'pass' : 'fail'}

## Failing Cases

| Repo | Case | Score | Reasons |
|---|---|---:|---|
${failingCaseRows || '| none | none | 0.00 | none |'}
`;
}

export function createPoolComparisonReport(summary) {
  const comparison = summary.comparison ?? {};
  const targetArm = comparison.targetArm ?? summary.targetArm ?? 'zincgraph-fusion';
  const baselineArm = comparison.baselineArm ?? summary.baselineArm ?? 'codegraph';
  const armRows = Object.entries(comparison.arms ?? {})
    .map(([arm, armSummary]) => `| ${arm} | ${armSummary.totalScore.toFixed(2)} | ${fmtScore(armSummary.dimensionScores.retrieval)} | ${fmtScore(armSummary.dimensionScores.relation)} | ${fmtScore(armSummary.dimensionScores.multi_impl)} | ${fmtScore(armSummary.dimensionScores.freshness)} | ${fmtScore(armSummary.dimensionScores.impact)} | ${armSummary.raw.medianLatencyMs} | ${armSummary.raw.totalOutputBytes} | ${armSummary.raw.tasksPassed} / ${armSummary.raw.applicableTasks} | ${armSummary.hardGate?.passed ? 'pass' : 'fail'} |`)
    .join('\n');
  const repoRows = (comparison.repoResults ?? []).map((repo) => {
    const baselineScore = Number(repo.byArm?.[baselineArm]?.score ?? 0);
    const targetScore = Number(repo.byArm?.[targetArm]?.score ?? 0);
    return `| ${repo.repoId} | ${repo.tier} | ${repo.caseCount} | ${baselineScore.toFixed(2)} | ${targetScore.toFixed(2)} | ${repo.delta.toFixed(2)} | ${repo.winner} |`;
  }).join('\n');
  const tierRows = Object.entries(comparison.tierResults ?? {}).map(([tier, value]) => {
    const baselineScore = Number(value.byArm?.[baselineArm]?.score ?? 0);
    const targetScore = Number(value.byArm?.[targetArm]?.score ?? 0);
    return `| ${tier} | ${baselineScore.toFixed(2)} | ${targetScore.toFixed(2)} | ${value.delta.toFixed(2)} | ${value.winner} |`;
  }).join('\n');
  const caseRows = (comparison.caseResults ?? [])
    .filter((item) => item.byArm?.[baselineArm] || item.byArm?.[targetArm])
    .map((item) => {
      const baselineCase = item.byArm?.[baselineArm] ?? null;
      const targetCase = item.byArm?.[targetArm] ?? null;
      const baselineScore = Number(baselineCase?.totalScore ?? 0);
      const targetScore = Number(targetCase?.totalScore ?? 0);
      const baselineReasons = baselineCase?.hardGateReasons?.join('; ') || 'pass';
      const targetReasons = targetCase?.hardGateReasons?.join('; ') || 'pass';
      return `| ${item.repoId} | ${item.queryId} | ${baselineScore.toFixed(2)} | ${targetScore.toFixed(2)} | ${round2(targetScore - baselineScore).toFixed(2)} | ${item.winner} | ${baselineReasons} | ${targetReasons} |`;
    })
    .join('\n');
  const baselineLine = summary.baseline?.found
    ? `baseline: ${summary.baseline.path} (${summary.baseline.globalQualityScore.toFixed(2)})`
    : 'baseline: first run or no accepted artifact matched';
  return `# Open-Source Pool A/B Benchmark Report

- generatedAt: ${summary.generatedAt}
- accepted: ${summary.accepted}
- scoreModelVersion: ${summary.scoreModel?.version ?? 'n/a'}
- enabledTiers: ${(summary.enabledTiers ?? []).join(', ')}
- repoCount: ${summary.repoCount}
- caseCount: ${summary.caseCount}
- targetArm: ${targetArm}
- baselineArm: ${baselineArm}
- primaryWinner: ${summary.primaryWinner ?? 'n/a'}
- targetGlobalQualityScore: ${summary.globalQualityScore.toFixed(2)}
- qualityMargin: ${comparison.qualityMargin?.toFixed(2) ?? '0.00'}
- hardGate: ${summary.hardGate?.passed ? 'passed' : 'failed'}
- scoreFloors: ${summary.scoreFloors?.passed ? 'passed' : 'failed'}
- nonMutationProof: ${summary.nonMutationProof?.passed ? 'passed' : 'failed'}
- poolMaterialization: ${summary.materialization?.ok ? 'passed' : 'failed'}
- ${baselineLine}

## Arm Scores

| Arm | Quality total | Retrieval | Relation | Multi impl | Freshness | Impact | Median latency ms | Output bytes | Passed cases | Hard gate |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
${armRows || '| none | 0.00 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0 | 0 | 0 / 0 | n/a |'}

## Repo Comparison

| Repo | Tier | Cases | CodeGraph | Zincgraph | Delta | Winner |
|---|---|---:|---:|---:|---:|---|
${repoRows || '| none | none | 0 | 0.00 | 0.00 | 0.00 | tie |'}

## Tier Comparison

| Tier | CodeGraph | Zincgraph | Delta | Winner |
|---|---:|---:|---:|---|
${tierRows || '| none | 0.00 | 0.00 | 0.00 | tie |'}

## Case Comparison

| Repo | Case | CodeGraph | Zincgraph | Delta | Winner | CodeGraph reasons | Zincgraph reasons |
|---|---|---:|---:|---:|---|---|---|
${caseRows || '| none | none | 0.00 | 0.00 | 0.00 | tie | n/a | n/a |'}

## Target Hard Gate Summary

- pool validation: ${summary.poolValidation?.ok ? 'pass' : 'fail'}
- pool materialization: ${summary.materialization?.ok ? 'pass' : 'fail'}
- repo readiness: ${(summary.hardGate?.readiness ?? []).every((item) => item.ok) ? 'pass' : 'fail'}
- core queries succeeded: ${summary.hardGate?.allCoreQueriesSucceeded ? 'pass' : 'fail'}
- freshness leakage zero: ${summary.hardGate?.freshnessLeakageZero ? 'pass' : 'fail'}
- non-mutation proof: ${summary.nonMutationProof?.passed ? 'pass' : 'fail'}
- source repo states: ${(summary.nonMutationProof?.changedRepoStates ?? []).length === 0 ? 'pass' : 'fail'}

## Score Floors

- core case floor: ${summary.scoreFloors?.coreCaseFloor ? 'pass' : 'fail'}
- core repo floor: ${summary.scoreFloors?.coreRepoFloor ? 'pass' : 'fail'}
- baseline floor: ${summary.scoreFloors?.baselineFloor ? 'pass' : 'fail'}

## Benchmark Pool Contract

- schemaVersion: ${summary.pool?.schemaVersion ?? 'n/a'}
- scoreModelVersion: ${summary.pool?.scoreModel?.version ?? 'n/a'}
- repoCount: ${(summary.pool?.repos ?? []).length}
- tiers: core=${(summary.pool?.repos ?? []).filter((repo) => repo.tier === 'core').length}, extended=${(summary.pool?.repos ?? []).filter((repo) => repo.tier === 'extended').length}, stress=${(summary.pool?.repos ?? []).filter((repo) => repo.tier === 'stress').length}
- caseCounts: core=${sumTierCases(summary.pool?.repos ?? [], 'core')}, extended=${sumTierCases(summary.pool?.repos ?? [], 'extended')}, stress=${sumTierCases(summary.pool?.repos ?? [], 'stress')}

## Failing Cases

${(comparison.caseResults ?? []).filter((item) => {
  const baselineCase = item.byArm?.[baselineArm];
  const targetCase = item.byArm?.[targetArm];
  return !baselineCase?.passed || !targetCase?.passed || (baselineCase?.totalScore ?? 0) !== (targetCase?.totalScore ?? 0);
}).map((item) => {
  const baselineCase = item.byArm?.[baselineArm] ?? null;
  const targetCase = item.byArm?.[targetArm] ?? null;
  const baselineReasons = baselineCase?.hardGateReasons?.join('; ') || 'pass';
  const targetReasons = targetCase?.hardGateReasons?.join('; ') || 'pass';
  return `| ${item.repoId} | ${item.queryId} | ${Number(baselineCase?.totalScore ?? 0).toFixed(2)} | ${Number(targetCase?.totalScore ?? 0).toFixed(2)} | ${targetReasons === 'pass' ? 'pass' : 'fail'} | ${baselineReasons} | ${targetReasons} |`;
}).join('\n') || '| none | none | 0.00 | 0.00 | pass | n/a | n/a |'}
`;
}

export function buildNonMutationProof(before, after, beforeRepoStates = {}, afterRepoStates = {}) {
  const diff = diffFingerprints(before, after);
  const repoStateDiff = diffRepoStates(beforeRepoStates, afterRepoStates);
  return {
    watchedRoots: ['.codegraph', '.zincgraph', 'bench/benchmark-pool.json', 'bench/benchmark-pool.local.json'],
    before,
    after,
    beforeRepoStates,
    afterRepoStates,
    changedPaths: diff.changedPaths,
    sqliteVolatilePaths: diff.sqliteVolatilePaths,
    changedRepoStates: repoStateDiff.changedRepoStates,
    passed: diff.changedPaths.length === 0 && repoStateDiff.changedRepoStates.length === 0
  };
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

export function diffFingerprints(before, after) {
  const changedPaths = [];
  const sqliteVolatilePaths = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    const left = before[key];
    const right = after[key];
    if (JSON.stringify(left) === JSON.stringify(right)) continue;
    if (isVolatileFingerprintPath(key) && left && right && left.exists && right.exists) {
      sqliteVolatilePaths.push(key);
      continue;
    }
    changedPaths.push(key);
  }
  return { changedPaths, sqliteVolatilePaths };
}

export function diffRepoStates(beforeRepoStates = {}, afterRepoStates = {}) {
  const changedRepoStates = [];
  const keys = new Set([...Object.keys(beforeRepoStates), ...Object.keys(afterRepoStates)]);
  for (const key of [...keys].sort()) {
    const before = normalizeRepoStateForComparison(beforeRepoStates[key]);
    const after = normalizeRepoStateForComparison(afterRepoStates[key]);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    changedRepoStates.push({
      repoId: key,
      before: before ?? null,
      after: after ?? null
    });
  }
  return { changedRepoStates };
}

export function runCommand(command, cwd, timeout = 60_000) {
  const t0 = performance.now();
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: 50 * 1024 * 1024,
    shell: false
  });
  const t1 = performance.now();
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
    elapsedMs: t1 - t0
  };
}

export function runCommandAsync(command, cwd, timeout = 60_000) {
  const t0 = performance.now();
  return new Promise((resolve) => {
    execFile(command[0], command.slice(1), {
      cwd,
      encoding: 'utf8',
      timeout,
      maxBuffer: 50 * 1024 * 1024,
      shell: false
    }, (error, stdout = '', stderr = '') => {
      const t1 = performance.now();
      resolve({
        status: typeof error?.code === 'number' ? error.code : (error ? 1 : 0),
        stdout: stdout ?? '',
        stderr: stderr ?? error?.message ?? '',
        elapsedMs: t1 - t0
      });
    });
  });
}

export function selectMedianRun(records) {
  if (!records.length) return null;
  const medianLatency = median(records.map((record) => record.elapsedMs));
  return [...records].sort((left, right) => {
    const leftDelta = Math.abs(left.elapsedMs - medianLatency);
    const rightDelta = Math.abs(right.elapsedMs - medianLatency);
    if (leftDelta !== rightDelta) return leftDelta - rightDelta;
    if (left.index !== right.index) return left.index - right.index;
    return Buffer.byteLength(left.stdout ?? '') - Buffer.byteLength(right.stdout ?? '');
  })[0];
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

async function mapWithConcurrency(items, concurrency, mapper) {
  if (!items.length) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      results[current] = await mapper(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

function isSqliteVolatilePath(path) {
  return /\.codegraph\/.*\.(db-wal|db-shm)$/.test(path) || /\.zincgraph\/.*\.(sqlite-wal|sqlite-shm)$/.test(path);
}

function normalizeRepoStateForComparison(state) {
  if (!state || typeof state !== 'object') return state;
  const localRoots = state.localRoots && typeof state.localRoots === 'object'
    ? Object.fromEntries(
      Object.entries(state.localRoots)
        .filter(([path]) => !isVolatileFingerprintPath(path))
        .map(([path, entry]) => [path, stripMtime(entry)])
        .sort(([left], [right]) => left.localeCompare(right))
    )
    : state.localRoots;
  return {
    ...state,
    localRoots
  };
}

function stripMtime(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const { mtimeMs, ...rest } = entry;
  return rest;
}

function isVolatileFingerprintPath(path) {
  // Runtime index/cache roots can update aggregate directory mtimes, daemon
  // sidecars, and SQLite WAL/SHM files during read-only benchmark queries. The
  // non-mutation proof only exempts those generated volatile entries; regular
  // child fingerprints and source-repo provenance still participate in the gate.
  return path === '.codegraph' ||
    path === '.zincgraph' ||
    isSqliteVolatilePath(path) ||
    /\.codegraph\/daemon\.(log|pid|sock)$/.test(path) ||
    /\.zincgraph\/daemon\.(log|pid|sock)$/.test(path);
}

function sumTierCases(repos, tier) {
  return repos.filter((repo) => repo.tier === tier).reduce((sum, repo) => sum + (repo.cases?.count ?? 0), 0);
}

function sumTierCasesFromFixtures(fixtureMap, tier) {
  return Object.values(fixtureMap).flat().filter((item) => item.tier === tier).length;
}

function collectSummaryArtifacts(resultsRoot) {
  const artifacts = [];
  if (!existsSync(resultsRoot)) return artifacts;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name === 'summary.json') {
        artifacts.push(full);
      }
    }
  };
  walk(resultsRoot);
  return artifacts;
}

function safeCopyTree(source, target) {
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
}

async function runMain() {
  const options = parsePoolBenchmarkArgs(process.argv.slice(2));
  const result = await runPoolBenchmark(options);
  console.log(JSON.stringify(result.summary, null, 2));
  console.log(`\n${result.report}`);
  if (!result.summary.accepted) {
    process.exitCode = 1;
  }
}

function buildEvidenceText(nodes, edges) {
  return [
    ...nodes.flatMap((node) => [
      node.filePath,
      node.qualifiedName,
      node.name,
      node.content ?? '',
      node.signature ?? ''
    ]),
    ...((edges ?? []).map((edge) => `${edge.kind}:${edge.source}:${edge.targetName}`))
  ].join('\n').toLowerCase();
}

function deriveRelations(capsule, nodes, repoPath) {
  const relations = [];
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  const nodeByQualified = new Map(nodes.flatMap((node) => [
    [node.qualifiedName, node],
    [node.name, node],
    [node.qualifiedName?.split('::').at(-1) ?? node.name, node]
  ]));
  for (const node of nodes) {
    relations.push({ kind: 'contains', from: node.filePath, to: node.qualifiedName });
    relations.push({ kind: 'contains', from: node.filePath, to: node.name });
    const content = readNodeSource(repoPath, node.filePath, node.content);
    const signature = String(node.signature ?? '');
    const importMatches = [
      ...content.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g),
      ...content.matchAll(/^\s*from\s+([A-Za-z0-9_./-]+(?:\.[A-Za-z0-9_./-]+)*)\s+import\s+/gm),
      ...content.matchAll(/^\s*import\s+([A-Za-z0-9_./-]+(?:\.[A-Za-z0-9_./-]+)*(?:\s+as\s+\w+)?)\s*$/gm)
    ].map((match) => String(match[1] ?? match[0]).split(/\s+as\s+/i)[0].trim());
    for (const specifier of importMatches) {
      relations.push({ kind: 'imports', from: node.filePath, to: specifier });
      relations.push({ kind: 'imports', from: node.filePath, to: basename(specifier) });
      for (const resolved of resolveImportTargets(node.filePath, specifier, nodes)) {
        relations.push({ kind: 'imports', from: node.filePath, to: resolved });
      }
    }
    const extendsMatch = signature.match(/extends\s+([A-Za-z0-9_.:<>]+)/i) ?? content.match(/extends\s+([A-Za-z0-9_.:<>]+)/i);
    if (extendsMatch) relations.push({ kind: 'inherits', from: node.qualifiedName, to: extendsMatch[1] });
    const implementsMatch = signature.match(/implements\s+([A-Za-z0-9_,.\s:<>]+)/i) ?? content.match(/implements\s+([A-Za-z0-9_,.\s:<>]+)/i);
    if (implementsMatch) {
      for (const part of implementsMatch[1].split(',').map((item) => item.trim()).filter(Boolean)) {
        relations.push({ kind: 'inherits', from: node.qualifiedName, to: part });
      }
    }
    const returnMatch = signature.match(/:\s*([A-Za-z0-9_.:<>]+)$/) ?? content.match(/->\s*([A-Za-z0-9_.:<>]+)/);
    if (returnMatch) relations.push({ kind: 'returns', from: node.qualifiedName, to: returnMatch[1] });
  }
  for (const edge of capsule?.edges ?? []) {
    const sourceNode = nodeById.get(edge.source);
    const targetNode = nodeByQualified.get(edge.targetName) ?? nodeByQualified.get(edge.targetName?.split('::').at(-1) ?? edge.targetName);
    if (!sourceNode) continue;
    relations.push({
      kind: edge.kind,
      from: sourceNode.qualifiedName ?? sourceNode.name ?? sourceNode.filePath,
      to: targetNode?.qualifiedName ?? targetNode?.name ?? edge.targetName
    });
  }
  return relations;
}

function readNodeSource(repoPath, filePath, fallbackContent) {
  if (!repoPath || !filePath) return String(fallbackContent ?? '');
  const absolutePath = join(repoPath, filePath);
  if (!existsSync(absolutePath)) return String(fallbackContent ?? '');
  try {
    return readFileSync(absolutePath, 'utf8');
  } catch {
    return String(fallbackContent ?? '');
  }
}

export function resolveImportTargets(sourceFilePath, specifier, nodes) {
  const normalized = String(specifier ?? '').trim().replace(/^['"]|['"]$/g, '');
  if (!normalized) return [];
  const candidates = new Set([
    normalized,
    normalized.replace(/::/g, '/'),
    normalized.replace(/\./g, '/'),
    normalized.replace(/::/g, '/').replace(/\./g, '/')
  ]);
  if (normalized.startsWith('./') || normalized.startsWith('../')) {
    const fromDir = dirname(sourceFilePath);
    const joined = normalize(join(fromDir, normalized)).split(sep).join('/');
    candidates.add(joined);
    candidates.add(relative('.', joined).split(sep).join('/'));
  }
  const extensions = ['', '.py', '.rs', '.ts', '.tsx', '.js', '.jsx', '.go', '.java', '.kt', '.md', '.json', '.cts', '.mts', '.cjs', '.mjs', '.d.ts'];
  for (const candidate of [...candidates]) {
    if (/\.[A-Za-z0-9]+$/.test(candidate)) continue;
    for (const ext of extensions) {
      candidates.add(`${candidate}${ext}`);
    }
  }
  const resolved = new Set();
  for (const candidate of candidates) {
    const normalizedCandidate = String(candidate).replace(/\\/g, '/').replace(/^\.\/+/, '');
    for (const node of nodes) {
      const filePath = String(node.filePath ?? '');
      if (filePath === normalizedCandidate || filePath.endsWith(normalizedCandidate)) {
        resolved.add(filePath);
      }
    }
  }
  return [...resolved];
}

function relationKey(relation) {
  return `${relation.kind}|${relation.from}|${relation.to}`;
}

function diffList(expected, actual, keyFn) {
  const actualKeys = new Set(actual.map((item) => keyFn(item)));
  return expected.map((item) => keyFn(item)).filter((key) => !actualKeys.has(key));
}

function uniqueMatches(expected, actual) {
  const hits = [];
  const seen = new Set();
  for (const item of expected) {
    if (actual.includes(item) && !seen.has(item)) {
      seen.add(item);
      hits.push(item);
    }
  }
  return hits;
}

function uniqueTokenMatches(expected, text) {
  const tokens = new Set(String(text ?? '').split(/[^A-Za-z0-9_.:-]+/g).map((token) => token.trim().toLowerCase()).filter(Boolean));
  return [...new Set(expected.filter((term) => tokens.has(String(term).toLowerCase())))];
}

function uniqueFalsePositiveHits(entries, topNodes, allText) {
  const nodeText = buildEvidenceText(topNodes, []).toLowerCase();
  const tokenSet = tokenized(allText);
  return [...new Set((entries ?? []).filter((entry) => {
    const lower = String(entry).toLowerCase();
    if (lower.includes('/') || lower.includes('.')) {
      return nodeText.includes(lower) || topNodes.some((node) => String(node.filePath ?? '').endsWith(lower));
    }
    return tokenSet.has(lower) || topNodes.some((node) => String(node.name ?? '').toLowerCase() === lower || String(node.qualifiedName ?? '').toLowerCase() === lower);
  }))];
}

function tokenized(text) {
  return new Set(String(text ?? '').split(/[^A-Za-z0-9_.:-]+/g).map((token) => token.trim().toLowerCase()).filter(Boolean));
}

function textHasToken(text, token) {
  return tokenized(text).has(String(token).toLowerCase());
}

function exactSetHas(set, value) {
  return set.has(String(value));
}

function sortEvidenceNodes(nodes) {
  return [...nodes].map((node, index) => ({ ...node, _index: index })).sort((left, right) => {
    const leftTool = Number.isFinite(left.toolRank) ? left.toolRank : Number.POSITIVE_INFINITY;
    const rightTool = Number.isFinite(right.toolRank) ? right.toolRank : Number.POSITIVE_INFINITY;
    if (leftTool !== rightTool) return leftTool - rightTool;
    const leftLatency = Number.isFinite(left.latencySourceRank) ? left.latencySourceRank : Number.POSITIVE_INFINITY;
    const rightLatency = Number.isFinite(right.latencySourceRank) ? right.latencySourceRank : Number.POSITIVE_INFINITY;
    if (leftLatency !== rightLatency) return leftLatency - rightLatency;
    const leftLen = String(left.filePath ?? '').length;
    const rightLen = String(right.filePath ?? '').length;
    if (leftLen !== rightLen) return leftLen - rightLen;
    const pathCompare = String(left.filePath ?? '').localeCompare(String(right.filePath ?? ''));
    if (pathCompare !== 0) return pathCompare;
    return left._index - right._index;
  });
}

function buildNodeText(nodes) {
  return nodes.map((node) => [
    node.filePath,
    node.qualifiedName,
    node.name,
    node.kind,
    node.content,
    node.signature,
    node.freshnessState
  ].filter(Boolean).join('\n')).join('\n').toLowerCase();
}

function topNodeIdentifiers(nodes) {
  return nodes.flatMap((node) => [node.filePath, node.qualifiedName, node.name, node.qualifiedName?.split('::').at(-1) ?? node.name]).filter(Boolean);
}

function topNodeFilePaths(nodes) {
  return nodes.map((node) => node.filePath);
}

function symbolIdentifiers(nodes) {
  return nodes.flatMap((node) => [node.name, node.qualifiedName, node.qualifiedName?.split('::').at(-1) ?? node.name]).filter(Boolean);
}

function evaluateFreshness(caseSpec, topNodes, allText) {
  const newTargets = caseSpec.freshnessSetup?.newTargets ?? [];
  const staleTargets = caseSpec.freshnessSetup?.staleTargets ?? [];
  const topIdentifiers = new Set(topNodeIdentifiers(topNodes));
  const staleHits = staleTargets.filter((target) => exactSetHas(topIdentifiers, target) || textHasToken(allText, target));
  const newHits = newTargets.filter((target) => exactSetHas(topIdentifiers, target) || textHasToken(allText, target));
  return {
    newHits,
    staleHits
  };
}

function evaluateImpact(caseSpec, topNodes, allText, evidenceNodes = topNodes) {
  return {
    consequenceHits: uniqueTokenMatches(caseSpec.requiredConsequenceTerms ?? [], allText),
    testHits: uniqueMatches(caseSpec.goldenTests ?? [], topNodeFilePaths(evidenceNodes)),
    runtimeHits: uniqueMatches(caseSpec.goldenRuntimeArtifacts ?? [], topNodeFilePaths(evidenceNodes))
  };
}

function computeRetrievalScore(caseSpec, nodes, topNodes, forbiddenFalsePositiveHits) {
  const goldenFiles = caseSpec.goldenFiles ?? [];
  const goldenSymbols = caseSpec.goldenSymbols ?? [];
  const fileRecall = goldenFiles.length ? uniqueMatches(goldenFiles, nodes.map((node) => node.filePath)).length / goldenFiles.length : 0;
  const symbolRecall = goldenSymbols.length ? uniqueMatches(goldenSymbols, symbolIdentifiers(nodes)).length / goldenSymbols.length : 0;
  const precisionDenominator = Math.max(1, topNodes.length);
  const relevantTopHits = uniqueMatches([...goldenFiles, ...goldenSymbols], [...topNodeFilePaths(topNodes), ...symbolIdentifiers(topNodes)]).length;
  const precisionAtK = relevantTopHits / precisionDenominator;
  const base = goldenSymbols.length > 0
    ? 0.5 * fileRecall + 0.3 * symbolRecall + 0.2 * precisionAtK
    : 0.7 * fileRecall + 0.3 * precisionAtK;
  const penalty = Math.min(1, (forbiddenFalsePositiveHits.length * 25) / 100);
  return clamp01(base - penalty);
}

function computeMultiImplScore(hasValid, hasInvalid, hasAlternate) {
  if (!hasValid && !hasAlternate) return 0;
  if (hasValid && hasInvalid) return 0.5;
  if (hasValid || hasAlternate) return 1;
  return 0;
}

function computeFreshnessScore(caseSpec, topNodes, freshnessMatches) {
  const newTargets = caseSpec.freshnessSetup?.newTargets ?? [];
  const staleTargets = caseSpec.freshnessSetup?.staleTargets ?? [];
  const surfacingPass = newTargets.length ? uniqueMatches(newTargets, topNodeIdentifiers(topNodes)).length / newTargets.length : 0;
  const suppressionPass = staleTargets.length ? (freshnessMatches.staleHits.length === 0 ? 1 : 0) : 1;
  return clamp01((surfacingPass + suppressionPass) / 2);
}

function computeImpactScore(caseSpec, topNodes, impactMatches) {
  const tests = caseSpec.goldenTests ?? [];
  const runtimeArtifacts = caseSpec.goldenRuntimeArtifacts ?? [];
  const consequenceTerms = caseSpec.requiredConsequenceTerms ?? [];
  const testRecall = tests.length ? (impactMatches.testHits ?? []).length / tests.length : 0;
  const runtimeRecall = runtimeArtifacts.length ? (impactMatches.runtimeHits ?? []).length / runtimeArtifacts.length : 0;
  const consequenceRecall = consequenceTerms.length ? impactMatches.consequenceHits.length / consequenceTerms.length : 0;
  return clamp01(0.4 * testRecall + 0.3 * runtimeRecall + 0.3 * consequenceRecall);
}

export function scoreCase(dimensionScores, applicableDimensions) {
  const active = [...new Set(['retrieval', ...applicableDimensions])]
    .filter((dimension) => Object.prototype.hasOwnProperty.call(BASE_WEIGHTS, dimension));
  const denominator = active.reduce((sum, dimension) => sum + BASE_WEIGHTS[dimension], 0);
  if (denominator <= 0) return 0;
  const weighted = active.reduce((sum, dimension) => sum + ((dimensionScores[dimension] ?? 0) * BASE_WEIGHTS[dimension]), 0);
  return round2((weighted / denominator) * 100);
}

function meanDimensionScores(caseResults) {
  const aggregate = Object.fromEntries(Object.keys(BASE_WEIGHTS).map((key) => [key, 0]));
  const count = caseResults.length || 1;
  for (const result of caseResults) {
    for (const key of Object.keys(BASE_WEIGHTS)) {
      aggregate[key] += Number.isFinite(result.dimensionScores?.[key]) ? result.dimensionScores[key] : 0;
    }
  }
  return Object.fromEntries(Object.keys(BASE_WEIGHTS).map((key) => [key, round4(aggregate[key] / count)]));
}

function weightedTierScore(tierResults) {
  const active = Object.entries(tierResults).filter(([, tier]) => tier.repoCount > 0 && Object.prototype.hasOwnProperty.call(TIER_WEIGHTS, tier.tier));
  const denominator = active.reduce((sum, [tierName]) => sum + TIER_WEIGHTS[tierName], 0);
  if (denominator <= 0) return 0;
  return active.reduce((sum, [tierName, tier]) => sum + ((tier.score ?? 0) * TIER_WEIGHTS[tierName] / denominator), 0);
}

function summarizeTierResults(repoResults, enabledTiers) {
  const tierResults = {};
  for (const tier of enabledTiers) {
    const repos = repoResults.filter((repo) => repo.tier === tier);
    tierResults[tier] = {
      tier,
      repoCount: repos.length,
      caseCount: repos.reduce((sum, repo) => sum + repo.caseCount, 0),
      score: round2(mean(repos.map((repo) => repo.score))),
      dimensions: meanDimensionScores(repos.flatMap((repo) => repo.caseResults))
    };
  }
  return tierResults;
}

function evaluateHardGates({ poolValidation, readiness, repoResults, caseResults, nonMutationProof, enabledTiers = [] }) {
  const coreRepoResults = repoResults.filter((repo) => repo.tier === 'core');
  const coreCaseResults = caseResults.filter((item) => item.tier === 'core');
  const coreEnabled = enabledTiers.includes('core');
  const allRepoReady = readiness.every((item) => item.ok);
  const allCoreQueriesSucceeded = !coreEnabled || coreCaseResults.every((item) => item.queryStatus === 0);
  const allCoreScoresHigh = !coreEnabled || coreCaseResults.every((item) => item.totalScore >= ENABLED_CASE_SCORE_FLOOR);
  const allEnabledScoresHigh = caseResults.every((item) => item.totalScore >= ENABLED_CASE_SCORE_FLOOR);
  const eachCoreRepoHigh = !coreEnabled || coreRepoResults.every((repo) => repo.score >= 75);
  const freshnessLeakageZero = caseResults.every((item) => item.staleLeakageCount === 0);
  const passed = poolValidation.ok &&
    allRepoReady &&
    allCoreQueriesSucceeded &&
    allCoreScoresHigh &&
    allEnabledScoresHigh &&
    eachCoreRepoHigh &&
    freshnessLeakageZero &&
    nonMutationProof.passed;
  return {
    passed,
    poolValidation,
    readiness,
    allCoreQueriesSucceeded,
    allCoreScoresHigh,
    allEnabledScoresHigh,
    enabledCaseScoreFloor: ENABLED_CASE_SCORE_FLOOR,
    eachCoreRepoHigh,
    freshnessLeakageZero,
    nonMutationProof
  };
}

function evaluateScoreFloors({ repoResults, caseResults, globalQualityScore, baseline, enabledTiers = [] }) {
  const coreCaseResults = caseResults.filter((item) => item.tier === 'core');
  const coreRepoResults = repoResults.filter((item) => item.tier === 'core');
  const coreEnabled = enabledTiers.includes('core');
  const enabledCaseFloor = caseResults.every((item) => item.totalScore >= ENABLED_CASE_SCORE_FLOOR);
  const coreCaseFloor = !coreEnabled || coreCaseResults.every((item) => item.totalScore >= ENABLED_CASE_SCORE_FLOOR);
  const coreRepoFloor = !coreEnabled || coreRepoResults.every((repo) => repo.score >= 75);
  const baselineFloor = !baseline?.found || globalQualityScore >= (baseline.globalQualityScore - 1);
  return {
    passed: enabledCaseFloor && coreCaseFloor && coreRepoFloor && baselineFloor,
    enabledCaseFloor,
    enabledCaseScoreFloor: ENABLED_CASE_SCORE_FLOOR,
    coreCaseFloor,
    coreRepoFloor,
    baselineFloor
  };
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return 0;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

function fmtScore(value) {
  return round2((Number(value ?? 0) || 0) * 100).toFixed(1);
}

function round4(value) {
  return Number.isFinite(value) ? Math.round(value * 10000) / 10000 : 0;
}

export function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function median(values) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!finite.length) return 0;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runMain();
}
