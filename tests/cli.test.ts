import { describe, expect, test } from 'vitest';

import { buildCli, type CliBuildOptions } from '../src/cli.js';
import type { PonytailCommandDelegation } from '../src/bridge/ponytailAdapter.js';
import type { FreshnessGateOptions } from '../src/freshness/freshness-gate.js';
import type { ContextCapsule } from '../src/fusion/query-engine.js';
import type { DedupCommandResult } from '../src/behavior/dedup-command.js';
import type { GraphReviewCommandOptions } from '../src/behavior/review-command.js';
import type { CodeGraphSnapshot } from '../src/vector/code-to-vectors.js';
import type { UnifiedInstallResult } from '../src/installer/unified-installer.js';
import type { AutoSyncResult, RunAutoSyncOnceInput } from '../src/freshness/auto-sync.js';

function capsule(query: string): ContextCapsule {
  return {
    query,
    strippedQuery: query,
    route: 'hybrid',
    filters: {},
    nodes: [
      {
        nodeId: 'node-1',
        filePath: 'src/auth.ts',
        language: 'typescript',
        kind: 'function',
        qualifiedName: 'validateToken',
        contentHash: 'hash',
        score: 1,
        sources: ['graph', 'vector'],
        sourceScores: { graph: 1, vector: 1 },
        content: 'function validateToken() {}'
      }
    ],
    documents: [],
    edges: [],
    freshness: { fresh: 1, pending: 0, stale: 0, failed: 0, total: 1, isFresh: true, warnings: [], entries: [] },
    policy: { textBranch: 'fusion-store-token-overlap', nativeFts: false },
    warnings: [],
    context: { maxTokens: 8000, usedTokens: 5, blocks: [], includedNodeIds: ['node-1'], droppedNodeIds: [], truncated: false }
  };
}

function ponytailDelegation(projectPath: string, diff = false): PonytailCommandDelegation {
  return {
    command: diff ? 'ponytail-review' : 'ponytail-audit',
    projectPath,
    diff,
    prompt: 'review prompt',
    marker: 'PONYTAIL'
  };
}

function emptySnapshot(projectPath: string): CodeGraphSnapshot {
  return { projectPath, files: [], nodes: [] };
}

function autoSyncResult(projectPath: string, filePath = 'auth.ts'): AutoSyncResult {
  const entry = {
    entryKey: `local:v1:${filePath}`,
    filePath,
    embeddingProfile: 'local',
    chunkerVersion: 'v1',
    state: 'fresh' as const,
    contentHash: 'hash',
    docIds: [],
    updatedAt: 1
  };
  return {
    projectPath,
    source: 'cli',
    startedAt: 1,
    completedAt: 2,
    transitions: [{ filePath, stale: { ...entry, state: 'stale' }, pending: { ...entry, state: 'pending' }, fresh: entry }],
    warnings: []
  };
}

