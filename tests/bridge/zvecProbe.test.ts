import { describe, expect, test } from 'vitest';

import {
  assessZvecNativeWrapper,
  isZvecPackageLoadable,
  probeZvec
} from '../../src/bridge/zvecAdapter.js';

describe('Zvec Phase 0 probe', () => {
  test('loads the @zvec/zvec package when install succeeded', async () => {
    await expect(isZvecPackageLoadable()).resolves.toBe(true);
  });

  test('runs a safe initialization probe', async () => {
    const result = await probeZvec();

    expect(result.packageAvailable).toBe(true);
    expect(result.exports.length).toBeGreaterThan(0);
    expect(['A:npm-binding', 'B:napi-wrapper-required']).toContain(result.scenario);
  });

  test('records C API fallback assessment for Scenario B', () => {
    const assessment = assessZvecNativeWrapper();

    expect(assessment.available).toBe(true);
    expect(assessment.cApiHeader.replaceAll('\\', '/')).toContain('refer/zvec/src/include/zvec/c_api.h');
    expect(assessment.estimatedEffort).toBe('2+ weeks');
    expect(assessment.requiredExports).toContain('zvec_initialize');
  });
});
