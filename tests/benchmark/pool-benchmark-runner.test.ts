import { describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildArmQueryCommand, buildNonMutationProof, loadAcceptedBaselineSummary, loadPoolContract, loadRepoFixtureMap, resolveImportTargets, validatePoolAgainstFixtures } from '../../bench/pool-benchmark-runner.mjs';
import { evaluateBenchmarkGoal } from '../../bench/goal-gate.mjs';

describe('pool benchmark runner', () => {
  test('loads the pool contract and fixture counts match the checked-in contract', () => {
    const pool = loadPoolContract();
    const fixtureMap = loadRepoFixtureMap();
    const validation = validatePoolAgainstFixtures(pool, fixtureMap, pool.repos, join(process.cwd(), 'bench/benchmark-pool.local.json'));
    expect(pool.schemaVersion).toBe(1);
    expect(pool.scoreModelVersion).toBe('2026-06-27-v1');
    expect(pool.repos).toHaveLength(6);
    expect(validation.ok).toBe(true);
    expect(validation.fixtureCounts).toEqual({ core: 30, extended: 16, stress: 6 });
  });

  test('fixture validation fails when required structured metadata is malformed', () => {
    const pool = loadPoolContract();
    const fixtureMap = loadRepoFixtureMap();
    const mutated = JSON.parse(JSON.stringify(fixtureMap));
    mutated['apache-superset'][0].repoId = 'wrong-repo';
    delete mutated['apache-superset'][0].goldenRuntimeArtifacts;
    mutated['apache-superset'][0].freshnessSetup = { newTargets: 'bad', staleTargets: [] };
    const validation = validatePoolAgainstFixtures(pool, mutated, [pool.repoById['apache-superset']!], join(process.cwd(), 'bench/benchmark-pool.local.json'));
    expect(validation.ok).toBe(false);
    expect(validation.errors.some((error) => error.includes('repoId mismatch'))).toBe(true);
    expect(validation.errors.some((error) => error.includes('goldenRuntimeArtifacts must be an array'))).toBe(true);
    expect(validation.errors.some((error) => error.includes('freshnessSetup.newTargets must be an array'))).toBe(true);
  });

  test('fails when stress provenance metadata is missing for an enabled stress repo', () => {
    const pool = loadPoolContract();
    const fixtureMap = loadRepoFixtureMap();
    const tempRoot = mkdtempSync(join(tmpdir(), 'zincgraph-pool-missing-meta-'));
    const missingMetadataPath = join(tempRoot, 'bench/benchmark-pool.local.json');
    const validation = validatePoolAgainstFixtures(pool, fixtureMap, pool.repos, missingMetadataPath);
    expect(validation.ok).toBe(false);
    expect(validation.errors.some((error) => error.includes('Stress local metadata is required'))).toBe(true);
  });

  test('records contract files in the non-mutation proof surface', () => {
    const proof = buildNonMutationProof({}, {}, {}, {});
    expect(proof.watchedRoots).toContain('bench/benchmark-pool.json');
    expect(proof.watchedRoots).toContain('bench/benchmark-pool.local.json');
  });

  test('scores retrieval as part of the weighted case total', async () => {
    const { scoreCase } = await import('../../bench/pool-benchmark-runner.mjs') as any;
    const retrievalOnly = scoreCase(
      { retrieval: 1, relation: 0, multi_impl: 0, freshness: 0, impact: 0 },
      []
    );
    const retrievalAndRelation = scoreCase(
      { retrieval: 1, relation: 0.5, multi_impl: 0, freshness: 0, impact: 0 },
      ['relation']
    );

    expect(retrievalOnly).toBe(100);
    expect(retrievalAndRelation).toBe(80);
  });

  test('normalizes codegraph query output into the shared capsule shape', async () => {
    const { normalizeQueryCapsule } = await import('../../bench/pool-benchmark-runner.mjs') as any;
    const capsule = normalizeQueryCapsule('codegraph', [
      {
        score: 99.1,
        node: {
          id: 'function:abcd',
          kind: 'function',
          name: 'runAutoSyncOnce',
          qualifiedName: 'runAutoSyncOnce',
          filePath: 'src/freshness/auto-sync.ts'
        }
      }
    ]);
    expect(capsule.nodes).toHaveLength(1);
    expect(capsule.nodes[0]).toMatchObject({
      nodeId: 'function:abcd',
      kind: 'function',
      name: 'runAutoSyncOnce',
      qualifiedName: 'runAutoSyncOnce',
      filePath: 'src/freshness/auto-sync.ts',
      toolRank: 0
    });
    expect(capsule.edges).toEqual([]);
  });

  test('pool A/B report renders both baseline and target arms', async () => {
    const { createPoolComparisonReport } = await import('../../bench/pool-benchmark-runner.mjs') as any;
    const pool = loadPoolContract();
    const report = createPoolComparisonReport({
      generatedAt: '2026-06-28T00:00:00Z',
      accepted: true,
      scoreModel: { version: '2026-06-27-v1' },
      pool: pool.raw,
      enabledTiers: ['core', 'extended', 'stress'],
      repoCount: 6,
      caseCount: 52,
      targetArm: 'zincgraph-fusion',
      baselineArm: 'codegraph',
      primaryWinner: 'zincgraph-fusion',
      globalQualityScore: 74.65,
      baseline: { found: true, path: 'bench/results/20260628T051409.851Z/summary.json', globalQualityScore: 71.08 },
      hardGate: { passed: true, readiness: [{ ok: true }], allCoreQueriesSucceeded: true, freshnessLeakageZero: true },
      scoreFloors: { passed: true, coreCaseFloor: true, coreRepoFloor: true, baselineFloor: true },
      nonMutationProof: { passed: true, changedRepoStates: [] },
      poolValidation: { ok: true },
      comparison: {
        targetArm: 'zincgraph-fusion',
        baselineArm: 'codegraph',
        primaryWinner: 'zincgraph-fusion',
        qualityMargin: 3.57,
        arms: {
          codegraph: {
            totalScore: 71.08,
            dimensionScores: { retrieval: 0.84, relation: 0.72, multi_impl: 0.3, freshness: 0.25, impact: 0.2 },
            raw: { medianLatencyMs: 1341.67, totalOutputBytes: 59418, tasksPassed: 7, applicableTasks: 52 },
            hardGate: { passed: true },
            scoreFloors: { passed: true }
          },
          'zincgraph-fusion': {
            totalScore: 74.65,
            dimensionScores: { retrieval: 0.87, relation: 0.81, multi_impl: 0.32, freshness: 0.29, impact: 0.22 },
            raw: { medianLatencyMs: 7794.5, totalOutputBytes: 153441, tasksPassed: 7, applicableTasks: 52 },
            hardGate: { passed: true },
            scoreFloors: { passed: true }
          }
        },
        repoResults: [
          {
            repoId: 'apache-superset',
            tier: 'core',
            caseCount: 10,
            byArm: {
              codegraph: { score: 71.08 },
              'zincgraph-fusion': { score: 74.65 }
            },
            delta: 3.57,
            winner: 'zincgraph-fusion'
          }
        ],
        tierResults: {
          core: {
            byArm: {
              codegraph: { score: 71.08 },
              'zincgraph-fusion': { score: 74.65 }
            },
            delta: 3.57,
            winner: 'zincgraph-fusion'
          }
        },
        caseResults: [
          {
            repoId: 'apache-superset',
            queryId: 'superset-rh-guest-token-revocation',
            byArm: {
              codegraph: { totalScore: 71.08, passed: true, hardGateReasons: [] },
              'zincgraph-fusion': { totalScore: 74.65, passed: true, hardGateReasons: [] }
            },
            winner: 'zincgraph-fusion',
            delta: 3.57
          }
        ]
      }
    });
    expect(report).toContain('Open-Source Pool A/B Benchmark Report');
    expect(report).toContain('CodeGraph');
    expect(report).toContain('Zincgraph');
    expect(report).toContain('Repo Comparison');
    expect(report).toContain('Tier Comparison');
    expect(report).toContain('Case Comparison');
    expect(report).toContain('targetArm: zincgraph-fusion');
    expect(report).toContain('baselineArm: codegraph');
  });

  test('zincgraph benchmark arm explicitly opts into the fast full-json capsule', () => {
    const command = buildArmQueryCommand('zincgraph-fusion', '/repo', 'src/app.ts appEntry', 5);

    expect(command).toContain('--full-json');
    expect(command).toContain('--fast-full-json');
  });

  test('accepted baseline loading requires an explicit accept marker', () => {
    const resultsRoot = mkdtempSync(join(tmpdir(), 'zincgraph-accepted-baseline-'));
    const implicitDir = join(resultsRoot, 'implicit');
    const explicitDir = join(resultsRoot, 'explicit');
    mkdirSync(implicitDir, { recursive: true });
    mkdirSync(explicitDir, { recursive: true });
    const baseSummary = {
      schemaVersion: 1,
      scoreModel: { version: '2026-06-27-v1' },
      enabledTiers: ['core', 'extended', 'stress'],
      accepted: true
    };
    writeFileSync(join(implicitDir, 'summary.json'), `${JSON.stringify({
      ...baseSummary,
      generatedAt: '2026-06-29T00:00:00.000Z',
      globalQualityScore: 1
    })}\n`);
    writeFileSync(join(explicitDir, 'summary.json'), `${JSON.stringify({
      ...baseSummary,
      generatedAt: '2026-06-28T00:00:00.000Z',
      globalQualityScore: 99,
      acceptedSummaryCandidate: true
    })}\n`);

    const baseline = loadAcceptedBaselineSummary(resultsRoot, {
      schemaVersion: 1,
      scoreModelVersion: '2026-06-27-v1',
      enabledTiers: ['core', 'extended', 'stress']
    });

    expect(baseline.found).toBe(true);
    expect(baseline.path).toContain('explicit/summary.json');
    expect(baseline.globalQualityScore).toBe(99);
  });

  test('non-mutation proof fails when a source repo state changes even if root fingerprints are stable', () => {
    const proof = buildNonMutationProof(
      { '.codegraph': { exists: true, size: 1 } },
      { '.codegraph': { exists: true, size: 1 } },
      {
        airbyte: {
          exists: true,
          path: 'bench/worktrees/airbyte',
          localRoots: {},
          archive: { sourceCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', dirty: false }
        }
      },
      {
        airbyte: {
          exists: true,
          path: 'bench/worktrees/airbyte',
          localRoots: {},
          archive: { sourceCommitSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', dirty: false }
        }
      }
    );
    expect(proof.changedPaths).toEqual([]);
    expect(proof.changedRepoStates).toHaveLength(1);
    expect(proof.passed).toBe(false);
  });

  test('goal gate accepts the new pool summary shape when all gates pass', () => {
    const result = evaluateBenchmarkGoal({
      accepted: true,
      scoreModel: { version: '2026-06-27-v1' },
      repoCount: 6,
      caseCount: 52,
      globalQualityScore: 88.4,
      baseline: { found: true, globalQualityScore: 88.9 },
      poolValidation: { ok: true },
      hardGate: { passed: true },
      scoreFloors: { passed: true, coreCaseFloor: true, coreRepoFloor: true, baselineFloor: true },
      nonMutationProof: { passed: true },
      repoResults: [
        { tier: 'core', score: 76 },
        { tier: 'extended', score: 72 },
        { tier: 'stress', score: 19 }
      ],
      caseResults: [
        { tier: 'core', totalScore: 75 },
        { tier: 'core', totalScore: 72 }
      ]
    });
    expect(result.passed).toBe(true);
    expect(result.metrics.repoCount).toBe(6);
    expect(result.metrics.caseCount).toBe(52);
  });

  test('import target resolution maps module specifiers to repo-relative file paths', () => {
    const nodes = [
      { filePath: 'superset/tasks/thumbnails.py' },
      { filePath: 'superset/utils/screenshots.py' },
      { filePath: 'airflow-core/src/airflow/api_fastapi/core_api/datamodels/dag_run.py' }
    ];
    expect(resolveImportTargets('superset/models/dashboard.py', 'superset.tasks.thumbnails', nodes)).toContain('superset/tasks/thumbnails.py');
    expect(resolveImportTargets('superset/tasks/thumbnails.py', 'superset/utils/screenshots.py', nodes)).toContain('superset/utils/screenshots.py');
    expect(resolveImportTargets('airflow-core/src/airflow/api_fastapi/core_api/routes/public/dag_run.py', '../../datamodels/dag_run.py', nodes)).toContain('airflow-core/src/airflow/api_fastapi/core_api/datamodels/dag_run.py');
  });
});
