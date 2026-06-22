#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { Command } from 'commander';

import { runCodeGraphCli as defaultRunCodeGraphCli } from './bridge/codegraphAdapter.js';
import { runPonytailReview as defaultRunPonytailReview } from './bridge/ponytailAdapter.js';
import { probeZvec } from './bridge/zvecAdapter.js';
import { vectorizeProject } from './vector/code-to-vectors.js';
import { runVectorizeCommand } from './vector/vectorize-command.js';
import { TopoSemanticQueryEngine, type ContextCapsule } from './fusion/query-engine.js';
import { FreshnessGate, type FreshnessGateOptions, type FreshnessGateResult } from './freshness/freshness-gate.js';
import {
  formatGraphReviewCommandResult,
  runGraphReviewCommand,
  type GraphReviewCommandOptions,
  type GraphReviewCommandResult
} from './behavior/review-command.js';
import type { CodeGraphSnapshot } from './vector/code-to-vectors.js';
import { runDedupCommand, type DedupCommandResult } from './behavior/dedup-command.js';
import { runAutoSyncOnce as defaultRunAutoSyncOnce } from './freshness/auto-sync.js';
import { probeHeadroom } from './bridge/headroomAdapter.js';
import { FusionCompressor } from './compression/fusion-compressor.js';
import { CcrStore } from './compression/ccr-store.js';
import { FusionStore } from './freshness/fusion-store.js';

const CODEGRAPH_DELEGATED_COMMANDS = [
  { command: 'index', upstream: 'index', argumentDescription: 'CodeGraph index arguments', description: 'Delegate indexing to CodeGraph' },
  { command: 'node', upstream: 'node', argumentDescription: 'CodeGraph node arguments', description: 'Delegate symbol/file node view to CodeGraph' },
  { command: 'callers', upstream: 'callers', argumentDescription: 'CodeGraph callers arguments', description: 'Delegate caller enumeration to CodeGraph' },
  { command: 'callees', upstream: 'callees', argumentDescription: 'CodeGraph callees arguments', description: 'Delegate callee enumeration to CodeGraph' },
  { command: 'impact', upstream: 'impact', argumentDescription: 'CodeGraph impact arguments', description: 'Delegate impact analysis to CodeGraph' },
  { command: 'affected', upstream: 'affected', argumentDescription: 'CodeGraph affected arguments', description: 'Delegate affected test recommendation to CodeGraph' },
  { command: 'sync', upstream: 'sync', argumentDescription: 'CodeGraph sync arguments', description: 'Delegate incremental sync to CodeGraph' },
  { command: 'watch', upstream: 'daemon', argumentDescription: 'CodeGraph daemon/watch arguments', description: 'Delegate watch/daemon management to CodeGraph' },
  { command: 'daemon', upstream: 'daemon', argumentDescription: 'CodeGraph daemon arguments', description: 'Delegate daemon management to CodeGraph' },
  { command: 'uninstall', upstream: 'uninstall', argumentDescription: 'CodeGraph uninstall arguments', description: 'Delegate CodeGraph uninstall to CodeGraph' }
] as const;

type CodeGraphRunner = typeof defaultRunCodeGraphCli;

import { startZincgraphMcpServer } from './mcp/unified-server.js';
import { installZincgraph, type AgentName, type UnifiedInstallResult } from './installer/unified-installer.js';

