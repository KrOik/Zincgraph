import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCli } from '../../src/cli.js';
import { CcrStore } from '../../src/compression/ccr-store.js';
import { FeedbackStore } from '../../src/compression/feedback-store.js';

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

describe('CLI compression commands', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'zincgraph-cli-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('probe headroom command exists and is parseable', () => {
    const program = buildCli();
    const probeCmd = program.commands.find((c) => c.name() === 'probe');

    expect(probeCmd).toBeDefined();
  });

  test('compression-stats command exists', () => {
    const program = buildCli();
    const cmd = program.commands.find((c) => c.name() === 'compression-stats');

    expect(cmd).toBeDefined();
  });

  test('config command exists with get/set actions', () => {
    const program = buildCli();
    const cmd = program.commands.find((c) => c.name() === 'config');

    expect(cmd).toBeDefined();
  });

  test('retrieve command exists', () => {
    const program = buildCli();
    const cmd = program.commands.find((c) => c.name() === 'retrieve');

    expect(cmd).toBeDefined();
  });

  test('learn command exists', () => {
    const program = buildCli();
    const cmd = program.commands.find((c) => c.name() === 'learn');

    expect(cmd).toBeDefined();
  });

  test('retrieve records project feedback for known hashes', async () => {
    const ccrStore = new CcrStore({ projectPath: tempDir });
    const feedbackStore = new FeedbackStore({ projectPath: tempDir });
    ccrStore.put('hash-1', 'original content', 'text');
    feedbackStore.recordCompression({
      hash: 'hash-1',
      nodeId: 'node-1',
      source: 'graph',
      contentType: 'text',
      kind: 'function',
      compressedAt: Date.now()
    });

    const output = await runCli(['retrieve', 'hash-1', tempDir]);
    expect(output).toContain('original content');

    const retrievals = feedbackStore.listRetrievalEvents();
    expect(retrievals).toHaveLength(1);
    expect(retrievals[0]?.hash).toBe('hash-1');
    expect(retrievals[0]?.queryContext).toBe('');
  });
});
