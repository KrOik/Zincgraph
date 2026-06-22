import { describe, expect, test } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { createZincgraphMcpServer } from '../../src/mcp/unified-server.js';
import { ZINCGRAPH_TOOL_NAMES, createZincgraphToolRegistry, listZincgraphTools } from '../../src/mcp/tool-registry.js';
import type { GraphReviewCommandResult } from '../../src/behavior/review-command.js';
import type { ContextCapsule } from '../../src/fusion/query-engine.js';

function resultText(result: CallToolResult): string {
  return result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
}

function capsule(query: string): ContextCapsule {
  return {
    query,
    strippedQuery: query,
    route: 'hybrid',
    filters: {},
    nodes: [],
    documents: [],
    edges: [],
    freshness: { fresh: 0, pending: 0, stale: 0, failed: 0, total: 0, isFresh: true, warnings: [], entries: [] },
    policy: { textBranch: 'fusion-store-token-overlap', nativeFts: false },
    warnings: [],
    context: { maxTokens: 8000, usedTokens: 0, blocks: [], includedNodeIds: [], droppedNodeIds: [], truncated: false }
  };
}

function graphReview(projectPath: string): GraphReviewCommandResult {
  return {
    projectPath,
    ponytail: { command: 'ponytail-review', projectPath, diff: true, prompt: 'prompt', marker: 'PONYTAIL' },
    graph: null,
    graphFindings: [],
    graphAvailable: true,
    warnings: []
  };
}

describe('Phase 4 unified MCP registry/server', () => {
  test('lists exactly the 17 Phase 5 tools', () => {
    expect(listZincgraphTools().map((tool) => tool.name)).toEqual([...ZINCGRAPH_TOOL_NAMES]);
    expect(listZincgraphTools()).toHaveLength(17);
  });

  test('creates an MCP server with unified handlers', () => {
    const server = createZincgraphMcpServer();
    expect(server).toBeTruthy();
  });

  test('delegates callers to upstream CodeGraph CLI', async () => {
    const calls: string[][] = [];
    const registry = createZincgraphToolRegistry({
      runCodeGraphCli: (args) => {
        calls.push(args);
        return { command: 'codegraph', args, status: 0, stdout: 'caller output', stderr: '' };
      }
    });
    const result = await registry.callTool('zincgraph_callers', { symbol: 'authenticateUser', project: '/repo', limit: 3, json: true });
    expect(calls[0]).toEqual(['callers', 'authenticateUser', '-p', '/repo', '--limit', '3', '--json']);
    expect(resultText(result)).toContain('caller output');
  });

  test('delegates status to upstream CodeGraph CLI with JSON by default', async () => {
    const calls: string[][] = [];
    const registry = createZincgraphToolRegistry({
      runCodeGraphCli: (args) => {
        calls.push(args);
        return { command: 'codegraph', args, status: 0, stdout: '{"initialized":true}', stderr: '' };
      }
    });
    await registry.callTool('zincgraph_status', { project: '/repo' });
    expect(calls[0]).toEqual(['status', '/repo', '--json']);
  });

  test('delegates Ponytail instructions builder', async () => {
    const registry = createZincgraphToolRegistry({ buildPonytailInstructions: async (mode) => `instructions:${mode}` });
    const result = await registry.callTool('zincgraph_ponytail_instructions', { mode: 'lite' });
    expect(resultText(result)).toBe('instructions:lite');
  });

  test('delegates graph-enhanced review command', async () => {
    const registry = createZincgraphToolRegistry({ runGraphReview: async (project) => graphReview(project) });
    const result = await registry.callTool('zincgraph_review', { project: '/repo', diff: true });
    expect(resultText(result)).toContain('PONYTAIL');
  });

  test('delegates fusion semantic search', async () => {
    const registry = createZincgraphToolRegistry({
      createFusionEngine: () => ({ query: async (query) => capsule(query), search: async (query) => capsule(query) })
    });
    const result = await registry.callTool('zincgraph_semantic_search', { project: '/repo', query: 'token validation', topk: 2 });
    expect(JSON.parse(resultText(result))).toMatchObject({ query: 'token validation' });
  });

  test('delegates semantic dedup check', async () => {
    const registry = createZincgraphToolRegistry({
      runDedup: async () => ({
        output: 'Semantic duplicate found',
        result: { description: 'format date', threshold: 0.85, matches: [], recommendation: { action: 'reuse', message: 'reuse' } }
      })
    });
    const result = await registry.callTool('zincgraph_dedup_check', { describe: 'format date' });
    expect(resultText(result)).toContain('Semantic duplicate');
  });

  test('unknown tool returns MCP error content', async () => {
    const result = await createZincgraphToolRegistry().callTool('unknown_tool');
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('Unknown Zincgraph tool');
  });
});
