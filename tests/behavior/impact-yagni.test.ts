import { describe, expect, test } from 'vitest';

import { ImpactAwareYagni, assessImpactYagni } from '../../src/behavior/impact-yagni.js';

describe('Phase 3 impact-aware YAGNI', () => {
  test('proceeds when an abstraction saves lines across three call sites', () => {
    const result = assessImpactYagni({
      name: 'formatUserDate',
      callSites: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      linesSavedPerSite: 4
    });
    expect(result.verdict).toBe('proceed');
    expect(result.callSiteCount).toBe(3);
    expect(result.estimatedSavedLines).toBe(12);
    expect(result.message).toContain('across 3 sites');
  });

  test('suggests inlining for one call site', () => {
    const result = new ImpactAwareYagni().assess({ name: 'SingleUseHelper', callSites: ['src/only.ts'] });
    expect(result.verdict).toBe('inline');
    expect(result.message).toContain('only 1 call site');
  });

  test('keeps existing code when all call sites are already simple', () => {
    const result = assessImpactYagni({
      name: 'TinyWrapper',
      callSites: [
        { filePath: 'src/a.ts', estimatedRepeatedLines: 1, complexity: 'simple' },
        { filePath: 'src/b.ts', estimatedRepeatedLines: 1, complexity: 'simple' }
      ]
    });
    expect(result.verdict).toBe('keep-existing');
  });

  test('always returns quantified evidence', () => {
    const result = assessImpactYagni({ name: 'Quantified', callSites: ['src/a.ts', 'src/b.ts'] });
    expect(result.callSiteCount).toBe(2);
    expect(result.estimatedSavedLines).toBeGreaterThan(0);
    expect(result.evidence.callSites).toHaveLength(2);
  });
});
