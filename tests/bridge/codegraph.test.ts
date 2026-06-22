import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  getCodeGraphStatus,
  isCodeGraphSdkLoadable,
  runCodeGraphCli,
  type CodeEdge,
  type CodeNode
} from '../../src/bridge/codegraphAdapter.js';

const CODEGRAPH_CLI_TEST_TIMEOUT_MS = 30_000;

describe('CodeGraph Phase 0 adapter', () => {
  test('re-exports core graph node and edge types', () => {
    const node: Pick<CodeNode, 'id' | 'kind' | 'name' | 'filePath'> = {
      id: 'node-1',
      kind: 'function',
      name: 'phaseZero',
      filePath: 'src/phaseZero.ts'
    };
    const edge: CodeEdge = { source: 'node-1', target: 'node-2', kind: 'calls' };

    expect(node.kind).toBe('function');
    expect(edge.kind).toBe('calls');
  });

  test('loads the @colbymchenry/codegraph SDK entry', async () => {
    await expect(isCodeGraphSdkLoadable()).resolves.toBe(true);
  });

  test('reports a non-initialized project without indexing side effects when SDK runtime supports it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zincgraph-codegraph-'));
    try {
      writeFileSync(join(dir, 'sample.ts'), 'export function sample() { return 1; }\\n');
      await expect(getCodeGraphStatus(dir)).resolves.toMatchObject({
        initialized: false,
        fileCount: 0,
        nodeCount: 0,
        edgeCount: 0
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/node:sqlite|CodeGraph|SDK|facade/i);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test('delegates status to the CodeGraph CLI shim', () => {
    const result = runCodeGraphCli(['status', process.cwd(), '--json']);

    expect(result.args).toEqual(['status', process.cwd(), '--json']);
    expect(result.command).toContain('codegraph');
    expect(typeof result.status).toBe('number');
  }, CODEGRAPH_CLI_TEST_TIMEOUT_MS);

  test('uses the same status command shape required by zincgraph status', () => {
    const result = runCodeGraphCli(['status', '.', '--json']);
    expect(result.args.slice(0, 2)).toEqual(['status', '.']);
  });
});