function readVersion(): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as { version?: string };
    return packageJson.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export interface CliBuildOptions {
  createFusionEngine?: (projectPath: string) => Pick<TopoSemanticQueryEngine, 'query' | 'search'>;
  createFreshnessGate?: (projectPath: string) => Pick<FreshnessGate, 'ensureReady'>;
  syncProject?: (projectPath: string) => Promise<unknown> | unknown;
  runPonytailReview?: typeof defaultRunPonytailReview;
  runGraphReview?: (projectPath: string, options: GraphReviewCommandOptions) => Promise<GraphReviewCommandResult> | GraphReviewCommandResult;
  readGraphSnapshot?: (projectPath: string) => CodeGraphSnapshot;
  readGraphDiff?: (projectPath: string) => string;
  runDedup?: (options: { projectPath: string; describe: string; threshold?: number; topk?: number }) => Promise<DedupCommandResult> | DedupCommandResult;
  runCodeGraphCli?: typeof defaultRunCodeGraphCli;
  startMcpServer?: typeof startZincgraphMcpServer;
  runInstaller?: typeof installZincgraph;
  runAutoSyncOnce?: typeof defaultRunAutoSyncOnce;
}


export function buildCli(cliOptions: CliBuildOptions = {}): Command {
  const program = new Command();
  program
    .name('zincgraph')
    .description('Unified bridge CLI for CodeGraph, Zvec, and Ponytail')
    .version(readVersion());

  program
    .command('init')
    .argument('[project]', 'project path', process.cwd())
    .description('Delegate CodeGraph initialization/indexing')
    .action((project: string) => {
      const result = runCodeGraph(cliOptions)(['init', project]);
      if (result.stdout) {
        process.stdout.write(result.stdout);
      }
      if (result.stderr) {
        process.stderr.write(result.stderr);
      }
      process.exitCode = result.status;
    });

  program
    .command('status')
    .argument('[project]', 'project path', process.cwd())
    .option('--json', 'forward JSON output from CodeGraph')
    .description('Delegate project status to CodeGraph')
    .action((project: string, options: { json?: boolean }) => {
      const args = ['status', project];
      if (options.json) {
        args.push('--json');
      }
      const result = runCodeGraph(cliOptions)(args);
      if (result.stdout) {
        process.stdout.write(result.stdout);
      }
      if (result.stderr) {
        process.stderr.write(result.stderr);
      }
      process.exitCode = result.status;
    });


  for (const mapping of CODEGRAPH_DELEGATED_COMMANDS) {
    program
      .command(mapping.command)
      .argument('[args...]', mapping.argumentDescription)
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .description(mapping.description)
      .action((args: string[] = []) => {
        const result = runCodeGraph(cliOptions)([mapping.upstream, ...args]);
        writeCodeGraphResult(result);
      });
  }

  program
    .command('mcp')
    .description('Start the unified Zincgraph MCP server over stdio')
    .action(async () => {
      await (cliOptions.startMcpServer ?? startZincgraphMcpServer)();
    });

  program
    .command('install')
    .argument('[project]', 'project path', process.cwd())
    .option('-y, --yes', 'apply non-interactively within the configured root')
    .option('--dry-run', 'print planned writes without writing files')
    .option('--config-root <path>', 'configuration root; defaults to the project path')
    .option('--agent <name...>', 'agent names to configure; defaults to detected project-local agents')
    .option('--skip-init', 'skip CodeGraph init and Zincgraph vectorization')
    .description('Configure Zincgraph MCP + Ponytail behavior rules for detected agents')
    .action(async (project: string, options: { yes?: boolean; dryRun?: boolean; configRoot?: string; agent?: AgentName[]; skipInit?: boolean }) => {
      const installOptions: Parameters<typeof installZincgraph>[0] = {
        projectPath: project,
        yes: options.yes ?? false,
        initializeProject: !(options.skipInit ?? false)
      };
      if (options.configRoot !== undefined) {
        installOptions.configRoot = options.configRoot;
      }
      if (options.agent !== undefined) {
        installOptions.agents = options.agent;
      }
      if (options.dryRun !== undefined) {
        installOptions.dryRun = options.dryRun;
      }
      const result = await (cliOptions.runInstaller ?? installZincgraph)(installOptions);
      console.log(formatInstallResult(result));
    });

  program
    .command('review')
    .argument('[project]', 'project path', process.cwd())
    .option('--diff', 'review the current diff instead of auditing the whole project')
    .option('--force', 'bypass freshness gate warnings')
    .description('Delegate over-engineering review/audit prompts to Ponytail after freshness checks')
    .action(async (project: string, options: { diff?: boolean; force?: boolean }) => {
      const readiness = await ensureReviewFreshness(project, options.force ?? false, cliOptions);
      for (const warning of readiness.warnings) {
        if (warning) {
          console.error(`warning: ${warning}`);
        }
      }
      const review = cliOptions.runPonytailReview ?? defaultRunPonytailReview;
      const diff = options.diff ?? false;
      const delegation = review(project, { diff });
      const graphOptions: GraphReviewCommandOptions = { diff, ponytail: delegation, runPonytail: review };
      if (cliOptions.readGraphSnapshot) {
        graphOptions.readSnapshot = cliOptions.readGraphSnapshot;
      }
      if (cliOptions.readGraphDiff) {
        graphOptions.readDiff = cliOptions.readGraphDiff;
      }
      const graphReview = cliOptions.runGraphReview
        ? await cliOptions.runGraphReview(project, graphOptions)
        : await runGraphReviewCommand(project, graphOptions);
      for (const line of formatGraphReviewCommandResult(graphReview)) {
        console.log(line);
      }
    });


  program
    .command('audit')
    .argument('[project]', 'project path', process.cwd())
    .option('--force', 'bypass freshness gate warnings')
    .description('Run Zincgraph graph-enhanced Ponytail audit after freshness checks')
    .action(async (project: string, options: { force?: boolean }) => {
      const readiness = await ensureReviewFreshness(project, options.force ?? false, cliOptions);
      for (const warning of readiness.warnings) {
        if (warning) {
          console.error(`warning: ${warning}`);
        }
      }
      const review = cliOptions.runPonytailReview ?? defaultRunPonytailReview;
      const delegation = review(project, { diff: false });
      const graphOptions: GraphReviewCommandOptions = { diff: false, ponytail: delegation, runPonytail: review };
      if (cliOptions.readGraphSnapshot) {
        graphOptions.readSnapshot = cliOptions.readGraphSnapshot;
      }
      const graphReview = cliOptions.runGraphReview
        ? await cliOptions.runGraphReview(project, graphOptions)
        : await runGraphReviewCommand(project, graphOptions);
      for (const line of formatGraphReviewCommandResult(graphReview)) {
        console.log(line);
      }
    });

  program
    .command('vectorize')
    .argument('[project]', 'project path', process.cwd())
    .description('Create Zincgraph vector documents from the CodeGraph index')
    .action(async (project: string) => {
      await runVectorizeCommand(project);
    });

  program
    .command('auto-sync')
    .argument('[project]', 'project path', process.cwd())
    .option('--file <file...>', 'project-relative changed file(s) to sync')
    .description('Run one-shot Zincgraph graph + vector auto-sync for changed files')
    .action(async (project: string, options: { file?: string[] }) => {
      if (!options.file?.length) {
        throw new Error('Auto-sync requires at least one changed file.');
      }
      const result = await (cliOptions.runAutoSyncOnce ?? defaultRunAutoSyncOnce)(project, {
        files: options.file,
        source: 'cli'
      });
      console.log(JSON.stringify(result, null, 2));
    });

  program
    .command('dedup')
    .requiredOption('--describe <text>', 'describe the function or behavior you plan to add')
    .option('-p, --project <project>', 'project path', process.cwd())
    .option('--threshold <number>', 'similarity threshold between 0 and 1', parseThreshold, 0.85)
    .option('--topk <number>', 'maximum match count', parsePositiveInteger, 5)
    .description('Check whether a proposed implementation semantically duplicates existing code')
    .action(async (options: { describe: string; project: string; threshold: number; topk: number }) => {
      const command = cliOptions.runDedup ?? runDedupCommand;
      const result = await command({
        projectPath: options.project,
        describe: options.describe,
        threshold: options.threshold,
        topk: options.topk
      });
      console.log(result.output);
    });


  program
    .command('explore')
    .argument('<query...>', 'query text or fielded query tokens')
    .option('-p, --project <project>', 'project path', process.cwd())
    .option('--topk <number>', 'maximum result count', parsePositiveInteger, 10)
    .option('--max-tokens <number>', 'context token budget', parsePositiveInteger, 8000)
    .description('Run Zincgraph fusion explore (graph + vector + lexical text + freshness)')
    .action(async (queryParts: string[], options: { project: string; topk: number; maxTokens: number }) => {
      const capsule = await runFusionQuery('query', queryParts.join(' '), options.project, fusionCliOptions(options, cliOptions));
      console.log(JSON.stringify(capsule, null, 2));
    });

  program
    .command('search')
    .argument('<query...>', 'fielded query tokens such as kind:function name:auth')
    .option('-p, --project <project>', 'project path', process.cwd())
    .option('--topk <number>', 'maximum result count', parsePositiveInteger, 10)
    .option('--max-tokens <number>', 'context token budget', parsePositiveInteger, 8000)
    .option('--codegraph', 'delegate to upstream CodeGraph query instead of Zincgraph fusion search')
    .option('--kind <kind>', 'CodeGraph symbol kind filter when --codegraph is used')
    .option('--json', 'request JSON output when --codegraph is used')
    .description('Run Zincgraph fusion search by default; use --codegraph for upstream CodeGraph query')
    .action(async (queryParts: string[], options: { project: string; topk: number; maxTokens: number; codegraph?: boolean; kind?: string; json?: boolean }) => {
      const query = queryParts.join(' ');
      if (options.codegraph) {
        const args = ['query', query, '-p', options.project, '--limit', String(options.topk)];
        if (options.kind) {
          args.push('--kind', options.kind);
        }
        if (options.json) {
          args.push('--json');
        }
        writeCodeGraphResult(runCodeGraph(cliOptions)(args));
        return;
      }
      const capsule = await runFusionQuery('search', query, options.project, fusionCliOptions(options, cliOptions));
      console.log(JSON.stringify(capsule, null, 2));
    });

  program
    .command('probe')
    .argument('<target>', 'dependency to probe: zvec | headroom')
    .option('--live', 'attempt live operations (collection ops for zvec, compress for headroom)')
    .description('Run dependency probes')
    .action(async (target: string, options: { live?: boolean }) => {
      if (target === 'zvec') {
        const result = await probeZvec({ runOperations: options.live ?? false });
        console.log(JSON.stringify(result, null, 2));
        process.exitCode = result.scenario === 'A:npm-binding' ? 0 : 2;
      } else if (target === 'headroom') {
        const result = await probeHeadroom({ runCompress: options.live ?? false });
        console.log(JSON.stringify(result, null, 2));
        process.exitCode = result.scenario === 'A:npm-sdk' ? 0 : 2;
      } else {
        throw new Error(`Unsupported probe target: ${target}. Use 'zvec' or 'headroom'.`);
      }
    });

  program
    .command('compression-stats')
    .argument('[project]', 'project path', process.cwd())
    .description('Output compression statistics for the project')
    .action((project: string) => {
      const store = new CcrStore({ projectPath: project });
      const storeStats = store.stats();
      const compressor = FusionCompressor.createFromProject(project);
      const sessionStats = compressor.getStats();
      console.log(JSON.stringify({
        ccrStore: storeStats,
        session: sessionStats
      }, null, 2));
    });

  program
    .command('config')
    .argument('<action>', 'get or set')
    .argument('<key>', 'configuration key (e.g. compression.enabled, relevance.mode)')
    .argument('[value]', 'configuration value (for set)')
    .option('-p, --project <project>', 'project path', process.cwd())
    .description('Get or set Zincgraph configuration (persisted in fusion.sqlite metadata)')
    .action((action: string, key: string, value: string | undefined, options: { project: string }) => {
      const store = new FusionStore(options.project);
      if (action === 'get') {
        const stored = store.getMetadata(key);
        console.log(JSON.stringify({ key, value: stored }, null, 2));
      } else if (action === 'set') {
        if (value === undefined) {
          throw new Error(`config set requires a value. Usage: zincgraph config set ${key} <value>`);
        }
        store.setMetadata(key, value);
        console.log(JSON.stringify({ key, value, updated: true }, null, 2));
      } else {
        throw new Error(`Unsupported config action: ${action}. Use 'get' or 'set'.`);
      }
    });

  program
    .command('retrieve')
    .argument('<hash>', 'CCR hash from a previous compress operation')
    .argument('[project]', 'project path', process.cwd())
    .description('Retrieve original uncompressed content by CCR hash')
    .action((hash: string, project: string) => {
      const store = new CcrStore({ projectPath: project });
      const entry = store.get(hash);
      if (entry) {
        console.log(JSON.stringify(entry, null, 2));
      } else {
        console.error(`No CCR entry found for hash: ${hash}`);
        process.exitCode = 1;
      }
    });

  return program;
}

