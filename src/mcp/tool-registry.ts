import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import { runCodeGraphCli as defaultRunCodeGraphCli, type CodeGraphCliResult } from '../bridge/codegraphAdapter.js';
import {
  buildPonytailInstructions as defaultBuildPonytailInstructions,
  type PonytailMode
} from '../bridge/ponytailAdapter.js';
import {
  formatGraphReviewCommandResult,
  runGraphReviewCommand as defaultRunGraphReviewCommand,
  type GraphReviewCommandOptions,
  type GraphReviewCommandResult
} from '../behavior/review-command.js';
import { runDedupCommand as defaultRunDedupCommand, type DedupCommandResult } from '../behavior/dedup-command.js';
import { TopoSemanticQueryEngine, type ContextCapsule } from '../fusion/query-engine.js';
import type { CompressionStats } from '../compression/fusion-compressor.js';
import { compressContentLocal } from '../bridge/headroomAdapter.js';

export type ZincgraphToolSource = 'codegraph' | 'ponytail' | 'fusion';
export type ToolArguments = Record<string, unknown>;

export interface ZincgraphToolDefinition extends Tool {
  source: ZincgraphToolSource;
}

export interface ZincgraphToolRegistryDependencies {
  runCodeGraphCli?: (args: string[], cwd?: string) => CodeGraphCliResult;
  buildPonytailInstructions?: (mode?: PonytailMode) => Promise<string>;
  runGraphReview?: (projectPath: string, options?: GraphReviewCommandOptions) => Promise<GraphReviewCommandResult> | GraphReviewCommandResult;
  createFusionEngine?: (projectPath: string) => Pick<TopoSemanticQueryEngine, 'query' | 'search'>;
  runDedup?: (options: { projectPath?: string; describe: string; threshold?: number; topk?: number }) => Promise<DedupCommandResult> | DedupCommandResult;
  compressContent?: (content: string, contentType: string, maxTokens: number) => Promise<{ compressed: string; tokensBefore: number; tokensAfter: number; hash: string }>;
  retrieveContent?: (hash: string, query?: string) => Promise<string | null>;
  getCompressionStats?: () => CompressionStats;
}

export interface ZincgraphToolRegistry {
  tools: ZincgraphToolDefinition[];
  callTool(name: string, args?: ToolArguments): Promise<CallToolResult>;
}

const PROJECT_PROPERTY = { type: 'string', description: 'Project path. Defaults to the current working directory.' } as const;
const QUERY_PROPERTY = { type: 'string', description: 'Search/query text.' } as const;
const SYMBOL_PROPERTY = { type: 'string', description: 'Symbol name.' } as const;
const TOPK_PROPERTY = { type: 'number', description: 'Maximum result count.' } as const;
const JSON_PROPERTY = { type: 'boolean', description: 'Request JSON output from the upstream command when supported.' } as const;

export const ZINCGRAPH_TOOL_NAMES = [
  'zincgraph_explore',
  'zincgraph_search',
  'zincgraph_node',
  'zincgraph_callers',
  'zincgraph_callees',
  'zincgraph_impact',
  'zincgraph_affected',
  'zincgraph_status',
  'zincgraph_ponytail_instructions',
  'zincgraph_review',
  'zincgraph_audit',
  'zincgraph_debt',
  'zincgraph_semantic_search',
  'zincgraph_dedup_check',
  'zincgraph_compress',
  'zincgraph_retrieve',
  'zincgraph_compression_stats'
] as const;

export type ZincgraphToolName = (typeof ZINCGRAPH_TOOL_NAMES)[number];

