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
import { CcrStore } from '../compression/ccr-store.js';
import { createProjectFusionCompressor } from '../compression/fusion-compressor.js';
import { TopoSemanticQueryEngine, type ContextCapsule } from '../fusion/query-engine.js';
import { summarizeContextCapsule } from '../fusion/context-summary.js';
import type { CompressionStats } from '../compression/fusion-compressor.js';
import { compressContentLocal } from '../bridge/headroomAdapter.js';
import { CompressionFeedbackLoop, recordRetrievalFeedback } from '../compression/feedback-loop.js';
import { FeedbackStore } from '../compression/feedback-store.js';
import { createFeedbackAwarePolicy, type DynamicFusionPolicy } from '../compression/ranking-adjuster.js';

const feedbackStoreCache = new Map<string, FeedbackStore>();
const ccrStoreCache = new Map<string, CcrStore>();

export type ZincgraphToolSource = 'codegraph' | 'ponytail' | 'fusion';
export type ToolArguments = Record<string, unknown>;

export interface ZincgraphToolDefinition extends Tool {
  source: ZincgraphToolSource;
}

export interface ZincgraphToolRegistryDependencies {
  runCodeGraphCli?: (args: string[], cwd?: string) => CodeGraphCliResult;
  buildPonytailInstructions?: (mode?: PonytailMode) => Promise<string>;
  runGraphReview?: (projectPath: string, options?: GraphReviewCommandOptions) => Promise<GraphReviewCommandResult> | GraphReviewCommandResult;
  createFusionEngine?: (projectPath: string) => FusionEngineLike;
  runDedup?: (options: { projectPath?: string; describe: string; threshold?: number; topk?: number }) => Promise<DedupCommandResult> | DedupCommandResult;
  compressContent?: (content: string, contentType: string, maxTokens: number) => Promise<{ compressed: string; tokensBefore: number; tokensAfter: number; hash: string }>;
  retrieveContent?: (hash: string, query?: string) => Promise<string | null>;
  getCompressionStats?: () => CompressionStats;
  feedbackLoop?: CompressionFeedbackLoop;
  feedbackStore?: FeedbackStore;
  projectPathResolver?: () => string;
}

export interface ZincgraphToolRegistry {
  tools: ZincgraphToolDefinition[];
  callTool(name: string, args?: ToolArguments): Promise<CallToolResult>;
  close(): void;
}

export interface FusionEngineLike {
  query(query: string, options?: { topk?: number; maxTokens?: number }): Promise<ContextCapsule>;
  search(query: string, options?: { topk?: number; maxTokens?: number }): Promise<ContextCapsule>;
  setDynamicPolicy?(policy: DynamicFusionPolicy | undefined): void;
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
      maxTokens: { type: 'number', description: 'Context token budget.' },
      full: { type: 'boolean', description: 'Return the full ContextCapsule instead of the compact summary.' }
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
      max_tokens: { type: 'number', description: 'Target token budget (default: 2000).' },
      project: PROJECT_PROPERTY
    }, ['content']),
    fusionTool('zincgraph_retrieve', 'Retrieve original uncompressed content by hash.', {
      hash: { type: 'string', description: 'CCR hash from a previous compress operation.' },
      query: { type: 'string', description: 'Optional search query for BM25-based retrieval.' },
      project: PROJECT_PROPERTY
    }),
    fusionTool('zincgraph_compression_stats', 'Get compression statistics for the current session.', {
      project: PROJECT_PROPERTY
    })
  ];
}

