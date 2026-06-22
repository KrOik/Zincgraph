import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';

import { createZincgraphToolRegistry, type ZincgraphToolDefinition, type ZincgraphToolRegistryDependencies } from './tool-registry.js';
import { CacheAligner, type CacheAlignerOptions } from '../compression/cache-aligner.js';

export interface ZincgraphMcpServerOptions extends ZincgraphToolRegistryDependencies {
  name?: string;
  version?: string;
  cacheAligner?: CacheAlignerOptions;
  disableCacheAligner?: boolean;
}

export function createZincgraphMcpServer(options: ZincgraphMcpServerOptions = {}): Server {
  const registry = createZincgraphToolRegistry(options);
  const aligner = options.disableCacheAligner ? null : new CacheAligner(options.cacheAligner);
  const server = new Server(
    { name: options.name ?? 'zincgraph', version: options.version ?? '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: 'Zincgraph exposes CodeGraph, Ponytail, and fusion tools through one MCP server.'
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, () => {
    if (aligner) {
      const stabilized = aligner.stabilizeFromZincgraphTools(registry.tools);
      return { tools: stabilized.staticDefinitions.map(toMcpTool) };
    }
    return { tools: registry.tools.map(toMcpTool) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => registry.callTool(request.params.name, request.params.arguments));
  return server;
}

export async function startZincgraphMcpServer(options: ZincgraphMcpServerOptions = {}): Promise<Server> {
  const server = createZincgraphMcpServer(options);
  await server.connect(new StdioServerTransport());
  return server;
}

function toMcpTool(tool: ZincgraphToolDefinition | { name: string; description: string; inputSchema: Record<string, unknown> }): Tool {
  const { source: _source, ...mcpTool } = tool as ZincgraphToolDefinition;
  return mcpTool;
}
