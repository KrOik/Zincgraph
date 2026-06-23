import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { buildCli, type CliBuildOptions } from '../../src/cli.js';
import { installZincgraph } from '../../src/installer/unified-installer.js';
import { createZincgraphToolRegistry } from '../../src/mcp/tool-registry.js';
import { autoSyncProject } from '../../src/freshness/auto-sync.js';
import type { ContextCapsule } from '../../src/fusion/query-engine.js';
import type { CodeGraphSnapshot } from '../../src/vector/code-to-vectors.js';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'zincgraph-pipeline-'));
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, 'auth.ts'), 'export function validateToken(token: string) { return token.length > 0; }');
  return root;
}

function capsule(query: string): ContextCapsule {
  return {
    query,
    strippedQuery: query,
    route: 'hybrid',
    filters: {},
    nodes: [{ nodeId: 'validate', filePath: 'auth.ts', language: 'typescript', kind: 'function', qualifiedName: 'validateToken', contentHash: 'hash', score: 1, sources: ['graph', 'vector'], sourceScores: { graph: 1, vector: 1 }, content: 'validateToken' }],
    documents: [],
    edges: [],
    freshness: { fresh: 1, pending: 0, stale: 0, failed: 0, total: 1, isFresh: true, warnings: [], entries: [] },
    policy: { textBranch: 'fusion-store-token-overlap', nativeFts: false },
    warnings: [],
    context: { maxTokens: 8000, usedTokens: 1, blocks: [], includedNodeIds: ['validate'], droppedNodeIds: [], truncated: false }
  };
}

async function runCli(args: string[], options: CliBuildOptions): Promise<string> {
  let output = '';
  const originalLog = console.log;
  const program = buildCli(options);
  program.exitOverride();
  program.configureOutput({ writeOut: (text) => { output += text; }, writeErr: (text) => { output += text; } });
  console.log = (value?: unknown) => { output += `${String(value)}\n`; };
  try {
    await program.parseAsync(['node', 'zincgraph', ...args]);
    return output;
  } finally {
    console.log = originalLog;
  }
}

function snapshot(projectPath: string): CodeGraphSnapshot {
  return {
    projectPath,
    files: [{ path: 'auth.ts', contentHash: 'fresh-hash', language: 'typescript' }],
    nodes: [{ id: 'validate', kind: 'function', name: 'validateToken', qualifiedName: 'validateToken', filePath: 'auth.ts', language: 'typescript', calls: [] }]
  };
}

describe('Phase 4 full pipeline integration', () => {
  test('runs injected init -> explore -> review pipeline through unified CLI', async () => {
    const project = fixture();
    const delegated: string[][] = [];
    const options: CliBuildOptions = {
      runCodeGraphCli: (args) => {
        delegated.push(args);
        return { command: 'codegraph', args, status: 0, stdout: '', stderr: '' };
      },
      createFusionEngine: () => ({ query: async (query) => capsule(query), search: async (query) => capsule(query) }),
      createFreshnessGate: () => ({ ensureReady: async () => ({ allowed: true, forced: false, synced: false, freshness: { fresh: 1, pending: 0, stale: 0, failed: 0, total: 1, isFresh: true, warnings: [], entries: [] }, warnings: [] }) }),
      runPonytailReview: (path) => ({ command: 'ponytail-audit', projectPath: path, diff: false, prompt: 'prompt', marker: 'PONYTAIL' }),
      readGraphSnapshot: (path) => snapshot(path)
    };
    await runCli(['init', project], options);
    const explore = JSON.parse(await runCli(['explore', 'token validation', '-p', project], options)) as { results: Array<{ qualifiedName: string }> };
    const review = await runCli(['review', project], options);
    expect(delegated[0]).toEqual(['init', project]);
    expect(explore.results[0]?.qualifiedName).toBe('validateToken');
    expect(review).toContain('PONYTAIL');
  });

  test('MCP registry exposes all 17 tools in pipeline', () => {
    expect(createZincgraphToolRegistry().tools).toHaveLength(17);
  });

  test('file edit simulation triggers auto-sync and clears stale state', async () => {
    const project = fixture();
    const result = await autoSyncProject(project, { files: [{ path: 'auth.ts', contentHash: 'fresh-hash' }] }, {
      debounceMs: 0,
      dependencies: { syncProject: async () => undefined, readSnapshot: () => snapshot(project) }
    });
    expect(result.transitions[0]?.fresh?.state).toBe('fresh');
  });

  test('install --yes configures isolated agent files', async () => {
    const project = fixture();
    const result = await installZincgraph({ projectPath: project, yes: true, initializeProject: false, dependencies: { buildInstructions: async () => 'RULES' } });
    expect(result.writtenPaths).toContain(join(project, '.mcp.json'));
    expect(readFileSync(join(project, '.mcp.json'), 'utf8')).toContain('mcp');
  });
});
