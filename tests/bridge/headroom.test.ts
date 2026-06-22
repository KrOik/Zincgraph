import { describe, expect, test } from 'vitest';

import {
  assessHeadroomFallback,
  compressContentLocal,
  isHeadroomPackageLoadable,
  probeHeadroom
} from '../../src/bridge/headroomAdapter.js';

describe('Headroom Phase 5 probe', () => {
  test('loads the headroom-ai package', async () => {
    await expect(isHeadroomPackageLoadable()).resolves.toBe(true);
  });

  test('runs probe and returns valid scenario', async () => {
    const result = await probeHeadroom();

    expect(result.packageAvailable).toBe(true);
    expect(result.exports.length).toBeGreaterThan(0);
    expect(['A:npm-sdk', 'B:proxy-http', 'C:python-cli']).toContain(result.scenario);
  });

  test('exports include compress function', async () => {
    const result = await probeHeadroom();
    expect(result.exports).toContain('compress');
  });

  test('exports include HeadroomClient', async () => {
    const result = await probeHeadroom();
    expect(result.exports).toContain('HeadroomClient');
  });

  test('fallback assessment returns valid structure', () => {
    const assessment = assessHeadroomFallback();

    expect(assessment.proxyEndpoint).toContain('/v1/');
    expect(typeof assessment.pythonCliAvailable).toBe('boolean');
    expect(assessment.risks.length).toBeGreaterThan(0);
  });
});

describe('Local content compression', () => {
  test('compresses code content', async () => {
    const code = `
export function authenticateUser(username: string, password: string): boolean {
  const hash = await bcrypt.hash(password, 10);
  const user = await db.findUser(username);
  if (!user) return false;
  return bcrypt.compare(password, user.passwordHash);
}
`.repeat(10);

    const result = await compressContentLocal(code, 'code', 20);
    expect(result.tokensBefore).toBeGreaterThan(result.tokensAfter);
    expect(result.hash).toBeTruthy();
    expect(result.hash.length).toBe(16);
  });

  test('compresses JSON content', async () => {
    const jsonContent = JSON.stringify({
      items: Array.from({ length: 50 }, (_, i) => ({
        id: i,
        name: `item-${i}`,
        description: `Description for item ${i}`,
        metadata: { tags: ['a', 'b', 'c'] }
      }))
    });

    const result = await compressContentLocal(jsonContent, 'json', 20);
    expect(result.tokensAfter).toBeLessThanOrEqual(result.tokensBefore);
    expect(result.hash).toBeTruthy();
  });

  test('compresses text content', async () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(100);
    const result = await compressContentLocal(text, 'text', 20);
    expect(result.tokensAfter).toBeLessThanOrEqual(25);
    expect(result.compressed).toContain('... [compressed]');
  });

  test('auto-detects content type', async () => {
    const jsonResult = await compressContentLocal('{"key": "value", "items": [1,2,3]}', 'auto', 5);
    expect(jsonResult.hash).toBeTruthy();

    const codeResult = await compressContentLocal('export function foo() { return 42; }', 'auto', 100);
    expect(codeResult.hash).toBeTruthy();
  });

  test('returns unchanged content when within budget', async () => {
    const short = 'Hello world';
    const result = await compressContentLocal(short, 'text', 1000);
    expect(result.compressed).toBe(short);
    expect(result.tokensBefore).toBe(result.tokensAfter);
  });
});