export function listZincgraphTools(): ZincgraphToolDefinition[] {
  return [
    codeGraphTool('zincgraph_explore', 'Explore code with upstream CodeGraph source/call-path context.', {
      query: QUERY_PROPERTY,
      project: PROJECT_PROPERTY,
      maxFiles: { type: 'number', description: 'Maximum files of source context.' }
    }, ['query']),
    codeGraphTool('zincgraph_search', 'Search CodeGraph symbols using upstream query semantics.', {
      query: QUERY_PROPERTY,
      project: PROJECT_PROPERTY,
      kind: { type: 'string', description: 'Optional symbol kind filter.' },
      limit: TOPK_PROPERTY,
      json: JSON_PROPERTY
    }, ['query']),
    codeGraphTool('zincgraph_node', 'Read one symbol/file via upstream CodeGraph node view.', {
      name: SYMBOL_PROPERTY,
      project: PROJECT_PROPERTY,
      file: { type: 'string', description: 'Optional file disambiguator or file-mode path.' },
      offset: { type: 'number' },
      limit: TOPK_PROPERTY,
      symbolsOnly: { type: 'boolean' }
    }, ['name']),
    codeGraphTool('zincgraph_callers', 'List callers of a symbol through upstream CodeGraph.', {
      symbol: SYMBOL_PROPERTY,
      project: PROJECT_PROPERTY,
      limit: TOPK_PROPERTY,
      json: JSON_PROPERTY
    }, ['symbol']),
    codeGraphTool('zincgraph_callees', 'List callees of a symbol through upstream CodeGraph.', {
      symbol: SYMBOL_PROPERTY,
      project: PROJECT_PROPERTY,
      limit: TOPK_PROPERTY,
      json: JSON_PROPERTY
    }, ['symbol']),
    codeGraphTool('zincgraph_impact', 'Analyze impact radius through upstream CodeGraph.', {
      symbol: SYMBOL_PROPERTY,
      project: PROJECT_PROPERTY,
      depth: { type: 'number', description: 'Traversal depth.' },
      json: JSON_PROPERTY
    }, ['symbol']),
    codeGraphTool('zincgraph_affected', 'Recommend affected tests through upstream CodeGraph.', {
      files: { type: 'array', items: { type: 'string' }, description: 'Changed source files.' },
      project: PROJECT_PROPERTY,
      depth: { type: 'number', description: 'Traversal depth.' },
      filter: { type: 'string', description: 'Optional test glob filter.' },
      json: JSON_PROPERTY,
      quiet: { type: 'boolean' }
    }),
    codeGraphTool('zincgraph_status', 'Return upstream CodeGraph status.', {
      project: PROJECT_PROPERTY,
      json: JSON_PROPERTY
    }),
    ponytailTool('zincgraph_ponytail_instructions', 'Return Ponytail behavior instructions.', {
      mode: { type: 'string', enum: ['off', 'lite', 'full', 'ultra'], description: 'Instruction mode.' }
    }),
    ponytailTool('zincgraph_review', 'Run graph-enhanced Ponytail review.', {
      project: PROJECT_PROPERTY,
      diff: { type: 'boolean', description: 'Review current diff.' }
    }),
    ponytailTool('zincgraph_audit', 'Run graph-enhanced Ponytail audit.', {
      project: PROJECT_PROPERTY
    }),
    ponytailTool('zincgraph_debt', 'Run graph-enhanced technical-debt audit.', {
      project: PROJECT_PROPERTY
    }),
    fusionTool('zincgraph_semantic_search', 'Run Zincgraph fusion semantic search.', {
      query: QUERY_PROPERTY,
      project: PROJECT_PROPERTY,
      topk: TOPK_PROPERTY,
      maxTokens: { type: 'number', description: 'Context token budget.' }
    }, ['query']),
    fusionTool('zincgraph_dedup_check', 'Check whether proposed behavior duplicates existing code semantically.', {
      describe: { type: 'string', description: 'Behavior/functionality to add.' },
      project: PROJECT_PROPERTY,
      threshold: { type: 'number', description: 'Similarity threshold between 0 and 1.' },
      topk: TOPK_PROPERTY
    }, ['describe']),
    fusionTool('zincgraph_compress', 'Compress content to reduce token usage. Returns compressed content with a retrieval hash.', {
      content: { type: 'string', description: 'Content to compress.' },
      content_type: { type: 'string', enum: ['code', 'json', 'text', 'auto'], description: 'Content type for strategy selection (default: auto).' },
      max_tokens: { type: 'number', description: 'Target token budget (default: 2000).' }
    }, ['content']),
    fusionTool('zincgraph_retrieve', 'Retrieve original uncompressed content by hash.', {
      hash: { type: 'string', description: 'CCR hash from a previous compress operation.' },
      query: { type: 'string', description: 'Optional search query for BM25-based retrieval.' }
    }),
    fusionTool('zincgraph_compression_stats', 'Get compression statistics for the current session.', {})
  ];
}

