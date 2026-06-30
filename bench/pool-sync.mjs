#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadBenchmarkPool } from './compare.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_POOL_PATH = join(ROOT, 'bench/benchmark-pool.json');
export const DEFAULT_LOCAL_METADATA_PATH = join(ROOT, 'bench/benchmark-pool.local.json');
export const DEFAULT_ARCHIVE_DIR = join(ROOT, 'bench');
const DEFAULT_TIERS = ['core', 'extended', 'stress'];

export function parsePoolSyncArgs(argv) {
  let explicitTierFilter = false;
  const options = {
    poolPath: DEFAULT_POOL_PATH,
    localMetadataPath: DEFAULT_LOCAL_METADATA_PATH,
    rootDir: ROOT,
    archiveDir: DEFAULT_ARCHIVE_DIR,
    dryRun: false,
    shallow: true,
    tiers: [...DEFAULT_TIERS],
    repos: []
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--no-shallow') {
      options.shallow = false;
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
    if (arg === '--root') {
      options.rootDir = resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--archive-dir') {
      options.archiveDir = resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--tier') {
      if (!explicitTierFilter) {
        options.tiers = [];
        explicitTierFilter = true;
      }
      options.tiers.push(String(argv[index + 1]));
      index += 1;
      continue;
    }
    if (arg === '--repo') {
      options.repos.push(String(argv[index + 1]));
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  options.tiers = [...new Set(options.tiers)];
  options.repos = [...new Set(options.repos.filter(Boolean))];
  return options;
}

export function materializeBenchmarkPool(options = {}) {
  const poolPath = resolve(options.poolPath ?? DEFAULT_POOL_PATH);
  const localMetadataPath = resolve(options.localMetadataPath ?? DEFAULT_LOCAL_METADATA_PATH);
  const rootDir = resolve(options.rootDir ?? ROOT);
  const archiveDir = resolve(options.archiveDir ?? DEFAULT_ARCHIVE_DIR);
  const dryRun = options.dryRun === true;
  const shallow = options.shallow !== false;
  const requestedTiers = [...new Set(options.tiers ?? DEFAULT_TIERS)];
  const requestedRepos = [...new Set(options.repos ?? [])];
  const pool = loadBenchmarkPool(poolPath).raw ?? {};
  const repos = Array.isArray(pool.repos) ? pool.repos : [];
  const selectedRepos = repos.filter((repo) => {
    if (!requestedTiers.includes(String(repo.tier))) return false;
    if (requestedRepos.length > 0 && !requestedRepos.includes(String(repo.id))) return false;
    return true;
  });
  const actions = [];
  const errors = [];
  const warnings = [];

  for (const repo of selectedRepos) {
    const absolutePath = join(rootDir, repo.path);
    if (existsSync(absolutePath)) {
      actions.push({
        repoId: repo.id,
        tier: repo.tier,
        acquisition: repo.acquisition,
        path: repo.path,
        status: 'present'
      });
      continue;
    }
    const archiveCandidate = findArchiveForRepo(repo, archiveDir);
    if (archiveCandidate) {
      const archiveStatus = materializeArchive({
        rootDir,
        repo,
        dryRun,
        archivePath: archiveCandidate,
        localMetadataPath
      });
      actions.push(archiveStatus.action);
      if (archiveStatus.warning) warnings.push(archiveStatus.warning);
      if (archiveStatus.error) errors.push(archiveStatus.error);
      continue;
    }
    if (repo.acquisition === 'submodule') {
      const submoduleStatus = materializeSubmodule({
        rootDir,
        repo,
        shallow,
        dryRun
      });
      actions.push(submoduleStatus);
      if (submoduleStatus.error) errors.push(submoduleStatus.error);
      continue;
    }
    if (repo.acquisition === 'gitignored-local-clone') {
      const stressStatus = materializeStressClone({
        rootDir,
        repo,
        shallow,
        dryRun,
        localMetadataPath
      });
      actions.push(stressStatus.action);
      if (stressStatus.warning) warnings.push(stressStatus.warning);
      if (stressStatus.error) errors.push(stressStatus.error);
      continue;
    }
    errors.push(`Unsupported acquisition mode ${String(repo.acquisition)} for repo ${repo.id}.`);
  }

  if (!dryRun) {
    mkdirSync(dirname(localMetadataPath), { recursive: true });
    mkdirSync(join(rootDir, 'bench/corpora/core'), { recursive: true });
    mkdirSync(join(rootDir, 'bench/corpora/extended'), { recursive: true });
    mkdirSync(join(rootDir, 'bench/worktrees'), { recursive: true });
  }

  return {
    ok: errors.length === 0,
    poolPath,
    localMetadataPath,
    rootDir,
    archiveDir,
    dryRun,
    shallow,
    requestedTiers,
    requestedRepos,
    actions,
    errors,
    warnings
  };
}

function materializeSubmodule({ rootDir, repo, shallow, dryRun }) {
  const registered = readGitmodules(rootDir).some((entry) => entry.path === repo.path);
  const args = registered
    ? [
        '-c', 'protocol.file.allow=always',
        'submodule', 'update', '--init',
        ...(shallow ? ['--depth', '1'] : []),
        '--', repo.path
      ]
    : [
        '-c', 'protocol.file.allow=always',
        'submodule', 'add',
        '-f',
        ...(shallow ? ['--depth', '1'] : []),
        repo.repoUrl,
        repo.path
      ];
  const action = {
    repoId: repo.id,
    tier: repo.tier,
    acquisition: repo.acquisition,
    path: repo.path,
    status: dryRun ? 'planned' : (registered ? 'initialized' : 'added'),
    command: ['git', ...args].join(' ')
  };
  if (dryRun) return action;
  const result = runGit(args, rootDir);
  if (result.status !== 0) {
    return { ...action, status: 'failed', error: `Failed to materialize submodule ${repo.id}: ${result.stderr || result.stdout}` };
  }
  return action;
}

function materializeStressClone({ rootDir, repo, shallow, dryRun, localMetadataPath }) {
  const args = [
    '-c', 'protocol.file.allow=always',
    'clone',
    ...(shallow ? ['--depth', '1'] : []),
    repo.repoUrl,
    repo.path
  ];
  const action = {
    repoId: repo.id,
    tier: repo.tier,
    acquisition: repo.acquisition,
    path: repo.path,
    status: dryRun ? 'planned' : 'cloned',
    command: ['git', ...args].join(' ')
  };
  if (dryRun) {
    return {
      action,
      warning: `Stress metadata would be written to ${localMetadataPath}.`
    };
  }
  const result = runGit(args, rootDir);
  if (result.status !== 0) {
    return {
      action: { ...action, status: 'failed' },
      error: `Failed to clone stress repo ${repo.id}: ${result.stderr || result.stdout}`
    };
  }
  const clonePath = join(rootDir, repo.path);
  const commitSha = readGitStdout(['rev-parse', 'HEAD'], clonePath).trim();
  const dirty = readGitStdout(['status', '--porcelain'], clonePath).trim().length > 0;
  if (dirty) {
    return {
      action: { ...action, status: 'failed' },
      error: `Stress repo ${repo.id} is dirty immediately after clone.`
    };
  }
  writeFileSync(localMetadataPath, JSON.stringify({
    enabled: true,
    repoUrl: repo.repoUrl,
    commitSha,
    fetchedAt: new Date().toISOString(),
    dirty: false
  }, null, 2) + '\n');
  return { action };
}

function materializeArchive({ rootDir, repo, dryRun, archivePath, localMetadataPath }) {
  const commitSha = detectArchiveCommitSha(archivePath);
  const archiveSha256 = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
  const relativeArchivePath = toPosixRelative(rootDir, archivePath);
  const action = {
    repoId: repo.id,
    tier: repo.tier,
    acquisition: repo.acquisition,
    path: repo.path,
    archivePath: relativeArchivePath,
    sourceCommitSha: commitSha,
    status: dryRun ? 'planned-extract' : 'extracted',
    command: `unzip -q ${relativeArchivePath} -d ${repo.path}`
  };
  if (dryRun) {
    return {
      action,
      warning: `Archive metadata would be written to ${localMetadataPath}.`
    };
  }
  const targetPath = join(rootDir, repo.path);
  mkdirSync(dirname(targetPath), { recursive: true });
  const tempDir = mkdtempSync(join(tmpdir(), `zincgraph-${repo.id}-`));
  try {
    const result = spawnSync('unzip', ['-q', archivePath, '-d', tempDir], {
      cwd: rootDir,
      encoding: 'utf8'
    });
    if ((result.status ?? 1) !== 0) {
      return {
        action: { ...action, status: 'failed' },
        error: `Failed to extract archive for ${repo.id}: ${result.stderr || result.stdout}`
      };
    }
    const children = readdirSync(tempDir).filter((entry) => entry !== '__MACOSX');
    if (children.length !== 1) {
      return {
        action: { ...action, status: 'failed' },
        error: `Archive for ${repo.id} must unpack to a single root directory, found ${children.length}.`
      };
    }
    const extractedRoot = join(tempDir, children[0]);
    try {
      renameSync(extractedRoot, targetPath);
    } catch (error) {
      if (error?.code !== 'EXDEV') {
        throw error;
      }
      cpSync(extractedRoot, targetPath, { recursive: true });
    }
    updateLocalArchiveMetadata({
      localMetadataPath,
      rootDir,
      repo,
      archivePath,
      archiveSha256,
      sourceCommitSha: commitSha
    });
    return { action };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function readGitmodules(rootDir) {
  const gitmodulesPath = join(rootDir, '.gitmodules');
  if (!existsSync(gitmodulesPath)) return [];
  const content = readFileSync(gitmodulesPath, 'utf8');
  const entries = [];
  let current = null;
  for (const line of content.split(/\r?\n/u)) {
    const sectionMatch = line.match(/^\[submodule "(.+)"\]$/u);
    if (sectionMatch) {
      current = { name: sectionMatch[1] };
      entries.push(current);
      continue;
    }
    const kvMatch = line.match(/^\s*(path|url)\s*=\s*(.+)$/u);
    if (current && kvMatch) {
      current[kvMatch[1]] = kvMatch[2];
    }
  }
  return entries;
}

function findArchiveForRepo(repo, archiveDir) {
  if (!existsSync(archiveDir)) return null;
  const entries = readdirSync(archiveDir)
    .filter((entry) => entry.toLowerCase().endsWith('.zip'))
    .map((entry) => join(archiveDir, entry));
  const repoName = String(repo.repoUrl ?? '').split('/').pop()?.replace(/\.git$/u, '') ?? '';
  const keys = [repoName, repo.id]
    .map((value) => normalizeArchiveToken(value))
    .filter(Boolean);
  const matches = entries.filter((archivePath) => {
    const normalized = normalizeArchiveToken(basename(archivePath));
    return keys.some((key) => normalized.includes(key));
  });
  return matches.sort((left, right) => basename(left).length - basename(right).length)[0] ?? null;
}

function normalizeArchiveToken(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/gu, '');
}

function detectArchiveCommitSha(archivePath) {
  const commentResult = spawnSync('unzip', ['-z', archivePath], {
    encoding: 'utf8'
  });
  const commentText = `${commentResult.stdout ?? ''}\n${commentResult.stderr ?? ''}`;
  const match = commentText.match(/\b([0-9a-f]{40})\b/iu) ?? basename(archivePath).match(/\b([0-9a-f]{40})\b/iu);
  return match?.[1] ?? null;
}

function updateLocalArchiveMetadata({ localMetadataPath, rootDir, repo, archivePath, archiveSha256, sourceCommitSha }) {
  const existing = existsSync(localMetadataPath) ? JSON.parse(readFileSync(localMetadataPath, 'utf8')) : {};
  const archives = { ...(existing.archives ?? {}) };
  const materializedAt = new Date().toISOString();
  archives[repo.id] = {
    sourceType: 'github-source-archive',
    repoUrl: repo.repoUrl,
    archivePath: toPosixRelative(rootDir, archivePath),
    archiveSha256,
    sourceCommitSha,
    extractedPath: repo.path,
    materializedAt,
    dirty: false
  };
  const next = {
    ...existing,
    archives
  };
  if (repo.tier === 'stress') {
    next.enabled = true;
    next.repoUrl = repo.repoUrl;
    next.commitSha = sourceCommitSha;
    next.fetchedAt = materializedAt;
    next.dirty = false;
  }
  writeFileSync(localMetadataPath, JSON.stringify(next, null, 2) + '\n');
}

function toPosixRelative(rootDir, path) {
  return relative(rootDir, path).split(sep).join('/');
}

function runGit(args, cwd) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8'
  });
}

function readGitStdout(args, cwd) {
  const result = runGit(args, cwd);
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  }
  return result.stdout;
}

function main() {
  const options = parsePoolSyncArgs(process.argv.slice(2));
  const result = materializeBenchmarkPool(options);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