export function createZincgraphToolRegistry(
  dependencies: ZincgraphToolRegistryDependencies = {}
): ZincgraphToolRegistry {
  const runCodeGraphCli = dependencies.runCodeGraphCli ?? defaultRunCodeGraphCli;
  const buildPonytailInstructions = dependencies.buildPonytailInstructions ?? defaultBuildPonytailInstructions;
  const runGraphReview = dependencies.runGraphReview ?? defaultRunGraphReviewCommand;
  const runDedup = dependencies.runDedup ?? defaultRunDedupCommand;
  const createFusionEngine = dependencies.createFusionEngine ?? ((projectPath: string) =>
    createFeedbackAwareQueryEngine(projectPath));
  const hasCustomFusionEngine = dependencies.createFusionEngine !== undefined;
  const tools = listZincgraphTools();
  const toolNames = new Set<string>(tools.map((tool) => tool.name));

  async function dispatchTool(name: string, args: ToolArguments = {}): Promise<CallToolResult> {
    if (!toolNames.has(name)) {
      return textResult(`Unknown Zincgraph tool: ${name}`, true);
    }

    const projectPath = projectArg(args);

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
          return graphReviewResult(
            await runGraphReview(projectPath, reviewOptions(args, true, resolveFeedbackLoop(dependencies, projectPath)))
          );
        case 'zincgraph_audit':
          return graphReviewResult(
            await runGraphReview(projectPath, reviewOptions(args, false, resolveFeedbackLoop(dependencies, projectPath)))
          );
        case 'zincgraph_debt':
          return graphReviewResult(
            await runGraphReview(projectPath, reviewOptions(args, false, resolveFeedbackLoop(dependencies, projectPath))),
            'Zincgraph technical debt audit'
          );
        case 'zincgraph_semantic_search': {
          const engine = createFusionEngine(projectPath);
          if (hasCustomFusionEngine) {
            applyFeedbackAwarePolicy(engine, projectPath);
          }
          const result = await engine.search(requiredString(args, 'query'), fusionOptions(args));
          return jsonResult(args.full === true ? result : summarizeContextCapsule(result));
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
          ccrStoreForProject(projectPath).put(
            compressionResult.hash,
            content,
            normalizeCcrContentType(contentType, content)
          );
          resolveFeedbackLoop(dependencies, projectPath).recordCompression({
            hash: compressionResult.hash,
            nodeId: compressionResult.hash,
            source: 'graph',
            contentType: normalizeCcrContentType(contentType, content),
            kind: normalizeCcrContentType(contentType, content),
            compressedAt: Date.now()
          });
          return jsonResultRaw(compressionResult);
        }
        case 'zincgraph_retrieve': {
          const hash = optionalString(args.hash);
          const query = optionalString(args.query);
          if (!hash && !query) {
            throw new Error('Either hash or query must be provided.');
          }
          const retrieveProjectPath = projectPath;
          const store = ccrStoreForProject(retrieveProjectPath);
          let retrieved: string | null = null;
          let matchedHash = hash ?? '';

          if (hash) {
            const entry = store.get(hash);
            retrieved = entry?.content ?? null;
          } else if (query) {
            const entry = store.search(query, 1)[0];
            if (entry) {
              matchedHash = entry.hash;
              retrieved = store.get(entry.hash)?.content ?? entry.content;
            }
          }

          if (retrieved === null && dependencies.retrieveContent) {
            retrieved = await dependencies.retrieveContent(hash ?? '', query);
          }

          if (retrieved === null) {
            return textResult('No content found for the given hash or query.', true);
          }
          if (matchedHash) {
            recordRetrievalFeedback(resolveFeedbackLoop(dependencies, retrieveProjectPath), matchedHash, query);
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

  function normalizeToolArguments(args: ToolArguments): ToolArguments {
    if (optionalString(args.project)) {
      return args;
    }
    return {
      ...args,
      project: dependencies.projectPathResolver?.() ?? process.cwd()
    };
  }

  return {
    tools,
    async callTool(name: string, args: ToolArguments = {}): Promise<CallToolResult> {
      const startedAt = Date.now();
      const normalizedArgs = normalizeToolArguments(args);
      let result: CallToolResult | undefined;
      let thrown: unknown;
      try {
        result = await dispatchTool(name, normalizedArgs);
        return result;
      } catch (error) {
        thrown = error;
        result = textResult(error instanceof Error ? error.message : String(error), true);
        return result;
      } finally {
        recordToolSessionLog(dependencies, name, normalizedArgs, result, Date.now() - startedAt, thrown);
      }
    },
    close(): void {
      closeCachedStores();
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
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
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

function reviewOptions(args: ToolArguments, defaultDiff: boolean, feedbackLoop: CompressionFeedbackLoop): GraphReviewCommandOptions {
  const diff = typeof args.diff === 'boolean' ? args.diff : defaultDiff;
  return { diff, compress: true, feedbackLoop };
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

function jsonResult(value: unknown): CallToolResult {
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

function recordToolSessionLog(
  dependencies: ZincgraphToolRegistryDependencies,
  toolName: string,
  args: ToolArguments,
  result: CallToolResult | undefined,
  durationMs: number,
  thrown: unknown
): void {
  try {
    const store = sessionLogStore(dependencies, args);
    const output = toolName === 'zincgraph_retrieve' && result && !result.isError
      ? summarizeRetrievedContentForLog(result)
      : stringifyForLog(result);
    store.recordSessionLog({
      recordedAt: Date.now(),
      toolName,
      input: stringifyForLog(args),
      output,
      durationMs,
      error: sanitizeLogText(toolError(result, thrown)),
      queryContext: sanitizeLogText(optionalString(args.query) ?? optionalString(args.describe) ?? optionalString(args.hash) ?? '')
    });
  } catch {
    // Session logging is best-effort; tool dispatch must not fail because
    // SQLite/Python logging is unavailable or the output is unexpectedly large.
  }
}

function sessionLogStore(dependencies: ZincgraphToolRegistryDependencies, args: ToolArguments): FeedbackStore {
  if (dependencies.feedbackStore) {
    return dependencies.feedbackStore;
  }
  if (dependencies.feedbackLoop) {
    return dependencies.feedbackLoop.store;
  }
  const projectPath = optionalString(args.project) ?? dependencies.projectPathResolver?.() ?? process.cwd();
  return feedbackStoreForProject(projectPath);
}

function toolError(result: CallToolResult | undefined, thrown: unknown): string {
  if (thrown !== undefined) {
    return thrown instanceof Error ? thrown.message : String(thrown);
  }
  if (!result?.isError) {
    return '';
  }
  return callToolResultText(result);
}

function stringifyForLog(value: unknown): string {
  if (value === undefined) {
    return '';
  }
  const sanitized = sanitizeLogValue(value);
  return sanitizeLogText(JSON.stringify(sanitized));
}

function callToolResultText(result: CallToolResult): string {
  return result.content
    .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : JSON.stringify(part)))
    .join('\n');
}

function summarizeRetrievedContentForLog(result: CallToolResult): string {
  const text = callToolResultText(result);
  return sanitizeLogText(`[retrieved content omitted; ${text.length} chars]`);
}

function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return '[truncated]';
  }
  if (typeof value === 'string') {
    return sanitizeLogText(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeLogValue(entry, depth + 1));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      sanitized[key] = isSensitiveKey(key) ? '[REDACTED]' : sanitizeLogValue(entry, depth + 1);
    }
    return sanitized;
  }
  return value;
}

function isSensitiveKey(key: string): boolean {
  return /(?:api[_-]?key|access[_-]?token|secret|password|passwd|authorization|bearer|credential)/i.test(key);
}

function sanitizeLogText(text: string): string {
  if (!text) {
    return '';
  }

  const structured = redactStructuredLogText(text);
  const redacted = structured
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]')
    .replace(/(["'`]?)(api[_-]?key|access[_-]?token|secret|password|passwd|authorization|token|credential)\1\s*[:=]\s*(['"`])([^'"`]{4,})\3/gi, '$2=[REDACTED]')
    .replace(/(["'`]?)(api[_-]?key|access[_-]?token|secret|password|passwd|authorization|token|credential)\1\s*:\s*(['"`])([^'"`]{4,})\3/gi, '$2: [REDACTED]')
    .replace(/(["'`]?)(api[_-]?key|access[_-]?token|secret|password|passwd|authorization|token|credential)\1\s*[:=]\s*(?!['"`])([^\s,;`"'(){}\[\]]{4,})/gi, '$2=[REDACTED]');

  const maxChars = 8192;
  if (redacted.length <= maxChars) {
    return redacted;
  }
  return `${redacted.slice(0, maxChars)}…<truncated ${redacted.length - maxChars} chars>`;
}

function redactStructuredLogText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return text;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return JSON.stringify(redactStructuredLogValue(parsed));
  } catch {
    return text;
  }
}

function redactStructuredLogValue(value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return '[truncated]';
  }
  if (typeof value === 'string') {
    return sanitizeLogText(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactStructuredLogValue(entry, depth + 1));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      sanitized[key] = isSensitiveKey(key) ? '[REDACTED]' : redactStructuredLogValue(entry, depth + 1);
    }
    return sanitized;
  }
  return value;
}

function projectArg(args: ToolArguments): string {
  return optionalString(args.project) ?? process.cwd();
}

function resolveFeedbackLoop(dependencies: ZincgraphToolRegistryDependencies, projectPath: string): CompressionFeedbackLoop {
  if (dependencies.feedbackLoop) {
    return dependencies.feedbackLoop;
  }
  if (dependencies.feedbackStore) {
    return new CompressionFeedbackLoop({ store: dependencies.feedbackStore });
  }
  return new CompressionFeedbackLoop({ store: feedbackStoreForProject(projectPath) });
}

function applyFeedbackAwarePolicy(engine: FusionEngineLike, projectPath: string): void {
  try {
    const policy = createFeedbackAwarePolicy(projectPath);
    engine.setDynamicPolicy?.(policy);
    return;
  } catch {
    console.warn(`Feedback-aware policy initialization failed for ${projectPath}; leaving dynamic policy unset.`);
    engine.setDynamicPolicy?.(undefined);
  }
}

function createFeedbackAwareQueryEngine(projectPath: string): TopoSemanticQueryEngine {
  let dynamicPolicy: DynamicFusionPolicy | undefined;
  try {
    dynamicPolicy = createFeedbackAwarePolicy(projectPath);
  } catch {
    console.warn(`Feedback-aware policy initialization failed for ${projectPath}; using default fusion policy.`);
  }

  const dependencies = {
    compressResults: createProjectFusionCompressor(projectPath),
    ...(dynamicPolicy ? { dynamicPolicy } : {})
  };

  return new TopoSemanticQueryEngine(projectPath, {
    dependencies
  });
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

function feedbackStoreForProject(projectPath: string): FeedbackStore {
  const resolvedProjectPath = projectPath || process.cwd();
  const cached = feedbackStoreCache.get(resolvedProjectPath);
  if (cached) {
    return cached;
  }

  const store = new FeedbackStore({ projectPath: resolvedProjectPath });
  feedbackStoreCache.set(resolvedProjectPath, store);
  return store;
}

function ccrStoreForProject(projectPath: string): CcrStore {
  const resolvedProjectPath = projectPath || process.cwd();
  const cached = ccrStoreCache.get(resolvedProjectPath);
  if (cached) {
    return cached;
  }
  const store = new CcrStore({ projectPath: resolvedProjectPath });
  ccrStoreCache.set(resolvedProjectPath, store);
  return store;
}

function closeCachedStores(): void {
  for (const store of feedbackStoreCache.values()) {
    store.close();
  }
  feedbackStoreCache.clear();
  for (const store of ccrStoreCache.values()) {
    store.close();
  }
  ccrStoreCache.clear();
}

function normalizeCcrContentType(contentType: string, content: string): string {
  if (contentType !== 'auto') {
    return contentType;
  }
  return inferContentType(content);
}

function inferContentType(content: string): 'code' | 'json' | 'text' {
  const trimmed = content.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // fall through
    }
  }
  if (/\b(function|class|const|let|var|import|export|return|if|else|for|while)\b/.test(trimmed.slice(0, 200))) {
    return 'code';
  }
  return 'text';
}
