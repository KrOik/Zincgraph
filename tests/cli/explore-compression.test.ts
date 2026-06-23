import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCli } from '../../src/cli.js';
import * as fusionCompressorModule from '../../src/compression/fusion-compressor.js';
import { TopoSemanticQueryEngine, type ContextCapsule } from '../../src/fusion/query-engine.js';

function capsule(query: string): ContextCapsule {
  return {
    query,
    strippedQuery: query,
    route: 'hybrid',
    filters: {},
    nodes: [],
    documents: [],
    edges: [],
    freshness: { fresh: 0, pending: 0, stale: 0, failed: 0, total: 0, isFresh: true, warnings: [], entries: [] },
    policy: { textBranch: 'fusion-store-token-overlap', nativeFts: false },
    warnings: [],
    context: { maxTokens: 8000, usedTokens: 0, blocks: [], includedNodeIds: [], droppedNodeIds: [], truncated: false }
  };
}

async function runCli(args: string[]): Promise<string> {
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
    return output;
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

describe('CLI explore compression wiring', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'zincgraph-explore-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('explore wires a project-scoped compressor by default', async () => {
    const createSpy = vi.spyOn(fusionCompressorModule, 'createProjectFusionCompressor');
    const querySpy = vi.spyOn(TopoSemanticQueryEngine.prototype, 'query').mockResolvedValue(capsule('token validation'));

    try {
      const output = await runCli(['explore', 'token validation', '-p', tempDir, '--topk', '2']);
      expect(JSON.parse(output).query).toBe('token validation');
      expect(createSpy).toHaveBeenCalledWith(tempDir);
      expect(querySpy).toHaveBeenCalled();
    } finally {
      createSpy.mockRestore();
      querySpy.mockRestore();
    }
  });
});
