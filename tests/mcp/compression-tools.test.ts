import { describe, expect, test } from 'vitest';

import { createZincgraphToolRegistry, listZincgraphTools } from '../../src/mcp/tool-registry.js';

describe('MCP compression tools', () => {
  test('tool list includes 17 tools (14 original + 3 compression)', () => {
    const tools = listZincgraphTools();
    expect(tools).toHaveLength(17);
  });

  test('zincgraph_compress tool is defined with correct schema', () => {
    const tools = listZincgraphTools();
    const compressTool = tools.find((t) => t.name === 'zincgraph_compress');

    expect(compressTool).toBeDefined();
    expect(compressTool?.source).toBe('fusion');
    expect(compressTool?.description).toContain('Compress content');
    const schema = compressTool?.inputSchema as { properties: Record<string, unknown>; required?: string[] };
    expect(schema.properties.content).toBeDefined();
    expect(schema.properties.content_type).toBeDefined();
    expect(schema.properties.max_tokens).toBeDefined();
    expect(schema.required).toContain('content');
  });

  test('zincgraph_retrieve tool is defined with correct schema', () => {
    const tools = listZincgraphTools();
    const retrieveTool = tools.find((t) => t.name === 'zincgraph_retrieve');

    expect(retrieveTool).toBeDefined();
    expect(retrieveTool?.source).toBe('fusion');
    expect(retrieveTool?.description).toContain('Retrieve original');
    const schema = retrieveTool?.inputSchema as { properties: Record<string, unknown> };
    expect(schema.properties.hash).toBeDefined();
    expect(schema.properties.query).toBeDefined();
  });

  test('zincgraph_compression_stats tool is defined', () => {
    const tools = listZincgraphTools();
    const statsTool = tools.find((t) => t.name === 'zincgraph_compression_stats');

    expect(statsTool).toBeDefined();
    expect(statsTool?.source).toBe('fusion');
    expect(statsTool?.description).toContain('compression statistics');
  });

  test('callTool zincgraph_compress compresses content', async () => {
    const registry = createZincgraphToolRegistry();
    const result = await registry.callTool('zincgraph_compress', {
      content: 'function bigFunction() {\n' + '  process(data);\n'.repeat(100) + '}',
      content_type: 'code',
      max_tokens: 20
    });

    expect(result.content).toHaveLength(1);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.hash).toBeTruthy();
    expect(parsed.tokensBefore).toBeGreaterThan(0);
  });

  test('callTool zincgraph_compress with auto content type', async () => {
    const registry = createZincgraphToolRegistry();
    const result = await registry.callTool('zincgraph_compress', {
      content: '{"items": ' + JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ id: i, name: `item-${i}` }))) + '}',
      content_type: 'auto',
      max_tokens: 30
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.hash).toBeTruthy();
  });

  test('callTool zincgraph_retrieve without dependencies returns error', async () => {
    const registry = createZincgraphToolRegistry();
    const result = await registry.callTool('zincgraph_retrieve', { hash: 'abc123' });

    expect(result.isError).toBe(true);
  });

  test('callTool zincgraph_compression_stats without dependencies returns error', async () => {
    const registry = createZincgraphToolRegistry();
    const result = await registry.callTool('zincgraph_compression_stats', {});

    expect(result.isError).toBe(true);
  });

  test('callTool zincgraph_retrieve with injected dependency', async () => {
    const mockRetrieve = async (hash: string) => {
      if (hash === 'test-hash') {
        return 'original content for test';
      }
      return null;
    };

    const registry = createZincgraphToolRegistry({ retrieveContent: mockRetrieve });
    const result = await registry.callTool('zincgraph_retrieve', { hash: 'test-hash' });

    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toBe('original content for test');
  });

  test('callTool zincgraph_compression_stats with injected dependency', async () => {
    const mockStats = () => ({
      totalCompressions: 5,
      totalTokensBefore: 10000,
      totalTokensAfter: 4000,
      totalTokensSaved: 6000,
      averageCompressionRatio: 0.6,
      retrievalCount: 3
    });

    const registry = createZincgraphToolRegistry({ getCompressionStats: mockStats });
    const result = await registry.callTool('zincgraph_compression_stats', {});

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.totalTokensSaved).toBe(6000);
    expect(parsed.averageCompressionRatio).toBe(0.6);
  });
});
