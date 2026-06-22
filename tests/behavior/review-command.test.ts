import { describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { formatGraphReviewCommandResult, runGraphReviewCommand } from '../../src/behavior/review-command.js';
import { readGitDiff } from '../../src/behavior/graph-review.js';
import type { PonytailCommandDelegation } from '../../src/bridge/ponytailAdapter.js';
import type { CodeGraphSnapshot } from '../../src/vector/code-to-vectors.js';

const snapshot: CodeGraphSnapshot = {
  projectPath: '/tmp/project',
  files: [{ path: 'src/date.ts', contentHash: 'hash', language: 'typescript' }],
  nodes: [
    {
      id: 'format-existing',
      kind: 'function',
      name: 'formatDate',
      qualifiedName: 'src/date.ts::formatDate',
      filePath: 'src/date.ts',
      language: 'typescript',
      signature: 'function formatDate(value: Date): string',
      calls: []
    }
  ]
};

function ponytail(projectPath: string): PonytailCommandDelegation {
  return {
    command: 'ponytail-review',
    projectPath,
    diff: true,
    prompt: 'review prompt',
    marker: 'PONYTAIL'
  };
}

describe('Phase 3 graph review command', () => {
  test('exposes graphAvailable=false while preserving Ponytail delegation on graph failure', async () => {
    const result = await runGraphReviewCommand('/tmp/project', {
      diff: true,
      runPonytail: (project) => ponytail(project),
      readSnapshot: () => {
        throw new Error('snapshot unavailable');
      }
    });
    expect(result.graphAvailable).toBe(false);
    expect(result.graphFindings).toHaveLength(0);
    expect(result.warnings[0]).toContain('snapshot unavailable');
    expect(formatGraphReviewCommandResult(result)).toEqual(expect.arrayContaining(['PONYTAIL', expect.stringContaining('warning: graph review unavailable')]));
  });

  test('exposes injected diff reader failures without hiding Ponytail delegation', async () => {
    const result = await runGraphReviewCommand('/tmp/project', {
      diff: true,
      snapshot,
      runPonytail: (project) => ponytail(project),
      readDiff: () => {
        throw new Error('git diff unavailable: fake failure');
      }
    });
    expect(result.graphAvailable).toBe(false);
    expect(result.graphFindings).toHaveLength(0);
    expect(result.warnings[0]).toContain('git diff unavailable');
    expect(formatGraphReviewCommandResult(result)).toEqual(expect.arrayContaining(['PONYTAIL', expect.stringContaining('git diff unavailable')]));
  });

  test('uses injected diff reader text when diff mode is enabled', async () => {
    const result = await runGraphReviewCommand('/tmp/project', {
      diff: true,
      snapshot,
      runPonytail: (project) => ponytail(project),
      readDiff: () => `+++ b/src/new.ts\n+function formatDate(value: Date): string { return ''; }`
    });
    expect(result.graphAvailable).toBe(true);
    expect(result.graphFindings.some((finding) => finding.type === 'same-signature')).toBe(true);
  });

  test('default git diff reader fails visibly outside a git worktree', () => {
    const directory = mkdtempSync(join(tmpdir(), 'zincgraph-no-git-'));
    try {
      expect(() => readGitDiff(directory)).toThrow(/git diff unavailable/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
