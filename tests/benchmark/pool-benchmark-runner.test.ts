import { describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildNonMutationProof, loadPoolContract, loadRepoFixtureMap, resolveImportTargets, validatePoolAgainstFixtures } from '../../bench/pool-benchmark-runner.mjs';
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
