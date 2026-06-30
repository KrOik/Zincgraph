import { describe, expect, test, vi } from 'vitest';

const fastCliMocks = vi.hoisted(() => {
  const buildFastContextCapsule = vi.fn(async (command: string, options: { project: string; query: string; topk: number; maxTokens: number }) => ({
    query: options.query,
    strippedQuery: options.query,
    intent: 'graph-navigation',
    route: command === 'search' ? 'graph-first' : 'hybrid',
    filters: {},
    nodes: [],
    documents: [],
    edges: [],
    freshness: { fresh: 0, pending: 0, stale: 0, failed: 0, total: 0, isFresh: true, warnings: [], entries: [] },
    policy: { textBranch: 'fusion-store-token-overlap', nativeFts: false },
    warnings: [],
    context: { maxTokens: options.maxTokens, usedTokens: 0, blocks: [], includedNodeIds: [], droppedNodeIds: [], truncated: false },
    evidence: 'fast-context'
  }));
  const buildRegistryFastCapsule = vi.fn(async () => null);
  return { buildFastContextCapsule, buildRegistryFastCapsule };
});

vi.mock('../../src/fast-cli.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/fast-cli.js')>('../../src/fast-cli.js');
  return {
    ...actual,
    buildFastContextCapsule: fastCliMocks.buildFastContextCapsule,
    buildRegistryFastCapsule: fastCliMocks.buildRegistryFastCapsule
  };
});

import { buildCli } from '../../src/cli.js';

async function runCliResult(args: string[]): Promise<{ output: string; error?: unknown }> {
  let output = '';
  const originalLog = console.log;
  const originalError = console.error;
  const program = buildCli();
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
  try {
    await program.parseAsync(['node', 'zincgraph', ...args]);
    return { output };
  } catch (error) {
    return { output, error };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function runCli(args: string[]): Promise<string> {
  const result = await runCliResult(args);
  if (result.error) {
    throw result.error;
  }
  return result.output;
}

describe('full-json fast path wiring', () => {
  test('explore full-json uses the fast context capsule only when explicitly opted in', async () => {
    const output = await runCli(['explore', '--full-json', '--fast-full-json', '-p', '/repo', 'cli/lib.rs resolve_flags_and_init']);
    const payload = JSON.parse(output) as { query: string; route: string; evidence: string };

    expect(payload.query).toBe('cli/lib.rs resolve_flags_and_init');
    expect(payload.route).toBe('hybrid');
    expect(payload.evidence).toBe('fast-context');
    expect(fastCliMocks.buildFastContextCapsule).toHaveBeenCalledWith('explore', expect.objectContaining({
      project: '/repo',
      query: 'cli/lib.rs resolve_flags_and_init',
      topk: 10,
      maxTokens: 8000
    }));
    expect(fastCliMocks.buildRegistryFastCapsule).not.toHaveBeenCalled();
  });

  test('search full-json uses the fast context capsule only when explicitly opted in', async () => {
    fastCliMocks.buildFastContextCapsule.mockClear();
    fastCliMocks.buildRegistryFastCapsule.mockClear();

    const output = await runCli(['search', '--full-json', '--fast-full-json', '-p', '/repo', 'superset/mcp_service/__main__.py main']);
    const payload = JSON.parse(output) as { query: string; route: string; evidence: string };

    expect(payload.query).toBe('superset/mcp_service/__main__.py main');
    expect(payload.route).toBe('graph-first');
    expect(payload.evidence).toBe('fast-context');
    expect(fastCliMocks.buildFastContextCapsule).toHaveBeenCalledWith('search', expect.objectContaining({
      project: '/repo',
      query: 'superset/mcp_service/__main__.py main',
      topk: 10,
      maxTokens: 8000
    }));
    expect(fastCliMocks.buildRegistryFastCapsule).not.toHaveBeenCalled();
  });

  test('explore full-json fails instead of falling back when the fast context capsule rejects', async () => {
    fastCliMocks.buildFastContextCapsule.mockRejectedValueOnce(new Error('fast path boom'));
    fastCliMocks.buildRegistryFastCapsule.mockClear();

    const result = await runCliResult(['explore', '--full-json', '--fast-full-json', '-p', '/repo', 'cli/lib.rs resolve_flags_and_init']);

    expect(result.error).toBeInstanceOf(Error);
    expect(String((result.error as Error).message)).toContain('fast path boom');
    expect(result.output).not.toContain('falling back');
    expect(fastCliMocks.buildRegistryFastCapsule).not.toHaveBeenCalled();
  });

  test('search full-json fails instead of falling back when the fast context capsule returns null', async () => {
    fastCliMocks.buildFastContextCapsule.mockResolvedValueOnce(null as never);
    fastCliMocks.buildRegistryFastCapsule.mockClear();

    const result = await runCliResult(['search', '--full-json', '--fast-full-json', '-p', '/repo', 'superset/mcp_service/__main__.py main']);

    expect(result.error).toBeInstanceOf(Error);
    expect(String((result.error as Error).message)).toContain('did not produce a context capsule');
    expect(result.output).not.toContain('falling back');
    expect(fastCliMocks.buildRegistryFastCapsule).not.toHaveBeenCalled();
  });
});