export function createZincgraphToolRegistry(
  dependencies: ZincgraphToolRegistryDependencies = {}
): ZincgraphToolRegistry {
  const runCodeGraphCli = dependencies.runCodeGraphCli ?? defaultRunCodeGraphCli;
  const buildPonytailInstructions = dependencies.buildPonytailInstructions ?? defaultBuildPonytailInstructions;
  const runGraphReview = dependencies.runGraphReview ?? defaultRunGraphReviewCommand;
  const runDedup = dependencies.runDedup ?? defaultRunDedupCommand;
  const createFusionEngine = dependencies.createFusionEngine ?? ((projectPath: string) => new TopoSemanticQueryEngine(projectPath));
  const tools = listZincgraphTools();
  const toolNames = new Set<string>(tools.map((tool) => tool.name));

  return {
    tools,
    async callTool(name: string, args: ToolArguments = {}): Promise<CallToolResult> {
      if (!toolNames.has(name)) {
        return textResult(`Unknown Zincgraph tool: ${name}`, true);
      }

      try {
        switch (name as ZincgraphToolName) {
          case 'zincgraph_explore':
            return cliResult(runCodeGraphCli(codeGraphExploreArgs(args)));
          case 'zincgraph_search':
            return cliResult(runCodeGraphCli(codeGraphSearchArgs(args)));
          case 'zincgraph_node':
            return cliResult(runCodeGraphCli(codeGraphNodeArgs(args)));
          case 'zincgraph_callers':
            return cliResult(runCodeGraphCli(symbolArgs('callers', args)));
          case 'zincgraph_callees':
            return cliResult(runCodeGraphCli(symbolArgs('callees', args)));
          case 'zincgraph_impact':
            return cliResult(runCodeGraphCli(impactArgs(args)));
          case 'zincgraph_affected':
            return cliResult(runCodeGraphCli(affectedArgs(args)));
          case 'zincgraph_status':
            return cliResult(runCodeGraphCli(statusArgs(args)));
          case 'zincgraph_ponytail_instructions': {
            const mode = optionalString(args.mode) as PonytailMode | undefined;
            return textResult(await buildPonytailInstructions(mode ?? 'full'));
          }
          case 'zincgraph_review':
            return graphReviewResult(await runGraphReview(projectArg(args), reviewOptions(args, true)));
          case 'zincgraph_audit':
            return graphReviewResult(await runGraphReview(projectArg(args), reviewOptions(args, false)));
          case 'zincgraph_debt':
            return graphReviewResult(await runGraphReview(projectArg(args), reviewOptions(args, false)), 'Zincgraph technical debt audit');
          case 'zincgraph_semantic_search': {
            const engine = createFusionEngine(projectArg(args));
            const result = await engine.search(requiredString(args, 'query'), fusionOptions(args));
            return jsonResult(result);
          }
          case 'zincgraph_dedup_check': {
            const dedupOptions: { projectPath?: string; describe: string; threshold?: number; topk?: number } = {
              projectPath: projectArg(args),
              describe: requiredString(args, 'describe')
            };
            const threshold = optionalNumber(args.threshold);
            const topk = optionalNumber(args.topk);
            if (threshold !== undefined) {
              dedupOptions.threshold = threshold;
            }
            if (topk !== undefined) {
              dedupOptions.topk = topk;
            }
            const result = await runDedup(dedupOptions);
            return textResult(result.output);
          }
          case 'zincgraph_compress': {
            const content = requiredString(args, 'content');
            const contentType = optionalString(args.content_type) ?? 'auto';
            const maxTokens = optionalNumber(args.max_tokens) ?? 2000;
            const compressFn = dependencies.compressContent ?? ((c: string, ct: string, mt: number) => compressContentLocal(c, ct as 'code' | 'json' | 'text' | 'auto', mt));
            const compressionResult = await compressFn(content, contentType, maxTokens);
            return jsonResultRaw(compressionResult);
          }
          case 'zincgraph_retrieve': {
            const hash = optionalString(args.hash);
            const query = optionalString(args.query);
            if (!hash && !query) {
              throw new Error('Either hash or query must be provided.');
            }
            const retrieveFn = dependencies.retrieveContent;
            if (!retrieveFn) {
              return textResult('Content retrieval is not configured. Provide a retrieveContent dependency.', true);
            }
            const retrieved = await retrieveFn(hash ?? '', query);
            if (retrieved === null) {
              return textResult('No content found for the given hash or query.', true);
            }
            return textResult(retrieved);
          }
          case 'zincgraph_compression_stats': {
            const statsFn = dependencies.getCompressionStats;
            if (!statsFn) {
              return textResult('Compression stats are not available. Provide a getCompressionStats dependency.', true);
            }
            return jsonResultRaw(statsFn());
          }
        }
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error), true);
      }
    }
  };
}

function codeGraphTool(
  name: ZincgraphToolName,
  description: string,
  properties: Record<string, object>,
  required: string[] = []
): ZincgraphToolDefinition {
  return baseTool(name, 'codegraph', description, properties, required);
}

function ponytailTool(
  name: ZincgraphToolName,
  description: string,
  properties: Record<string, object>,
  required: string[] = []
): ZincgraphToolDefinition {
  return baseTool(name, 'ponytail', description, properties, required);
}

function fusionTool(
  name: ZincgraphToolName,
  description: string,
  properties: Record<string, object>,
  required: string[] = []
): ZincgraphToolDefinition {
  return baseTool(name, 'fusion', description, properties, required);
}

function baseTool(
  name: ZincgraphToolName,
  source: ZincgraphToolSource,
  description: string,
  properties: Record<string, object>,
  required: string[]
): ZincgraphToolDefinition {
  return {
    name,
    source,
    description,
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {})
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  };
}

