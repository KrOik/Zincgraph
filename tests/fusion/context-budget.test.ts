import { describe, expect, test } from 'vitest';

import { applyContextBudget, compareCandidatePriority, truncateContent } from '../../src/fusion/context-budget.js';
import type { BudgetableCandidate } from '../../src/fusion/context-budget.js';

function candidate(index: number, sources: BudgetableCandidate['sources'], content = `function symbol${index}() { return ${index}; }`): BudgetableCandidate {
  return {
    nodeId: `node-${index}`,
    filePath: `src/file${index % 3}.ts`,
    qualifiedName: `symbol${index}`,
    kind: 'function',
    score: 1,
    sources,
    content
  };
}

describe('Phase 2 context budget', () => {
  test('trims many results to fit a small token budget', () => {
    const result = applyContextBudget(
      Array.from({ length: 100 }, (_, index) => candidate(index, ['fts'], 'one two three four five six seven eight nine ten')),
      { maxTokens: 60 }
    );
    expect(result.usedTokens).toBeLessThanOrEqual(60);
    expect(result.includedNodeIds.length).toBeLessThan(100);
    expect(result.truncated).toBe(true);
  });

  test('prioritizes graph-confirmed candidates over fts-only candidates', () => {
    const ftsOnly = candidate(1, ['fts']);
    const graphConfirmed = candidate(2, ['graph']);
    expect(compareCandidatePriority(graphConfirmed, ftsOnly)).toBeLessThan(0);
  });



  test('strictly handles a single oversized candidate without exceeding budget', () => {
    const oversized = candidate(99, ['graph'], Array.from({ length: 200 }, (_, index) => `token${index}`).join(' '));
    const result = applyContextBudget([oversized], { maxTokens: 10 });
    expect(result.usedTokens).toBeLessThanOrEqual(10);
    expect(result.truncated).toBe(true);
  });

  test('tiered source priority keeps graph-only above vector plus fts', () => {
    const graphOnly = candidate(1, ['graph']);
    const vectorAndFts = candidate(2, ['vector', 'fts']);
    expect(compareCandidatePriority(graphOnly, vectorAndFts)).toBeLessThan(0);
  });

  test('groups same-file candidates into one context block', () => {
    const result = applyContextBudget([
      { ...candidate(1, ['graph']), filePath: 'src/auth.ts' },
      { ...candidate(2, ['vector']), filePath: 'src/auth.ts' },
      { ...candidate(3, ['fts']), filePath: 'src/other.ts' }
    ]);
    expect(result.blocks.find((block) => block.filePath === 'src/auth.ts')?.candidates).toHaveLength(2);
  });

  test('truncates long content to a compact excerpt', () => {
    const longContent = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n');
    const truncated = truncateContent(longContent, 20);
    expect(truncated.split('\n').length).toBe(21);
    expect(truncated).toContain('... truncated');
  });
});
