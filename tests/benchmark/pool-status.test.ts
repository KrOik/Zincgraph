import { describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parsePoolStatusArgs,
  validateBenchmarkPoolContract
} from '../../bench/pool-status.mjs';

describe('benchmark pool status', () => {
  test('parses strict materialization and explicit paths', () => {
    const options = parsePoolStatusArgs([
      '--strict-materialization',
      '--pool',
      '/tmp/pool.json',
      '--local-metadata',
      '/tmp/local.json'
    ]);
    expect(options.strictMaterialization).toBe(true);
    expect(options.poolPath).toBe('/tmp/pool.json');
    expect(options.localMetadataPath).toBe('/tmp/local.json');
  });

  test('validates checked-in benchmark pool contract in layout-only mode', () => {
    const result = validateBenchmarkPoolContract();
    expect(result.ok).toBe(true);
    expect(result.summary.repoCount).toBe(6);
    expect(result.summary.tierCounts).toEqual({ core: 3, extended: 2, stress: 1 });
    expect(result.summary.caseCounts).toEqual({ core: 30, extended: 16, stress: 6 });
    expect(result.summary.repos.every((repo: any) => typeof repo.materialized === 'boolean')).toBe(true);
  });

  test('strict materialization requires repos and valid local metadata', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'zincgraph-benchmark-pool-'));
    mkdirSync(join(tempRoot, 'bench/worktrees'), { recursive: true });
    mkdirSync(join(tempRoot, 'bench/corpora/core'), { recursive: true });
    mkdirSync(join(tempRoot, 'bench/corpora/extended'), { recursive: true });
    writeFileSync(join(tempRoot, '.gitignore'), 'bench/benchmark-pool.local.json\n');
    writeFileSync(join(tempRoot, 'bench/worktrees/.gitignore'), '*\n!.gitignore\n');
    writeFileSync(
      join(tempRoot, 'bench/benchmark-pool.local.json'),
      JSON.stringify({
        enabled: true,
        repoUrl: 'https://github.com/airbytehq/airbyte.git',
        commitSha: '0123456789abcdef0123456789abcdef01234567',
        fetchedAt: '2026-06-27T00:00:00Z',
        dirty: false
      }, null, 2)
    );
    const strictResult = validateBenchmarkPoolContract({
      rootDir: tempRoot,
      strictMaterialization: true,
      localMetadataPath: join(tempRoot, 'bench/benchmark-pool.local.json')
    });
    expect(strictResult.ok).toBe(false);
    expect(strictResult.errors.some((message: string) => message.includes('not materialized'))).toBe(true);
  });

  test('archive-backed stress provenance rejects parent HEAD when archive source commit differs', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'zincgraph-benchmark-stress-provenance-'));
    const metadataPath = join(tempRoot, 'bench/benchmark-pool.local.json');
    mkdirSync(join(tempRoot, 'bench'), { recursive: true });
    const localMetadata = JSON.parse(readFileSync(join(process.cwd(), 'bench/benchmark-pool.local.json'), 'utf8'));
    localMetadata.commitSha = 'eb11e2cbc2e24ee318f01849fcfd0e086c673973';
    writeFileSync(metadataPath, JSON.stringify(localMetadata, null, 2));

    const result = validateBenchmarkPoolContract({
      rootDir: process.cwd(),
      strictMaterialization: true,
      localMetadataPath: metadataPath
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((message: string) => message.includes('commitSha must match archive sourceCommitSha'))).toBe(true);
  });
});