async function ensureReviewFreshness(
  projectPath: string,
  force: boolean,
  cliOptions: CliBuildOptions
): Promise<FreshnessGateResult> {
  const gate = cliOptions.createFreshnessGate?.(projectPath) ?? new FreshnessGate(projectPath);
  const syncProject = cliOptions.syncProject ?? vectorizeProject;
  const options: FreshnessGateOptions = {
    force,
    sync: async () => {
      await syncProject(projectPath);
    }
  };
  const readiness = await gate.ensureReady(options);
  if (!readiness.allowed) {
    throw new Error(readiness.warnings.join('\n') || 'index not fresh');
  }
  return readiness;
}

function fusionCliOptions(
  options: { topk: number; maxTokens: number },
  cliOptions: CliBuildOptions
): { topk: number; maxTokens: number; createFusionEngine?: (projectPath: string) => Pick<TopoSemanticQueryEngine, 'query' | 'search'> } {
  const base = { topk: options.topk, maxTokens: options.maxTokens };
  return cliOptions.createFusionEngine ? { ...base, createFusionEngine: cliOptions.createFusionEngine } : base;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got ${value}`);
  }
  return parsed;
}

function parseThreshold(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Expected a threshold between 0 and 1, got ${value}`);
  }
  return parsed;
}

async function runFusionQuery(
  method: 'query' | 'search',
  query: string,
  projectPath: string,
  options: {
    topk: number;
    maxTokens: number;
    createFusionEngine?: (projectPath: string) => Pick<TopoSemanticQueryEngine, 'query' | 'search'>;
  }
): Promise<ContextCapsule> {
  const engine = options.createFusionEngine?.(projectPath) ?? new TopoSemanticQueryEngine(projectPath);
  return engine[method](query, { topk: options.topk, maxTokens: options.maxTokens });
}


function runCodeGraph(cliOptions: CliBuildOptions): CodeGraphRunner {
  return cliOptions.runCodeGraphCli ?? defaultRunCodeGraphCli;
}

function writeCodeGraphResult(result: ReturnType<CodeGraphRunner>): void {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exitCode = result.status;
}

function formatInstallResult(result: UnifiedInstallResult): string {
  return JSON.stringify({
    projectPath: result.projectPath,
    configRoot: result.configRoot,
    dryRun: result.dryRun,
    selectedAgents: result.selectedTargets.map((target) => target.agent),
    skippedAgents: result.skippedTargets.map((target) => target.agent),
    plannedWrites: result.writes.map((write) => ({ path: write.path, kind: write.kind, agent: write.agent })),
    writtenPaths: result.writtenPaths,
    initialized: result.initialized,
    vectorized: result.vectorized,
    messages: result.messages
  }, null, 2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildCli().parseAsync(process.argv).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
