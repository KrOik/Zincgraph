import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCli } from '../../src/cli.js';
import { FeedbackStore, type SessionLog } from '../../src/compression/feedback-store.js';

function sessionLog(toolName: string, output: string): SessionLog {
  return {
    recordedAt: Date.now(),
    toolName,
    input: '',
    output,
    durationMs: 9
  };
}

async function runCli(args: string[]): Promise<string> {
  let output = '';
  const originalLog = console.log;
  const originalError = console.error;
  const program = buildCli();
  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => { output += text; },
    writeErr: (text) => { output += text; }
  });
  console.log = (value?: unknown) => { output += `${String(value)}\n`; };
  console.error = (value?: unknown) => { output += `${String(value)}\n`; };
  try {
    await program.parseAsync(['node', 'zincgraph', ...args]);
    return output;
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

describe('learn from history integration', () => {
  let tempDir: string;
  let store: FeedbackStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'zincgraph-learn-history-'));
    store = new FeedbackStore({ projectPath: tempDir });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('learn --from-history consumes session logs and leaves files untouched in dry-run', async () => {
    store.recordSessionLog(sessionLog('zincgraph_review', 'ignored false positive finding'));
    store.recordSessionLog(sessionLog('zincgraph_review', 'ignored false positive finding'));
    store.recordSessionLog(sessionLog('zincgraph_explore', '{"nodes":[]}'));

    const output = await runCli(['learn', tempDir, '--from-history', '--output', 'agents-md', '--dry-run', '--min-occurrences', '1']);
    expect(output).toContain('zincgraph:learn:START');
    expect(output).toContain('review-false-positive');
    expect(output).toContain('empty-search');
    expect(existsSync(join(tempDir, 'AGENTS.md'))).toBe(false);
  });
});
