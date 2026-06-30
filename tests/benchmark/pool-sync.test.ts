import { describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePoolSyncArgs, materializeBenchmarkPool } from '../../bench/pool-sync.mjs';
import { validateBenchmarkPoolContract } from '../../bench/pool-status.mjs';

describe('benchmark pool sync', () => {
  test('parses dry-run and tier filters', () => {
    const options = parsePoolSyncArgs(['--dry-run', '--no-shallow', '--tier', 'core', '--tier', 'stress', '--repo', 'airbyte']);
    expect(options.dryRun).toBe(true);
    expect(options.shallow).toBe(false);
    expect(options.tiers).toEqual(['core', 'stress']);
    expect(options.repos).toEqual(['airbyte']);
  });

  test('dry-run does not create benchmark directories', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'zincgraph-pool-sync-dry-run-'));
    const poolPath = join(tempRoot, 'bench/local-pool.json');
    mkdirSync(join(tempRoot, 'upstreams'), { recursive: true });
    mkdirSync(join(tempRoot, 'bench'), { recursive: true });
    writeFileSync(poolPath, JSON.stringify({
      schemaVersion: 1,
      scoreModel: { version: '2026-06-27-v1' },
      baselinePolicy: { acceptedField: 'accepted' },
      repoLayout: {
        coreRoot: 'bench/corpora/core',
        extendedRoot: 'bench/corpora/extended',
        stressRoot: 'bench/worktrees'
      },
      repos: [
        {
          id: 'core-repo',
          tier: 'core',
          repoUrl: 'https://github.com/example/core-repo.git',
          path: 'bench/corpora/core/core-repo',
          acquisition: 'submodule',
          cases: { count: 1, mix: { retrievalHeavy: 1 } }
        }
      ]
    }, null, 2));

    const result = materializeBenchmarkPool({
      rootDir: tempRoot,
      poolPath,
      dryRun: true
    });

    expect(result.ok).toBe(true);
    expect(result.actions[0]?.status).toBe('planned');
    expect(existsSync(join(tempRoot, 'bench/corpora/core'))).toBe(false);
    expect(existsSync(join(tempRoot, 'bench/corpora/extended'))).toBe(false);
    expect(existsSync(join(tempRoot, 'bench/worktrees'))).toBe(false);
  });

  test('repo filter restricts materialization planning to selected repos', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'zincgraph-pool-sync-filter-'));
    const poolPath = join(tempRoot, 'bench/local-pool.json');
    mkdirSync(join(tempRoot, 'bench'), { recursive: true });
    writeFileSync(poolPath, JSON.stringify({
      schemaVersion: 1,
      scoreModel: { version: '2026-06-27-v1' },
      baselinePolicy: { acceptedField: 'accepted' },
      repoLayout: {
        coreRoot: 'bench/corpora/core',
        extendedRoot: 'bench/corpora/extended',
        stressRoot: 'bench/worktrees'
      },
      repos: [
        {
          id: 'core-a',
          tier: 'core',
          repoUrl: 'https://github.com/example/core-a.git',
          path: 'bench/corpora/core/core-a',
          acquisition: 'submodule',
          cases: { count: 1, mix: { retrievalHeavy: 1 } }
        },
        {
          id: 'core-b',
          tier: 'core',
          repoUrl: 'https://github.com/example/core-b.git',
          path: 'bench/corpora/core/core-b',
          acquisition: 'submodule',
          cases: { count: 1, mix: { retrievalHeavy: 1 } }
        }
      ]
    }, null, 2));

    const result = materializeBenchmarkPool({
      rootDir: tempRoot,
      poolPath,
      dryRun: true,
      repos: ['core-b']
    });

    expect(result.ok).toBe(true);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.repoId).toBe('core-b');
  });

  test('materializes local fixture repos and strict validation passes', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'zincgraph-pool-sync-'));
    const upstreamRoot = join(tempRoot, 'upstreams');
    mkdirSync(upstreamRoot, { recursive: true });
    mkdirSync(join(tempRoot, 'bench/corpora/core'), { recursive: true });
    mkdirSync(join(tempRoot, 'bench/corpora/extended'), { recursive: true });
    mkdirSync(join(tempRoot, 'bench/worktrees'), { recursive: true });
    writeFileSync(join(tempRoot, '.gitignore'), 'bench/benchmark-pool.local.json\n');
    writeFileSync(join(tempRoot, 'bench/corpora/core/.gitignore'), '*\n!.gitignore\n');
    writeFileSync(join(tempRoot, 'bench/corpora/extended/.gitignore'), '*\n!.gitignore\n');
    writeFileSync(join(tempRoot, 'bench/worktrees/.gitignore'), '*\n!.gitignore\n');
    runGit(['init'], tempRoot);

    const coreRepo = initUpstreamRepo(join(upstreamRoot, 'core-repo'));
    const stressRepo = initUpstreamRepo(join(upstreamRoot, 'stress-repo'));
    const poolPath = join(tempRoot, 'bench/local-pool.json');
    writeFileSync(poolPath, JSON.stringify({
      schemaVersion: 1,
      scoreModel: { version: '2026-06-27-v1' },
      baselinePolicy: { acceptedField: 'accepted' },
      repoLayout: {
        coreRoot: 'bench/corpora/core',
        extendedRoot: 'bench/corpora/extended',
        stressRoot: 'bench/worktrees'
      },
      stressMetadata: {
        lifecycle: {
          gitignorePath: 'bench/worktrees/.gitignore',
          metadataPath: 'bench/benchmark-pool.local.json'
        }
      },
      caseSchema: {
        requiredFields: [
          'repoId', 'queryId', 'tier', 'family', 'query', 'difficulty', 'goldenFiles', 'goldenSymbols',
          'goldenRelations', 'goldenImplementations', 'acceptableAlternates', 'invalidImplementations',
          'requiredTopK', 'requiredEvidenceTerms', 'forbiddenFalsePositives', 'freshnessSetup', 'goldenTests',
          'goldenRuntimeArtifacts', 'requiredConsequenceTerms', 'impactRequired'
        ]
      },
      repos: [
        {
          id: 'core-repo',
          tier: 'core',
          repoUrl: `file://${coreRepo}`,
          path: 'bench/corpora/core/core-repo',
          acquisition: 'submodule',
          cases: { count: 1, mix: { retrievalHeavy: 1 } }
        },
        {
          id: 'stress-repo',
          tier: 'stress',
          repoUrl: `file://${stressRepo}`,
          path: 'bench/worktrees/stress-repo',
          acquisition: 'gitignored-local-clone',
          cases: { count: 1, mix: { retrievalHeavy: 1 } }
        }
      ]
    }, null, 2));

    const result = materializeBenchmarkPool({
      rootDir: tempRoot,
      poolPath,
      localMetadataPath: join(tempRoot, 'bench/benchmark-pool.local.json'),
      tiers: ['core', 'stress']
    });
    expect(result.ok).toBe(true);
    expect(result.actions.map((action) => action.status)).toEqual(['added', 'cloned']);

    const metadata = JSON.parse(readFileSync(join(tempRoot, 'bench/benchmark-pool.local.json'), 'utf8'));
    expect(metadata.enabled).toBe(true);
    expect(metadata.dirty).toBe(false);
    expect(readFileSync(join(tempRoot, '.gitmodules'), 'utf8')).toContain('bench/corpora/core/core-repo');

    const validation = validateBenchmarkPoolContract({
      rootDir: tempRoot,
      poolPath,
      localMetadataPath: join(tempRoot, 'bench/benchmark-pool.local.json'),
      strictMaterialization: true,
      enforceCanonicalRepoUrls: false,
      enforceFixedPoolShape: false
    });
    expect(validation.ok).toBe(true);
    expect(validation.summary.repos.every((repo: any) => repo.materialized)).toBe(true);
  });

  test('extracts local archive fixtures and records archive provenance', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'zincgraph-pool-archive-'));
    const upstreamRoot = join(tempRoot, 'upstreams');
    const archiveRoot = join(tempRoot, 'archives');
    mkdirSync(upstreamRoot, { recursive: true });
    mkdirSync(archiveRoot, { recursive: true });
    mkdirSync(join(tempRoot, 'bench/corpora/core'), { recursive: true });
    mkdirSync(join(tempRoot, 'bench/corpora/extended'), { recursive: true });
    mkdirSync(join(tempRoot, 'bench/worktrees'), { recursive: true });
    writeFileSync(join(tempRoot, '.gitignore'), 'bench/benchmark-pool.local.json\n');
    writeFileSync(join(tempRoot, 'bench/corpora/core/.gitignore'), '*\n!.gitignore\n');
    writeFileSync(join(tempRoot, 'bench/corpora/extended/.gitignore'), '*\n!.gitignore\n');
    writeFileSync(join(tempRoot, 'bench/worktrees/.gitignore'), '*\n!.gitignore\n');

    const coreRepo = initUpstreamRepo(join(upstreamRoot, 'core-repo'));
    const stressRepo = initUpstreamRepo(join(upstreamRoot, 'stress-repo'));
    const coreSha = revParseHead(coreRepo);
    const stressSha = revParseHead(stressRepo);
    runGit(['archive', '--format=zip', '--output', join(archiveRoot, `core-repo-${coreSha}.zip`), 'HEAD'], coreRepo);
    runGit(['archive', '--format=zip', '--output', join(archiveRoot, `stress-repo-${stressSha}.zip`), 'HEAD'], stressRepo);

    const poolPath = join(tempRoot, 'bench/local-pool.json');
    writeFileSync(poolPath, JSON.stringify({
      schemaVersion: 1,
      scoreModel: { version: '2026-06-27-v1' },
      baselinePolicy: { acceptedField: 'accepted' },
      repoLayout: {
        coreRoot: 'bench/corpora/core',
        extendedRoot: 'bench/corpora/extended',
        stressRoot: 'bench/worktrees'
      },
      stressMetadata: {
        lifecycle: {
          gitignorePath: 'bench/worktrees/.gitignore',
          metadataPath: 'bench/benchmark-pool.local.json'
        }
      },
      caseSchema: {
        requiredFields: [
          'repoId', 'queryId', 'tier', 'family', 'query', 'difficulty', 'goldenFiles', 'goldenSymbols',
          'goldenRelations', 'goldenImplementations', 'acceptableAlternates', 'invalidImplementations',
          'requiredTopK', 'requiredEvidenceTerms', 'forbiddenFalsePositives', 'freshnessSetup', 'goldenTests',
          'goldenRuntimeArtifacts', 'requiredConsequenceTerms', 'impactRequired'
        ]
      },
      repos: [
        {
          id: 'core-repo',
          tier: 'core',
          repoUrl: 'https://github.com/example/core-repo.git',
          path: 'bench/corpora/core/core-repo',
          acquisition: 'submodule',
          cases: { count: 1, mix: { retrievalHeavy: 1 } }
        },
        {
          id: 'stress-repo',
          tier: 'stress',
          repoUrl: 'https://github.com/example/stress-repo.git',
          path: 'bench/worktrees/stress-repo',
          acquisition: 'gitignored-local-clone',
          cases: { count: 1, mix: { retrievalHeavy: 1 } }
        }
      ]
    }, null, 2));

    const result = materializeBenchmarkPool({
      rootDir: tempRoot,
      poolPath,
      archiveDir: archiveRoot,
      localMetadataPath: join(tempRoot, 'bench/benchmark-pool.local.json'),
      tiers: ['core', 'stress']
    });
    expect(result.ok).toBe(true);
    expect(result.actions.map((action) => action.status)).toEqual(['extracted', 'extracted']);

    const metadata = JSON.parse(readFileSync(join(tempRoot, 'bench/benchmark-pool.local.json'), 'utf8'));
    expect(metadata.archives['core-repo'].sourceCommitSha).toBe(coreSha);
    expect(metadata.archives['stress-repo'].sourceCommitSha).toBe(stressSha);
    expect(metadata.commitSha).toBe(stressSha);
    expect(metadata.repoUrl).toBe('https://github.com/example/stress-repo.git');

    const validation = validateBenchmarkPoolContract({
      rootDir: tempRoot,
      poolPath,
      localMetadataPath: join(tempRoot, 'bench/benchmark-pool.local.json'),
      strictMaterialization: true,
      enforceCanonicalRepoUrls: false,
      enforceFixedPoolShape: false
    });
    expect(validation.ok).toBe(true);
  });
});

function initUpstreamRepo(repoPath: string) {
  mkdirSync(repoPath, { recursive: true });
  runGit(['init'], repoPath);
  runGit(['config', 'user.name', 'Test User'], repoPath);
  runGit(['config', 'user.email', 'test@example.com'], repoPath);
  writeFileSync(join(repoPath, 'README.md'), `# ${repoPath}\n`);
  runGit(['add', 'README.md'], repoPath);
  runGit(['commit', '-m', 'init'], repoPath);
  return repoPath;
}

function runGit(args: string[], cwd: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  }
}

function revParseHead(cwd: string) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr || result.stdout || 'git rev-parse HEAD failed');
  }
  return result.stdout.trim();
}
