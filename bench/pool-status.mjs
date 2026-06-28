#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadBenchmarkPool } from './compare.mjs';
import { validateStressLocalMetadata } from './pool-benchmark-runner.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_POOL_PATH = join(ROOT, 'bench/benchmark-pool.json');
export const DEFAULT_LOCAL_METADATA_PATH = join(ROOT, 'bench/benchmark-pool.local.json');
export const DEFAULT_WORKTREES_GITIGNORE_PATH = join(ROOT, 'bench/worktrees/.gitignore');
const EXPECTED_TIERS = ['core', 'extended', 'stress'];
const EXPECTED_REQUIRED_FIELDS = [
  'repoId',
  'queryId',
  'tier',
  'family',
  'query',
  'difficulty',
  'goldenFiles',
  'goldenSymbols',
  'goldenRelations',
  'goldenImplementations',
  'acceptableAlternates',
  'invalidImplementations',
  'requiredTopK',
  'requiredEvidenceTerms',
  'forbiddenFalsePositives',
  'freshnessSetup',
  'goldenTests',
  'goldenRuntimeArtifacts',
  'requiredConsequenceTerms',
  'impactRequired'
];

export function parsePoolStatusArgs(argv) {
  const options = {
    poolPath: DEFAULT_POOL_PATH,
    localMetadataPath: DEFAULT_LOCAL_METADATA_PATH,
    strictMaterialization: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--strict-materialization') {
      options.strictMaterialization = true;
      continue;
    }
    if (arg === '--pool') {
      options.poolPath = resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--local-metadata') {
      options.localMetadataPath = resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export function validateBenchmarkPoolContract(options = {}) {
  const poolPath = resolve(options.poolPath ?? DEFAULT_POOL_PATH);
  const localMetadataPath = resolve(options.localMetadataPath ?? DEFAULT_LOCAL_METADATA_PATH);
  const strictMaterialization = options.strictMaterialization === true;
  const enforceCanonicalRepoUrls = options.enforceCanonicalRepoUrls !== false;
  const enforceFixedPoolShape = options.enforceFixedPoolShape !== false;
  const rootDir = resolve(options.rootDir ?? ROOT);
  const poolSummary = loadBenchmarkPool(poolPath);
  const raw = poolSummary.raw ?? {};
  const errors = [];
  const warnings = [];
  const expectedRoots = {
    core: String(raw.repoLayout?.coreRoot ?? 'bench/corpora/core'),
    extended: String(raw.repoLayout?.extendedRoot ?? 'bench/corpora/extended'),
    stress: String(raw.repoLayout?.stressRoot ?? 'bench/worktrees')
  };
  const repos = Array.isArray(raw.repos) ? raw.repos : [];
  const stressRepo = repos.find((repo) => repo.tier === 'stress') ?? null;
  const idSet = new Set();
  const caseFieldSet = new Set(raw.caseSchema?.requiredFields ?? []);
  const localMetadata = readOptionalJson(localMetadataPath, errors);
  const archiveMetadata = localMetadata?.archives ?? {};

  if (raw.schemaVersion !== 1) {
    errors.push(`Expected schemaVersion=1, got ${String(raw.schemaVersion)}.`);
  }
  if (poolSummary.scoreModelVersion !== '2026-06-27-v1') {
    errors.push(`Expected scoreModel.version=2026-06-27-v1, got ${String(poolSummary.scoreModelVersion)}.`);
  }
  if (raw.baselinePolicy?.acceptedField !== 'accepted') {
    errors.push(`Expected baselinePolicy.acceptedField=accepted, got ${String(raw.baselinePolicy?.acceptedField)}.`);
  }
  for (const field of EXPECTED_REQUIRED_FIELDS) {
    if (!caseFieldSet.has(field)) {
      errors.push(`Missing caseSchema.requiredFields entry: ${field}.`);
    }
  }

  for (const repo of repos) {
    if (idSet.has(repo.id)) {
      errors.push(`Duplicate repo id: ${repo.id}.`);
      continue;
    }
    idSet.add(repo.id);
    if (!EXPECTED_TIERS.includes(repo.tier)) {
      errors.push(`Repo ${repo.id} has unsupported tier ${String(repo.tier)}.`);
    }
    if (!String(repo.path ?? '').startsWith(expectedRoots[repo.tier] ?? '')) {
      errors.push(`Repo ${repo.id} path ${String(repo.path)} is outside ${expectedRoots[repo.tier]}.`);
    }
    if (enforceCanonicalRepoUrls && !/^https:\/\/github\.com\/.+\.git$/u.test(String(repo.repoUrl ?? ''))) {
      errors.push(`Repo ${repo.id} repoUrl must be a canonical GitHub .git URL.`);
    }
    if (!Number.isInteger(repo.cases?.count) || repo.cases.count <= 0) {
      errors.push(`Repo ${repo.id} has invalid cases.count.`);
    }
    const mixCount = Object.values(repo.cases?.mix ?? {}).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
    if (mixCount !== repo.cases?.count) {
      errors.push(`Repo ${repo.id} case mix sums to ${mixCount}, expected ${repo.cases?.count}.`);
    }
    if ((repo.tier === 'core' || repo.tier === 'extended') && repo.acquisition !== 'submodule') {
      errors.push(`Repo ${repo.id} must use acquisition=submodule.`);
    }
    if (repo.tier === 'stress' && repo.acquisition !== 'gitignored-local-clone') {
      errors.push(`Repo ${repo.id} must use acquisition=gitignored-local-clone.`);
    }
    const repoAbsolutePath = join(rootDir, repo.path);
    const materialized = existsSync(repoAbsolutePath);
    if (!materialized) {
      const message = `Repo ${repo.id} is not materialized at ${repo.path}.`;
      if (strictMaterialization) errors.push(message);
      else warnings.push(message);
      continue;
    }
    if (strictMaterialization) {
      if (repo.tier === 'stress') {
        validateStressLocalMetadata({ localMetadata, stressRepo: repo, rootDir, errors });
        continue;
      }
      const archiveEntry = archiveMetadata?.[repo.id] ?? null;
      if (archiveEntry) {
        validateArchiveEntry({ archiveEntry, repo, rootDir, errors });
        validateArchiveRootGitignore({ rootDir, repo, errors });
        continue;
      }
      if (!hasMatchingSubmodule(rootDir, repo)) {
        errors.push(`Repo ${repo.id} is materialized but lacks submodule or archive provenance.`);
      }
    }
  }

  if (enforceFixedPoolShape && poolSummary.repoCount !== 6) {
    errors.push(`Expected 6 repos, got ${poolSummary.repoCount}.`);
  }
  if (
    enforceFixedPoolShape &&
    (poolSummary.tierCounts.core !== 3 || poolSummary.tierCounts.extended !== 2 || poolSummary.tierCounts.stress !== 1)
  ) {
    errors.push(`Unexpected tierCounts ${JSON.stringify(poolSummary.tierCounts)}.`);
  }
  if (
    enforceFixedPoolShape &&
    (poolSummary.caseCounts.core !== 30 || poolSummary.caseCounts.extended !== 16 || poolSummary.caseCounts.stress !== 6)
  ) {
    errors.push(`Unexpected caseCounts ${JSON.stringify(poolSummary.caseCounts)}.`);
  }

  const rootGitignore = existsSync(join(rootDir, '.gitignore'))
    ? readFileSync(join(rootDir, '.gitignore'), 'utf8')
    : '';
  if (!rootGitignore.includes('bench/benchmark-pool.local.json')) {
    errors.push('Root .gitignore must ignore bench/benchmark-pool.local.json.');
  }

  const worktreesGitignorePath = join(
    rootDir,
    String(raw.stressMetadata?.lifecycle?.gitignorePath ?? 'bench/worktrees/.gitignore')
  );
  const worktreesGitignore = existsSync(worktreesGitignorePath)
    ? readFileSync(worktreesGitignorePath, 'utf8')
    : '';
  if (!worktreesGitignore.includes('*') || !worktreesGitignore.includes('!.gitignore')) {
    errors.push('bench/worktrees/.gitignore must keep the directory gitignored except for .gitignore.');
  }

  if (localMetadata) {
    if (localMetadata.enabled === true) {
      if (localMetadata.dirty !== false) {
        errors.push('Stress local metadata must declare dirty=false when enabled.');
      }
      if (String(localMetadata.repoUrl ?? '') !== String(stressRepo?.repoUrl ?? '')) {
        errors.push(`Stress local metadata repoUrl must match pool stress repo URL ${String(stressRepo?.repoUrl ?? '')}.`);
      }
      if (!/^[0-9a-f]{7,40}$/iu.test(String(localMetadata.commitSha ?? ''))) {
        errors.push('Stress local metadata commitSha must look like a git SHA.');
      }
      if (!String(localMetadata.fetchedAt ?? '').trim()) {
        errors.push('Stress local metadata fetchedAt is required when enabled.');
      }
    }
  } else if (strictMaterialization) {
    errors.push(`Local stress metadata is absent at ${localMetadataPath}.`);
  }

  return {
    ok: errors.length === 0,
    poolPath,
    localMetadataPath,
    strictMaterialization,
    errors,
    warnings,
    summary: {
      schemaVersion: poolSummary.schemaVersion,
      scoreModelVersion: poolSummary.scoreModelVersion,
      repoCount: poolSummary.repoCount,
      tierCounts: poolSummary.tierCounts,
      caseCounts: poolSummary.caseCounts,
      repos: repos.map((repo) => ({
        id: repo.id,
        tier: repo.tier,
        acquisition: repo.acquisition,
        path: repo.path,
        materialized: existsSync(join(rootDir, repo.path))
      }))
    }
  };
}

function readOptionalJson(path, errors) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    errors.push(`Failed to parse ${path}: ${error.message}`);
    return null;
  }
}