function codeGraphExploreArgs(args: ToolArguments): string[] {
  const cliArgs = ['explore', requiredString(args, 'query')];
  pushProjectOption(cliArgs, args);
  pushNumberOption(cliArgs, '--max-files', args.maxFiles);
  return cliArgs;
}

function codeGraphSearchArgs(args: ToolArguments): string[] {
  const cliArgs = ['query', requiredString(args, 'query')];
  pushProjectOption(cliArgs, args);
  pushNumberOption(cliArgs, '--limit', args.limit);
  pushStringOption(cliArgs, '--kind', args.kind);
  pushBooleanFlag(cliArgs, '--json', args.json);
  return cliArgs;
}

function codeGraphNodeArgs(args: ToolArguments): string[] {
  const cliArgs = ['node', requiredString(args, 'name')];
  pushProjectOption(cliArgs, args);
  pushStringOption(cliArgs, '--file', args.file);
  pushNumberOption(cliArgs, '--offset', args.offset);
  pushNumberOption(cliArgs, '--limit', args.limit);
  pushBooleanFlag(cliArgs, '--symbols-only', args.symbolsOnly);
  return cliArgs;
}

function symbolArgs(command: 'callers' | 'callees', args: ToolArguments): string[] {
  const cliArgs = [command, requiredString(args, 'symbol')];
  pushProjectOption(cliArgs, args);
  pushNumberOption(cliArgs, '--limit', args.limit);
  pushBooleanFlag(cliArgs, '--json', args.json);
  return cliArgs;
}

function impactArgs(args: ToolArguments): string[] {
  const cliArgs = ['impact', requiredString(args, 'symbol')];
  pushProjectOption(cliArgs, args);
  pushNumberOption(cliArgs, '--depth', args.depth);
  pushBooleanFlag(cliArgs, '--json', args.json);
  return cliArgs;
}

function affectedArgs(args: ToolArguments): string[] {
  const files = Array.isArray(args.files) ? args.files.map(String) : [];
  const cliArgs = ['affected', ...files];
  pushProjectOption(cliArgs, args);
  pushNumberOption(cliArgs, '--depth', args.depth);
  pushStringOption(cliArgs, '--filter', args.filter);
  pushBooleanFlag(cliArgs, '--json', args.json);
  pushBooleanFlag(cliArgs, '--quiet', args.quiet);
  return cliArgs;
}

function statusArgs(args: ToolArguments): string[] {
  const project = projectArg(args);
  const cliArgs = ['status', project];
  pushBooleanFlag(cliArgs, '--json', args.json ?? true);
  return cliArgs;
}

function reviewOptions(args: ToolArguments, defaultDiff: boolean): GraphReviewCommandOptions {
  const diff = typeof args.diff === 'boolean' ? args.diff : defaultDiff;
  return { diff };
}

function fusionOptions(args: ToolArguments): { topk?: number; maxTokens?: number } {
  const options: { topk?: number; maxTokens?: number } = {};
  const topk = optionalNumber(args.topk);
  const maxTokens = optionalNumber(args.maxTokens);
  if (topk !== undefined) {
    options.topk = topk;
  }
  if (maxTokens !== undefined) {
    options.maxTokens = maxTokens;
  }
  return options;
}

function graphReviewResult(result: GraphReviewCommandResult, heading?: string): CallToolResult {
  const lines = formatGraphReviewCommandResult(result);
  return textResult(heading ? [heading, ...lines].join('\n') : lines.join('\n'));
}

function cliResult(result: CodeGraphCliResult): CallToolResult {
  const body = JSON.stringify({
    command: result.command,
    args: result.args,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  }, null, 2);
  return textResult(body, result.status !== 0);
}

function jsonResult(value: ContextCapsule): CallToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

function jsonResultRaw(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

function textResult(text: string, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {})
  };
}

function projectArg(args: ToolArguments): string {
  return optionalString(args.project) ?? process.cwd();
}

function requiredString(args: ToolArguments, key: string): string {
  const value = optionalString(args[key]);
  if (!value) {
    throw new Error(`Missing required argument: ${key}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function pushProjectOption(args: string[], input: ToolArguments): void {
  args.push('-p', projectArg(input));
}

function pushStringOption(args: string[], flag: string, value: unknown): void {
  const normalized = optionalString(value);
  if (normalized !== undefined) {
    args.push(flag, normalized);
  }
}

function pushNumberOption(args: string[], flag: string, value: unknown): void {
  const normalized = optionalNumber(value);
  if (normalized !== undefined) {
    args.push(flag, String(normalized));
  }
}

function pushBooleanFlag(args: string[], flag: string, value: unknown): void {
  if (value === true) {
    args.push(flag);
  }
}
