import { describe, expect, test } from 'vitest';

import { parseFusionQuery, routeQuery } from '../../src/fusion/intent-router.js';

describe('Phase 2 intent router', () => {
  test('routes camelCase symbol queries graph-first', () => {
    expect(routeQuery('authenticateUser')).toBe('graph-first');
  });

  test('routes natural language queries hybrid', () => {
    expect(routeQuery('how does auth work')).toBe('hybrid');
  });

  test('routes path-limited queries graph-first-filter', () => {
    expect(routeQuery('path:src/api authenticate')).toBe('graph-first-filter');
  });

  test('routes bare path-heavy queries graph-first-filter', () => {
    expect(routeQuery('src/fusion/intent-router.ts parseFusionQuery')).toBe('graph-first-filter');
  });

  test('keeps graph-navigation hints ahead of bare path-heavy detection', () => {
    expect(routeQuery('src/fusion/intent-router.ts flow')).toBe('hybrid');
  });

  test('routes exact symbol bundles graph-first', () => {
    const parsed = parseFusionQuery('SourceCouchbase test_streams test_check_connection test_get_cluster');
    expect(parsed.intent).toBe('exact-symbol');
    expect(parsed.route).toBe('graph-first');
  });

  test('routes anchor-dense mixed bundles graph-first', () => {
    const parsed = parseFusionQuery('TwilioUsageRecordsStateMigration usage_records test_usage_records_404_handling test_streams TwilioStateMigration');
    expect(parsed.intent).toBe('exact-symbol');
    expect(parsed.route).toBe('graph-first');
  });

  test('routes semantic similarity queries vector-first', () => {
    expect(routeQuery('similar to token validation')).toBe('vector-first');
  });

  test('routes priority ordering queries vector-first after semantic expansion', () => {
    expect(routeQuery('which code decides priority ordering when search results are mixed from multiple sources')).toBe('vector-first');
  });

  test('parses scalar filters and strips them from free text', () => {
    const parsed = parseFusionQuery('kind:function lang:typescript path:src/api name:auth token validation');
    expect(parsed.filters).toEqual({
      kind: 'function',
      language: 'typescript',
      path: 'src/api',
      name: 'auth'
    });
    expect(parsed.text).toBe('token validation');
    expect(parsed.route).toBe('graph-first-filter');
  });

  test('normalizes file and language aliases', () => {
    const parsed = parseFusionQuery('language:typescript file:src/auth.ts validateToken');
    expect(parsed.filters.language).toBe('typescript');
    expect(parsed.filters.file).toBe('src/auth.ts');
    expect(parsed.text).toBe('validateToken');
  });
});
