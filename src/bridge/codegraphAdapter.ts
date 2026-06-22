import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  Edge as UpstreamCodeEdge,
  GraphStats,
  IndexResult,
  Node as UpstreamCodeNode,
  SearchOptions,
  SearchResult
} from '@colbymchenry/codegraph';

export type CodeNode = UpstreamCodeNode;
export type CodeEdge = UpstreamCodeEdge;

export interface CodeGraphStatus {
  initialized: boolean;
  projectPath: string;
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  dbSizeBytes: number;
  languages: string[];
}

export interface CodeGraphStatusJson {
  initialized?: boolean;
  version?: string;
  projectPath?: string;
  indexPath?: string;
  fileCount?: number;
  nodeCount?: number;
  edgeCount?: number;
  dbSizeBytes?: number;
  languages?: string[];
  [key: string]: unknown;
}

export interface CodeGraphCliResult {
  command: string;
  args: string[];
  status: number;
  stdout: string;
  stderr: string;
}

interface CodeGraphInstance {
  indexAll(options?: { verbose?: boolean; signal?: AbortSignal }): Promise<IndexResult>;
  searchNodes(query: string, options?: SearchOptions): SearchResult[];
  getStats(): GraphStats;
  close?: () => void;
  destroy?: () => void;
}

interface CodeGraphStatic {
  init(projectRoot: string, options?: { index?: boolean }): Promise<CodeGraphInstance>;
  open(projectRoot: string, options?: { sync?: boolean; readOnly?: boolean }): Promise<CodeGraphInstance>;
  isInitialized(projectRoot: string): boolean;
}

function closeGraph(graph: CodeGraphInstance): void {
  if (typeof graph.close === 'function') {
    graph.close();
    return;
  }
  graph.destroy?.();
}

async function loadCodeGraph(): Promise<CodeGraphStatic> {
  const moduleValue = (await import('@colbymchenry/codegraph')) as unknown as Record<string, unknown>;
  const candidate = moduleValue.CodeGraph ?? moduleValue.default ?? moduleValue;

  if (
    typeof candidate === 'function' &&
    'init' in candidate &&
    'open' in candidate &&
    'isInitialized' in candidate
  ) {
    return candidate as unknown as CodeGraphStatic;
  }

  throw new Error('The @colbymchenry/codegraph SDK did not expose a CodeGraph facade.');
}

export async function isCodeGraphSdkLoadable(): Promise<boolean> {
  try {
    await loadCodeGraph();
    return true;
  } catch {
    return false;
  }
}

export async function indexCodeGraphProject(projectPath: string): Promise<IndexResult> {
  const CodeGraph = await loadCodeGraph();
  const projectRoot = resolve(projectPath);
  const graph = CodeGraph.isInitialized(projectRoot)
    ? await CodeGraph.open(projectRoot)
    : await CodeGraph.init(projectRoot);

  try {
    return await graph.indexAll();
  } finally {
    closeGraph(graph);
  }
}

export async function getCodeGraphStatus(projectPath: string): Promise<CodeGraphStatus> {
  const CodeGraph = await loadCodeGraph();
  const projectRoot = resolve(projectPath);

  if (!CodeGraph.isInitialized(projectRoot)) {
    return {
      initialized: false,
      projectPath: projectRoot,
      fileCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      dbSizeBytes: 0,
      languages: []
    };
  }

  const graph = await CodeGraph.open(projectRoot, { readOnly: true });
  try {
    const stats = graph.getStats();
    return {
      initialized: true,
      projectPath: projectRoot,
      fileCount: stats.fileCount,
      nodeCount: stats.nodeCount,
      edgeCount: stats.edgeCount,
      dbSizeBytes: stats.dbSizeBytes,
      languages: Object.entries(stats.filesByLanguage)
        .filter(([, count]) => count > 0)
        .map(([language]) => language)
    };
  } finally {
    closeGraph(graph);
  }
}

export async function searchCodeGraphProject(
  projectPath: string,
  query: string,
  options?: SearchOptions
): Promise<SearchResult[]> {
  const CodeGraph = await loadCodeGraph();
  const graph = await CodeGraph.open(resolve(projectPath), { readOnly: true });
  try {
    return graph.searchNodes(query, options);
  } finally {
    closeGraph(graph);
  }
}

function localCodeGraphBin(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), 'node_modules/.bin/codegraph'),
    resolve(here, '../../node_modules/.bin/codegraph'),
    resolve(here, '../node_modules/.bin/codegraph')
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function runCodeGraphCli(args: string[], cwd = process.cwd()): CodeGraphCliResult {
  const localBin = localCodeGraphBin();
  const command = localBin ?? 'codegraph';
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32'
  });

  return {
    command,
    args,
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error?.message ?? '')
  };
}

export function syncCodeGraphProject(projectPath: string): CodeGraphCliResult {
  const result = runCodeGraphCli(['sync', projectPath]);
  if (result.status !== 0) {
    throw new Error(result.stderr || `codegraph sync exited ${result.status}`);
  }
  return result;
}

export function getCodeGraphStatusViaCli(projectPath: string): CodeGraphStatusJson {
  const result = runCodeGraphCli(['status', projectPath, '--json']);
  if (result.status !== 0) {
    throw new Error(result.stderr || `codegraph status exited ${result.status}`);
  }

  return JSON.parse(result.stdout) as CodeGraphStatusJson;
}