async function runCli(args: string[], options: CliBuildOptions = {}): Promise<string> {
  let output = '';
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const program = buildCli({
    createFusionEngine: () => ({
      query: async (query: string) => capsule(query),
      search: async (query: string) => capsule(query)
    }),
    ...options
  });
  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => {
      output += text;
    },
    writeErr: (text) => {
      output += text;
    }
  });
  console.log = (value?: unknown) => {
    output += `${String(value)}\n`;
  };
  console.error = (value?: unknown) => {
    output += `${String(value)}\n`;
  };
  process.stdout.write = ((chunk: unknown, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    output += String(chunk);
    if (typeof encoding === 'function') {
      encoding();
    } else if (callback) {
      callback();
    }
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    output += String(chunk);
    if (typeof encoding === 'function') {
      encoding();
    } else if (callback) {
      callback();
    }
    return true;
  }) as typeof process.stderr.write;
  try {
    await program.parseAsync(['node', 'zincgraph', ...args]);
    return output;
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

describe('Phase 2 CLI integration', () => {
  test('explore command prints compact JSON by default', async () => {
    const output = await runCli(['explore', 'token validation', '--topk', '2']);
    const parsed = JSON.parse(output) as {
      results: Array<{ sources: string[] }>;
      route: string;
      textBranch: string;
      nativeFts: false | string;
    };
    expect(parsed.results[0]?.sources).toEqual(['graph', 'vector']);
    expect(parsed.route).toBe('hybrid');
    expect(parsed.textBranch).toBe('fusion-store-token-overlap');
    expect(parsed.nativeFts).toBe(false);
  });

  test('explore --format full-json preserves the context capsule shape', async () => {
    const output = await runCli(['explore', 'token validation', '--topk', '2', '--format', 'full-json']);
    const parsed = JSON.parse(output) as ContextCapsule;
    expect(parsed.nodes[0]?.sources).toEqual(['graph', 'vector']);
  });

  test('status --json forwards raw CodeGraph output', async () => {
    const output = await runCli(['status', '.', '--json'], {
      runCodeGraphCli: () => ({
        command: 'codegraph',
        args: ['status', '.', '--json'],
        status: 0,
        stdout: JSON.stringify({
          initialized: true,
          fileCount: 1,
          nodeCount: 2,
          edgeCount: 3,
          languages: ['typescript']
        }),
        stderr: ''
      })
    });
    const parsed = JSON.parse(output) as { delegated?: boolean; initialized: boolean; fileCount: number };
    expect(parsed.delegated).toBeUndefined();
    expect(parsed.initialized).toBe(true);
    expect(parsed.fileCount).toBe(1);
  });

  test('status --delegated-json wraps CodeGraph output with Zincgraph metadata', async () => {
    const output = await runCli(['status', '.', '--json', '--delegated-json'], {
      runCodeGraphCli: () => ({
        command: 'codegraph',
        args: ['status', '.', '--json'],
        status: 0,
        stdout: JSON.stringify({
          initialized: true,
          fileCount: 1,
          nodeCount: 2,
          edgeCount: 3,
          languages: ['typescript']
        }),
        stderr: ''
      })
    });
    const parsed = JSON.parse(output) as { delegated: boolean; upstream: { initialized: boolean; fileCount: number } };
    expect(parsed.delegated).toBe(true);
    expect(parsed.upstream.initialized).toBe(true);
    expect(parsed.upstream.fileCount).toBe(1);
  });

  test('search command supports fielded query syntax', async () => {
    const output = await runCli(['search', 'kind:function name:auth', '--topk', '2']);
    const parsed = JSON.parse(output) as ContextCapsule;
    expect(parsed.query).toBe('kind:function name:auth');
  });

  test('review syncs stale freshness before delegating', async () => {
    const events: string[] = [];
    await runCli(['review', '.', '--diff'], {
      createFreshnessGate: () => ({
        ensureReady: async (options: FreshnessGateOptions = {}) => {
          events.push('gate');
          await options.sync?.();
          return { allowed: true, forced: false, synced: true, freshness: { fresh: 1, pending: 0, stale: 0, failed: 0, total: 1, isFresh: true, warnings: [], entries: [] }, warnings: [] };
        }
      }),
      syncProject: async () => { events.push('sync'); },
      readGraphSnapshot: (project) => emptySnapshot(project),
      readGraphDiff: () => '',
      runPonytailReview: (project, options = {}) => ponytailDelegation(project, options.diff ?? false)
    });
    expect(events).toEqual(['gate', 'sync']);
  });

  test('review appends graph evidence without replacing Ponytail delegation output', async () => {
    const output = await runCli(['review', '.', '--diff'], {
      createFreshnessGate: () => ({
        ensureReady: async () => ({ allowed: true, forced: false, synced: false, freshness: { fresh: 1, pending: 0, stale: 0, failed: 0, total: 1, isFresh: true, warnings: [], entries: [] }, warnings: [] })
      }),
      runPonytailReview: (project, options = {}) => ponytailDelegation(project, options.diff ?? false),
      runGraphReview: async (project) => ({
        projectPath: project,
        ponytail: ponytailDelegation(project, true),
        graph: null,
        graphFindings: [
          {
            type: 'same-signature',
            severity: 'warning',
            message: 'Existing same-signature function formatDate at src/date.ts:12',
            evidence: {}
          }
        ],
        graphAvailable: true,
        warnings: []
      })
    });
    expect(output).toContain('PONYTAIL');
    expect(output).toContain('Zincgraph graph evidence: 1 finding');
    expect(output).toContain('Existing same-signature function');
  });

  test('review command enables compression and project-scoped feedback loops by default', async () => {
    let observed: GraphReviewCommandOptions | undefined;
    await runCli(['review', '.', '--force'], {
      createFreshnessGate: () => ({
        ensureReady: async () => ({ allowed: true, forced: true, synced: false, freshness: { fresh: 1, pending: 0, stale: 0, failed: 0, total: 1, isFresh: true, warnings: [], entries: [] }, warnings: [] })
      }),
      readGraphSnapshot: (project) => emptySnapshot(project),
      runPonytailReview: (project, options = {}) => ponytailDelegation(project, options.diff ?? false),
      runGraphReview: async (project, options) => {
        observed = options;
        return {
          projectPath: project,
          ponytail: ponytailDelegation(project, options.diff ?? false),
          graph: null,
          graphFindings: [],
          graphAvailable: true,
          warnings: []
        };
      }
    });
    expect(observed?.compress).toBe(true);
    expect(observed?.feedbackLoop).toBeDefined();
  });

  test('review force bypasses freshness blocking', async () => {
    let forced: boolean | undefined;
    await runCli(['review', '.', '--force'], {
      createFreshnessGate: () => ({
        ensureReady: async (options: FreshnessGateOptions = {}) => {
          forced = options.force;
          return { allowed: true, forced: true, synced: false, freshness: { fresh: 0, pending: 0, stale: 1, failed: 0, total: 1, isFresh: false, warnings: ['1 files have stale embeddings'], entries: [] }, warnings: ['1 files have stale embeddings'] };
        }
      }),
      readGraphSnapshot: (project) => emptySnapshot(project),
      runPonytailReview: (project, options = {}) => ponytailDelegation(project, options.diff ?? false)
    });
    expect(forced).toBe(true);
  });

  test('review default graph path reuses a single Ponytail delegation', async () => {
    let ponytailCalls = 0;
    const output = await runCli(['review', '.', '--force'], {
      createFreshnessGate: () => ({
        ensureReady: async () => ({ allowed: true, forced: true, synced: false, freshness: { fresh: 1, pending: 0, stale: 0, failed: 0, total: 1, isFresh: true, warnings: [], entries: [] }, warnings: [] })
      }),
      readGraphSnapshot: (project) => emptySnapshot(project),
      runPonytailReview: (project, options = {}) => {
        ponytailCalls += 1;
        return ponytailDelegation(project, options.diff ?? false);
      }
    });
    expect(ponytailCalls).toBe(1);
    expect(output).toContain('PONYTAIL');
    expect(output).toContain('# Graph review (compressed): 0 finding group(s)');
  });

  test('review reports index-not-fresh when sync fails', async () => {
    await expect(runCli(['review', '.'], {
      createFreshnessGate: () => ({
        ensureReady: async () => ({ allowed: false, forced: false, synced: false, freshness: { fresh: 0, pending: 0, stale: 1, failed: 0, total: 1, isFresh: false, warnings: ['1 files have stale embeddings'], entries: [] }, warnings: ['1 files have stale embeddings', 'index not fresh: sync failed'] })
      })
    })).rejects.toThrow('index not fresh');
  });

  test('dedup command prints semantic reuse suggestions', async () => {
    const result: DedupCommandResult = {
      result: {
        description: 'format date',
        threshold: 0.85,
        matches: [{ nodeId: 'format', qualifiedName: 'src/date.ts::formatDateTime', filePath: 'src/date.ts', kind: 'function', score: 0.87 }],
        recommendation: { action: 'reuse', message: 'Semantic duplicate found: reuse formatDateTime' }
      },
      output: 'Semantic duplicate found: reuse formatDateTime\nmatches=1'
    };
    const output = await runCli(['dedup', '--describe', 'format date'], {
      runDedup: async () => result
    });
    expect(output).toContain('Semantic duplicate found');
  });

  test('dedup command rejects invalid thresholds', async () => {
    await expect(runCli(['dedup', '--describe', 'x', '--threshold', '1.5'])).rejects.toThrow('threshold');
  });
});


describe('Phase 4 CLI production readiness', () => {
  test('callers command delegates to CodeGraph', async () => {
    const calls: string[][] = [];
    await runCli(['callers', 'authenticateUser', '-p', '/repo'], {
      runCodeGraphCli: (args) => {
        calls.push(args);
        return { command: 'codegraph', args, status: 0, stdout: '', stderr: '' };
      }
    });
    expect(calls[0]).toEqual(['callers', 'authenticateUser', '-p', '/repo']);
  });

  test('search remains fusion-backed by default', async () => {
    const output = await runCli(['search', 'token validation']);
    expect(JSON.parse(output).query).toBe('token validation');
  });

  test('search --codegraph delegates to upstream query', async () => {
    const calls: string[][] = [];
    await runCli(['search', '--codegraph', '--kind', 'function', '--json', 'validate', '-p', '/repo'], {
      runCodeGraphCli: (args) => {
        calls.push(args);
        return { command: 'codegraph', args, status: 0, stdout: '', stderr: '' };
      }
    });
    expect(calls[0]).toEqual(['query', 'validate', '-p', '/repo', '--limit', '10', '--kind', 'function', '--json']);
  });

  test('mcp command starts injected unified server', async () => {
    const events: string[] = [];
    await runCli(['mcp'], { startMcpServer: async () => { events.push('mcp'); return {} as Awaited<ReturnType<NonNullable<CliBuildOptions['startMcpServer']>>>; } });
    expect(events).toEqual(['mcp']);
  });

  test('install --yes invokes scoped installer', async () => {
    const result: UnifiedInstallResult = {
      projectPath: '/repo',
      configRoot: '/repo',
      dryRun: false,
      selectedTargets: [],
      skippedTargets: [],
      writes: [],
      writtenPaths: ['/repo/.mcp.json'],
      initialized: true,
      vectorized: true,
      messages: ['ok']
    };
    const output = await runCli(['install', '/repo', '--yes'], { runInstaller: async () => result });
    expect(output).toContain('/repo/.mcp.json');
  });

  test('auto-sync command calls canonical runtime helper and prints JSON', async () => {
    let calledProject = '';
    let calledInput: RunAutoSyncOnceInput | readonly string[] | undefined;

    const output = await runCli(['auto-sync', '/repo', '--file', 'auth.ts'], {
      runAutoSyncOnce: async (project, input) => {
        calledProject = project;
        calledInput = input;
        return autoSyncResult(project);
      }
    });

    const parsed = JSON.parse(output) as AutoSyncResult;
    expect(calledProject).toBe('/repo');
    expect(calledInput).toEqual({ files: ['auth.ts'], source: 'cli' });
    expect(parsed.transitions[0]?.filePath).toBe('auth.ts');
  });

  test('auto-sync requires at least one changed file', async () => {
    await expect(runCli(['auto-sync', '/repo'])).rejects.toThrow('at least one changed file');
  });

  test('auto-sync surfaces unsafe path failures before success output', async () => {
    await expect(runCli(['auto-sync', '/repo', '--file', '/tmp/auth.ts'], {
      runAutoSyncOnce: async () => {
        throw new Error('Auto-sync changed file paths must be project-relative: /tmp/auth.ts');
      }
    })).rejects.toThrow('project-relative');
  });

  test('sync remains delegated to upstream CodeGraph', async () => {
    const calls: string[][] = [];
    await runCli(['sync', '/repo'], {
      runCodeGraphCli: (args) => {
        calls.push(args);
        return { command: 'codegraph', args, status: 0, stdout: '', stderr: '' };
      }
    });
    expect(calls[0]).toEqual(['sync', '/repo']);
  });

  test('audit command runs graph-enhanced audit path', async () => {
    const output = await runCli(['audit', '.', '--force'], {
      createFreshnessGate: () => ({
        ensureReady: async () => ({ allowed: true, forced: true, synced: false, freshness: { fresh: 1, pending: 0, stale: 0, failed: 0, total: 1, isFresh: true, warnings: [], entries: [] }, warnings: [] })
      }),
      readGraphSnapshot: (project) => emptySnapshot(project),
      runPonytailReview: (project) => ponytailDelegation(project, false)
    });
    expect(output).toContain('PONYTAIL');
  });
});
