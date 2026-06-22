import { describe, expect, test } from 'vitest';

import {
  CacheAligner,
  createDefaultCacheAligner
} from '../../src/compression/cache-aligner.js';
import { listZincgraphTools } from '../../src/mcp/tool-registry.js';

describe('CacheAligner', () => {
  test('stabilize returns static definitions and alignment report', () => {
    const aligner = createDefaultCacheAligner();
    const tools = [
      { name: 'test_tool', description: 'A test tool', inputSchema: { type: 'object', properties: {} } },
      { name: 'another_tool', description: 'Another tool', inputSchema: { type: 'object', properties: {} } }
    ];

    const result = aligner.stabilize(tools);

    expect(result.staticDefinitions).toHaveLength(2);
    expect(result.staticDefinitions[0]?.name).toBe('test_tool');
    expect(result.alignmentReport.dynamicFieldsDetected).toBeDefined();
    expect(typeof result.alignmentReport.cacheablePrefixBytes).toBe('number');
    expect(typeof result.alignmentReport.estimatedCacheHitRate).toBe('number');
  });

  test('detects dynamic fields in descriptions', () => {
    const aligner = new CacheAligner();
    const tools = [
      {
        name: 'path_tool',
        description: 'Operates on /Users/john/project/src/file.ts files',
        inputSchema: { type: 'object', properties: {} }
      }
    ];

    const result = aligner.stabilize(tools);
    expect(result.alignmentReport.dynamicFieldsDetected.length).toBeGreaterThan(0);
    expect(result.dynamicMetadata['path_tool']).toBeDefined();
  });

  test('preserves tools without dynamic content', () => {
    const aligner = new CacheAligner();
    const tools = [
      { name: 'static_tool', description: 'A purely static description', inputSchema: { type: 'object', properties: {} } }
    ];

    const result = aligner.stabilize(tools);
    expect(result.staticDefinitions[0]?.description).toBe('A purely static description');
  });

  test('stabilizeFromZincgraphTools works with real tool registry', () => {
    const aligner = new CacheAligner();
    const tools = listZincgraphTools();

    const result = aligner.stabilizeFromZincgraphTools(tools);

    expect(result.staticDefinitions.length).toBe(tools.length);
    expect(result.alignmentReport.cacheablePrefixBytes).toBeGreaterThan(0);
    expect(result.alignmentReport.estimatedCacheHitRate).toBeGreaterThan(0);
    expect(result.alignmentReport.estimatedCacheHitRate).toBeLessThanOrEqual(1);
  });

  test('extracts timestamps and UUIDs from descriptions', () => {
    const aligner = new CacheAligner();
    const tools = [
      {
        name: 'timestamp_tool',
        description: 'Last indexed at 2026-06-22T10:00:00Z with session a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        inputSchema: { type: 'object', properties: {} }
      }
    ];

    const result = aligner.stabilize(tools);
    expect(result.alignmentReport.dynamicFieldsDetected.length).toBeGreaterThan(0);
  });
});
