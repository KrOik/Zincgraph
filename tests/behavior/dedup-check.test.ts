import { describe, expect, test } from 'vitest';

import { DEFAULT_DEDUP_THRESHOLD, DedupChecker, createVectorDedupSearch, formatDedupResult, runDedupCheck } from '../../src/behavior/dedup-check.js';
import { runDedupCommand } from '../../src/behavior/dedup-command.js';
import { runDedupCheck as barrelRunDedupCheck } from '../../src/index.js';
import { DEFAULT_CHUNKER_VERSION } from '../../src/vector/chunker.js';
import type { DedupCandidate } from '../../src/behavior/dedup-check.js';

const candidates: DedupCandidate[] = [
  { nodeId: 'format-datetime', qualifiedName: 'src/date.ts::formatDateTime', filePath: 'src/date.ts', kind: 'function', score: 0.87 },
  { nodeId: 'parse-token', qualifiedName: 'src/auth.ts::parseToken', filePath: 'src/auth.ts', kind: 'function', score: 0.92 },
  { nodeId: 'low', qualifiedName: 'src/low.ts::lowMatch', filePath: 'src/low.ts', kind: 'function', score: 0.84 }
];

function checker(matches = candidates): DedupChecker {
  return new DedupChecker('/tmp/project', {
    dependencies: {
      search: async () => matches
    }
  });
}

describe('Phase 3 semantic dedup checker', () => {
  test('uses default threshold 0.85', () => {
    expect(new DedupChecker('/tmp/project', { dependencies: { search: async () => [] } }).threshold).toBe(DEFAULT_DEDUP_THRESHOLD);
  });

  test('suggests reuse for an above-threshold similar implementation', async () => {
    const result = await checker([candidates[0]!]).check({ description: 'formatDate as ISO string' });
    expect(result.recommendation.action).toBe('reuse');
    expect(result.recommendation.message).toContain('formatDateTime');
    expect(result.matches[0]?.score).toBe(0.87);
  });

  test('does not suggest reuse below threshold', async () => {
    const result = await checker([candidates[2]!]).check({ description: 'new unrelated function' });
    expect(result.recommendation.action).toBe('none');
    expect(result.matches).toHaveLength(0);
  });

  test('filters and sorts matches by score', async () => {
    const result = await checker(candidates).check({ description: 'parse token', topk: 2 });
    expect(result.matches.map((match) => match.nodeId)).toEqual(['parse-token', 'format-datetime']);
  });

  test('formats CLI command output for reuse suggestions', async () => {
    const command = await runDedupCommand({
      describe: 'format date',
      checker: checker([candidates[0]!, candidates[2]!])
    });
    expect(command.output).toContain('Semantic duplicate found');
    expect(command.output).toContain('checkType: dedup-check');
    expect(formatDedupResult(command.result)).toContain('matches=1');
  });

  test('runDedupCheck exposes a reusable programmatic API', async () => {
    const result = await runDedupCheck({
      description: 'format date',
      checker: checker([candidates[0]!])
    });
    expect(result.recommendation.action).toBe('reuse');
    expect(result.matches[0]?.qualifiedName).toContain('formatDateTime');
  });

  test('top-level barrel exports callable runDedupCheck', async () => {
    const result = await barrelRunDedupCheck({
      description: 'parse token',
      checker: checker([candidates[1]!])
    });
    expect(result.matches[0]?.nodeId).toBe('parse-token');
  });

  test('default vector dedup seam queries the vector collection', async () => {
    const calls: unknown[] = [];
    let destroyed = false;
    const search = createVectorDedupSearch(
      '/tmp/project',
      () => ({
        query: async (queries, topk) => {
          calls.push({ queries, topk });
          return [
            {
              id: 'zg-format',
              nodeId: 'format',
              filePath: 'src/date.ts',
              language: 'typescript',
              kind: 'function',
              qualifiedName: 'src/date.ts::formatDateTime',
              contentHash: 'hash',
              chunkerVersion: DEFAULT_CHUNKER_VERSION,
              score: 0.91
            }
          ];
        },
        destroy: () => {
          destroyed = true;
        }
      }),
      () => []
    );
    const [match] = await search('format date', 3);
    expect(calls).toEqual([{ queries: [{ text: 'format date' }], topk: 3 }]);
    expect(destroyed).toBe(true);
    expect(match).toMatchObject({ nodeId: 'format', score: 0.91 });
  });

  test('vector dedup ignores stale v1 vector results and documents', async () => {
    const search = createVectorDedupSearch(
      '/tmp/project',
      () => ({
        query: async () => [
          {
            id: 'zg-old',
            nodeId: 'old-format',
            filePath: 'src/date.ts',
            language: 'typescript',
            kind: 'function',
            qualifiedName: 'src/date.ts::oldFormatDate',
            contentHash: 'old',
            chunkerVersion: 'codegraph-node-v1',
            score: 0.99
          }
        ],
        destroy: () => {}
      }),
      () => [{
        id: 'old-format',
        nodeId: 'old-format',
        filePath: 'src/date.ts',
        language: 'typescript',
        kind: 'function',
        qualifiedName: 'src/date.ts::oldFormatDate',
        content: 'format date',
        contentHash: 'old',
        chunkerVersion: 'codegraph-node-v1',
        tokens: ['format', 'date'],
        contentSparse: {},
        embedding: []
      }]
    );
    await expect(search('format date', 3)).resolves.toEqual([]);
  });
});
