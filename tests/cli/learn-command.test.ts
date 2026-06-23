import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCli } from '../../src/cli.js';
import { FeedbackStore, type SessionLog } from '../../src/compression/feedback-store.js';

function sessionLog(toolName: string, output: string, input = '', error = ''): SessionLog {
  return {
    recordedAt: Date.now(),
    toolName,
    input,
    output,
    durationMs: 12,
    error
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

describe('CLI learn command', () => {
  let tempDir: string;
  let historyStore: FeedbackStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'zincgraph-learn-cli-'));
    historyStore = new FeedbackStore({ projectPath: tempDir });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('dry-run prints an AGENTS-style report without writing files', async () => {
    const failurePath = join(tempDir, 'failures.json');
    writeFileSync(
      failurePath,
      JSON.stringify([
        sessionLog('zincgraph_review', 'ignored false positive finding'),
        sessionLog('zincgraph_review', 'ignored false positive finding'),
        sessionLog('zincgraph_explore', '{"nodes":[]}', 'token validation')
      ], null, 2),
      'utf8'
    );

    const output = await runCli(['learn', tempDir, '--from-failures', failurePath, '--output', 'agents-md', '--dry-run', '--min-occurrences', '1']);
    expect(output).toContain('zincgraph:learn:START');
    expect(output).toContain('review-false-positive');
    expect(existsSync(join(tempDir, 'AGENTS.md'))).toBe(false);
  });

  test('from-failures accepts JSONL input line by line', async () => {
    const failurePath = join(tempDir, 'failures.jsonl');
    writeFileSync(
      failurePath,
      [
        JSON.stringify(sessionLog('zincgraph_review', 'ignored false positive finding')),
        JSON.stringify(sessionLog('zincgraph_review', 'ignored false positive finding')),
        JSON.stringify(sessionLog('zincgraph_explore', '{"nodes":[]}', 'token validation'))
      ].join('\n'),
      'utf8'
    );

    const output = await runCli(['learn', tempDir, '--from-failures', failurePath, '--output', 'json', '--min-occurrences', '1']);
    const parsed = JSON.parse(output) as { patterns: Array<{ type: string; occurrences: number }> };
    expect(parsed.patterns.map((pattern) => pattern.type).sort()).toEqual(['empty-search', 'review-false-positive']);
    expect(parsed.patterns[0]?.occurrences).toBeGreaterThan(0);
  });

  test('from-history with json output returns structured analysis', async () => {
    historyStore.recordSessionLog(sessionLog('zincgraph_review', 'ignored false positive finding'));
    historyStore.recordSessionLog(sessionLog('zincgraph_review', 'ignored false positive finding'));
    historyStore.recordSessionLog(sessionLog('zincgraph_review', 'warning: stale embeddings for src/auth.ts'));

    const output = await runCli(['learn', tempDir, '--from-history', '--output', 'json', '--min-occurrences', '1']);
    const parsed = JSON.parse(output) as { patterns: Array<{ type: string; occurrences: number }> };
    expect(parsed.patterns.map((pattern) => pattern.type).sort()).toEqual(['review-false-positive', 'stale-index']);
    expect(parsed.patterns[0]?.occurrences).toBeGreaterThan(0);
  });

  test('from-history decodes structured semantic-search session logs without false stale-index hits', async () => {
    historyStore.recordSessionLog(sessionLog('zincgraph_semantic_search', JSON.stringify({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            query: 'token validation',
            nodes: [],
            documents: [],
            freshness: { isFresh: true },
            policy: { nativeFts: false }
          })
        }
      ],
      isError: false
    })));

    const output = await runCli(['learn', tempDir, '--from-history', '--output', 'json', '--min-occurrences', '1']);
    const parsed = JSON.parse(output) as { patterns: Array<{ type: string }> };
    expect(parsed.patterns.map((pattern) => pattern.type)).toContain('empty-search');
    expect(parsed.patterns.map((pattern) => pattern.type)).not.toContain('stale-index');
  });

  test('non-dry AGENTS mode writes a block file', async () => {
    historyStore.recordSessionLog(sessionLog('zincgraph_review', 'ignored false positive finding'));
    historyStore.recordSessionLog(sessionLog('zincgraph_review', 'ignored false positive finding'));

    await runCli(['learn', tempDir, '--from-history', '--output', 'agents-md', '--min-occurrences', '1']);
    const agentsPath = join(tempDir, 'AGENTS.md');
    expect(existsSync(agentsPath)).toBe(true);
    expect(historyStore.listSessionLogs()).toHaveLength(2);
  });
});
