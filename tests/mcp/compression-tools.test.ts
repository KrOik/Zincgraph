import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createZincgraphToolRegistry, listZincgraphTools } from '../../src/mcp/tool-registry.js';
import { FeedbackStore } from '../../src/compression/feedback-store.js';

describe('MCP compression tools', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'zincgraph-mcp-ccr-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

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
    expect(schema.properties.project).toBeDefined();
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
    expect(schema.properties.project).toBeDefined();
  });

  test('zincgraph_compression_stats tool is defined', () => {
    const tools = listZincgraphTools();
    const statsTool = tools.find((t) => t.name === 'zincgraph_compression_stats');

    expect(statsTool).toBeDefined();
    expect(statsTool?.source).toBe('fusion');
    expect(statsTool?.description).toContain('compression statistics');
    const schema = statsTool?.inputSchema as { properties: Record<string, unknown> };
    expect(schema.properties.project).toBeDefined();
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

  test('callTool zincgraph_compress records a compression feedback event', async () => {
    const feedbackStore = new FeedbackStore({ projectPath: tempDir });
    const registry = createZincgraphToolRegistry({
      feedbackStore,
      projectPathResolver: () => tempDir,
      compressContent: async () => ({
        compressed: '{"apiKey":"sk-secret-123"}',
        tokensBefore: 10,
        tokensAfter: 4,
        hash: 'hash-feedback'
      })
    });

    const result = await registry.callTool('zincgraph_compress', {
      project: tempDir,
      content: '{"apiKey":"sk-secret-123"}',
      content_type: 'json',
      max_tokens: 20
    });

    expect(result.isError).toBeUndefined();
    const events = feedbackStore.listCompressionEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.hash).toBe('hash-feedback');
    expect(events[0]?.contentType).toBe('json');
  });

  test('callTool zincgraph_retrieve uses the default project CcrStore', async () => {
    const registry = createZincgraphToolRegistry({ projectPathResolver: () => tempDir });
    const compressResult = await registry.callTool('zincgraph_compress', {
      content: 'original content',
      content_type: 'text',
      max_tokens: 20
    });
    const compressed = JSON.parse((compressResult.content[0] as { text: string }).text) as { hash: string };
    const result = await registry.callTool('zincgraph_retrieve', { hash: compressed.hash });

    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toBe('original content');
  });

  test('callTool zincgraph_retrieve prefers the explicit project over projectPathResolver', async () => {
    const explicitProject = mkdtempSync(join(tmpdir(), 'zincgraph-mcp-explicit-'));
    try {
      const registry = createZincgraphToolRegistry({ projectPathResolver: () => tempDir });
      const compressResult = await registry.callTool('zincgraph_compress', {
        project: explicitProject,
        content: 'explicit project content',
        content_type: 'text',
        max_tokens: 20
      });
      const compressed = JSON.parse((compressResult.content[0] as { text: string }).text) as { hash: string };
      const result = await registry.callTool('zincgraph_retrieve', { project: explicitProject, hash: compressed.hash });

      expect(result.isError).toBeUndefined();
      expect((result.content[0] as { text: string }).text).toBe('explicit project content');
    } finally {
      rmSync(explicitProject, { recursive: true, force: true });
    }
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