function validateArchiveEntry({ archiveEntry, repo, rootDir, errors }) {
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
  const archivePath = join(rootDir, String(archiveEntry.archivePath ?? ''));
  if (!existsSync(archivePath)) {
    errors.push(`Archive file missing for ${repo.id}: ${String(archiveEntry.archivePath ?? '')}.`);
  }
}

function validateArchiveRootGitignore({ rootDir, repo, errors }) {
  const gitignorePath = join(rootDir, dirname(repo.path), '.gitignore');
  if (!existsSync(gitignorePath)) {
    errors.push(`Archive-backed repo ${repo.id} requires ${dirname(repo.path)}/.gitignore.`);
    return;
  }
  const content = readFileSync(gitignorePath, 'utf8');
  if (!content.includes('*') || !content.includes('!.gitignore')) {
    errors.push(`Archive-backed repo ${repo.id} requires ${dirname(repo.path)}/.gitignore to ignore extracted contents.`);
  }
}

function hasMatchingSubmodule(rootDir, repo) {
  const gitmodulesPath = join(rootDir, '.gitmodules');
  if (!existsSync(gitmodulesPath)) return false;
  const content = readFileSync(gitmodulesPath, 'utf8');
  const pathMatch = content.includes(`path = ${repo.path}`);
  const urlMatch = content.includes(`url = ${repo.repoUrl}`);
  return pathMatch && urlMatch;
}

function main() {
  const options = parsePoolStatusArgs(process.argv.slice(2));
  const result = validateBenchmarkPoolContract(options);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
