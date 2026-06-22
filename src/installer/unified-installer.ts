import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { runCodeGraphCli, type CodeGraphCliResult } from '../bridge/codegraphAdapter.js';
import { buildPonytailInstructions, type PonytailMode } from '../bridge/ponytailAdapter.js';
import { vectorizeProject, type VectorizeResult } from '../vector/code-to-vectors.js';

export type AgentName = 'Claude Code' | 'Cursor' | 'Copilot' | 'Codex' | 'Gemini' | 'OpenCode';

export interface AgentInstallTarget {
  agent: AgentName;
  markerPath: string;
  detected: boolean;
  mcpConfigPath: string;
  rulesPath: string;
}

export interface AgentInstallTargetInput {
  agent: AgentName;
  markerPath: string;
  detected?: boolean;
  mcpConfigPath: string;
  rulesPath: string;
}

export interface PlannedWrite {
  path: string;
  kind: 'mcp-config' | 'behavior-rules';
  agent: AgentName;
  content: string;
}

export interface UnifiedInstallerDependencies {
  buildInstructions?: (mode?: PonytailMode) => Promise<string>;
  initProject?: (projectPath: string) => Promise<CodeGraphCliResult | void> | CodeGraphCliResult | void;
  vectorize?: (projectPath: string) => Promise<VectorizeResult | void> | VectorizeResult | void;
}

export interface UnifiedInstallOptions {
  projectPath?: string;
  configRoot?: string;
  agents?: readonly AgentName[];
  targets?: readonly AgentInstallTargetInput[];
  yes?: boolean;
  dryRun?: boolean;
  overwrite?: boolean;
  initializeProject?: boolean;
  mode?: PonytailMode;
  command?: string;
  dependencies?: UnifiedInstallerDependencies;
}

export interface UnifiedInstallResult {
  projectPath: string;
  configRoot: string;
  dryRun: boolean;
  selectedTargets: AgentInstallTarget[];
  skippedTargets: AgentInstallTarget[];
  writes: PlannedWrite[];
  writtenPaths: string[];
  initialized: boolean;
  vectorized: boolean;
  messages: string[];
}

const TARGETS: Array<{
  agent: AgentName;
  marker: string;
  mcpConfig: string;
  rules: string;
}> = [
  { agent: 'Claude Code', marker: '.claude', mcpConfig: '.mcp.json', rules: '.claude/zincgraph-rules.md' },
  { agent: 'Cursor', marker: '.cursor', mcpConfig: '.cursor/mcp.json', rules: '.cursor/rules/zincgraph.md' },
  { agent: 'Copilot', marker: '.github', mcpConfig: '.mcp.json', rules: '.github/zincgraph-instructions.md' },
  { agent: 'Codex', marker: '.codex', mcpConfig: '.codex/mcp.json', rules: '.codex/zincgraph-instructions.md' },
  { agent: 'Gemini', marker: '.gemini', mcpConfig: '.gemini/mcp.json', rules: '.gemini/zincgraph-instructions.md' },
  { agent: 'OpenCode', marker: '.opencode', mcpConfig: '.opencode/mcp.json', rules: '.opencode/zincgraph-instructions.md' }
];

export function detectInstallTargets(configRoot = process.cwd()): AgentInstallTarget[] {
  const root = resolve(configRoot);
  return TARGETS.map((target) => ({
    agent: target.agent,
    markerPath: join(root, target.marker),
    detected: existsSync(join(root, target.marker)),
    mcpConfigPath: join(root, target.mcpConfig),
    rulesPath: join(root, target.rules)
  }));
}

export async function planZincgraphInstall(options: UnifiedInstallOptions = {}): Promise<UnifiedInstallResult> {
  const projectPath = resolve(options.projectPath ?? process.cwd());
  const configRoot = resolve(options.configRoot ?? projectPath);
  assertConfigRootSafe(configRoot);
  const injectedTargets = options.targets;
  const usesInjectedTargets = injectedTargets !== undefined;
  const targets = usesInjectedTargets
    ? injectedTargets.map((target) => resolveInjectedTargetPaths(target, configRoot))
    : detectInstallTargets(configRoot);
  const selected = selectTargets(targets, options.agents, usesInjectedTargets);
  const validatedSelected = selected.map((target) => validatePlannedTarget(target, configRoot));
  const instructions = await (options.dependencies?.buildInstructions ?? buildPonytailInstructions)(options.mode ?? 'full');
  const command = options.command ?? 'zincgraph';
  const writes = validatedSelected
    .flatMap((target) => plannedWrites(target, projectPath, command, instructions))
  return {
    projectPath,
    configRoot,
    dryRun: options.dryRun ?? true,
    selectedTargets: validatedSelected,
    skippedTargets: targets.filter((target) => !selected.includes(target)),
    writes,
    writtenPaths: [],
    initialized: false,
    vectorized: false,
    messages: [`detected=${selected.length}`, `plannedWrites=${writes.length}`]
  };
}

export async function installZincgraph(options: UnifiedInstallOptions = {}): Promise<UnifiedInstallResult> {
  const dryRun = options.dryRun ?? !options.yes;
  const plan = await planZincgraphInstall({ ...options, dryRun });
  if (dryRun) {
    plan.messages.push('dry-run: no files written; pass --yes to apply within the configured root');
    return plan;
  }

  const preparedWrites = plan.writes.map((write) => prepareWrite(write, plan.configRoot, options.overwrite ?? false));
  const writtenPaths: string[] = [];
  for (const write of preparedWrites) {
    writeFileSync(write.path, write.content, 'utf8');
    writtenPaths.push(write.path);
  }

  let initialized = false;
  let vectorized = false;
  if (options.initializeProject ?? true) {
    await (options.dependencies?.initProject ?? defaultInitProject)(plan.projectPath);
    initialized = true;
    await (options.dependencies?.vectorize ?? vectorizeProject)(plan.projectPath);
    vectorized = true;
  }

  return {
    ...plan,
    dryRun: false,
    writtenPaths,
    initialized,
    vectorized,
    messages: [...plan.messages, `written=${writtenPaths.length}`, initialized ? 'initialized' : 'init-skipped']
  };
}

function selectTargets(
  targets: readonly AgentInstallTarget[],
  agents?: readonly AgentName[],
  usesInjectedTargets = false
): AgentInstallTarget[] {
  if (agents && agents.length > 0) {
    const requested = new Set<AgentName>(agents);
    return targets.filter((target) => requested.has(target.agent));
  }
  if (usesInjectedTargets) {
    return [...targets];
  }
  return targets.filter((target) => target.detected);
}

function resolveInjectedTargetPaths(target: AgentInstallTargetInput, configRoot: string): AgentInstallTarget {
  return {
    ...target,
    detected: target.detected ?? true,
    markerPath: resolve(configRoot, target.markerPath),
    mcpConfigPath: resolve(configRoot, target.mcpConfigPath),
    rulesPath: resolve(configRoot, target.rulesPath)
  };
}

function plannedWrites(
  target: AgentInstallTarget,
  projectPath: string,
  command: string,
  instructions: string
): PlannedWrite[] {
  return [
    {
      path: target.mcpConfigPath,
      kind: 'mcp-config',
      agent: target.agent,
      content: JSON.stringify({
        mcpServers: {
          zincgraph: {
            command,
            args: ['mcp'],
            cwd: projectPath
          }
        }
      }, null, 2)
    },
    {
      path: target.rulesPath,
      kind: 'behavior-rules',
      agent: target.agent,
      content: [
        '# Zincgraph behavior rules',
        '',
        'Use the configured `zincgraph` MCP server for CodeGraph, Ponytail, semantic search, and deduplication evidence.',
        '',
        instructions
      ].join('\n')
    }
  ];
}

function validatePlannedTarget(target: AgentInstallTarget, root: string): AgentInstallTarget {
  return {
    ...target,
    mcpConfigPath: validateSafePlannedPath(target.mcpConfigPath, root),
    rulesPath: validateSafePlannedPath(target.rulesPath, root)
  };
}

function validateSafePlannedPath(filePath: string, root: string): string {
  const resolvedFile = resolve(filePath);
  const resolvedRoot = resolve(root);
  assertInsideRoot(resolvedFile, resolvedRoot);
  assertConfigRootSafe(resolvedRoot);
  if (!pathEntryExists(resolvedRoot)) {
    return resolvedFile;
  }
  assertNoSymlink(resolvedRoot, 'config root');
  const realRoot = realpathSync.native(resolvedRoot);
  assertExistingSegmentsSafe(resolvedFile, resolvedRoot, realRoot);
  return resolvedFile;
}

function prepareWrite(write: PlannedWrite, root: string, overwrite: boolean): PlannedWrite {
  const path = prepareSafeWritePath(write.path, root);
  return {
    ...write,
    path,
    content: prepareWriteContent({ ...write, path }, overwrite)
  };
}

function prepareSafeWritePath(filePath: string, root: string): string {
  const resolvedFile = resolve(filePath);
  const resolvedRoot = resolve(root);
  assertInsideRoot(resolvedFile, resolvedRoot);
  assertConfigRootSafe(resolvedRoot);
  mkdirSync(resolvedRoot, { recursive: true });
  assertConfigRootSafe(resolvedRoot);
  assertNoSymlink(resolvedRoot, 'config root');
  const realRoot = realpathSync.native(resolvedRoot);
  const parent = dirname(resolvedFile);
  assertExistingSegmentsSafe(parent, resolvedRoot, realRoot);
  mkdirSync(parent, { recursive: true });
  assertExistingSegmentsSafe(resolvedFile, resolvedRoot, realRoot);
  assertRealInsideRoot(parent, realRoot, resolvedRoot);
  if (pathEntryExists(resolvedFile)) {
    assertNoSymlink(resolvedFile, 'target file');
    assertRealInsideRoot(resolvedFile, realRoot, resolvedRoot);
  }
  return resolvedFile;
}

function prepareWriteContent(write: PlannedWrite, overwrite: boolean): string {
  if (!pathEntryExists(write.path) || overwrite) {
    return write.content;
  }
  if (write.kind === 'behavior-rules') {
    throw new Error(`Refusing to overwrite existing behavior rules without overwrite:true: ${write.path}`);
  }
  return mergeMcpConfig(write.path, write.content);
}

function mergeMcpConfig(path: string, zincgraphConfigJson: string): string {
  const existingJson = readFileSync(path, 'utf8');
  let existing: unknown;
  try {
    existing = JSON.parse(existingJson);
  } catch (error) {
    throw new Error(`Existing MCP config is malformed; pass overwrite:true to replace it: ${path}`);
  }
  if (!isJsonObject(existing)) {
    throw new Error(`Existing MCP config must be a JSON object; pass overwrite:true to replace it: ${path}`);
  }
  const zincgraphConfig = JSON.parse(zincgraphConfigJson) as { mcpServers: { zincgraph: unknown } };
  const existingMcpServers = existing.mcpServers;
  if (existingMcpServers !== undefined && !isJsonObject(existingMcpServers)) {
    throw new Error(`Existing MCP config mcpServers must be a JSON object; pass overwrite:true to replace it: ${path}`);
  }
  return `${JSON.stringify({
    ...existing,
    mcpServers: {
      ...(isJsonObject(existingMcpServers) ? existingMcpServers : {}),
      zincgraph: zincgraphConfig.mcpServers.zincgraph
    }
  }, null, 2)}\n`;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertInsideRoot(filePath: string, root: string): void {
  if (!isInsideOrEqual(filePath, root)) {
    throw new Error(`Refusing to write outside config root: ${filePath}`);
  }
}

function assertExistingSegmentsSafe(path: string, root: string, realRoot: string): void {
  assertInsideRoot(path, root);
  const pathFromRoot = relative(root, path);
  if (!pathFromRoot) {
    return;
  }
  let current = root;
  for (const segment of pathFromRoot.split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (!pathEntryExists(current)) {
      return;
    }
    assertNoSymlink(current, current === path ? 'target file' : 'path segment');
    assertRealInsideRoot(current, realRoot, root);
  }
}

function assertNoSymlink(path: string, label: string): void {
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error(`Refusing to write through symlink ${label}: ${path}`);
  }
}

function assertConfigRootSafe(root: string): void {
  const segments = resolve(root).split(sep).filter(Boolean);
  let current: string = sep;
  for (const segment of segments) {
    current = join(current, segment);
    if (!pathEntryExists(current)) {
      return;
    }
    assertNoSymlink(current, current === root ? 'config root' : 'config root ancestor');
  }
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isNodeErrorWithCode(error) && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function isNodeErrorWithCode(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function assertRealInsideRoot(path: string, realRoot: string, displayRoot: string): void {
  const realPath = realpathSync.native(path);
  if (!isInsideOrEqual(realPath, realRoot)) {
    throw new Error(`Refusing to write outside config root: ${path} resolves to ${realPath} outside ${displayRoot}`);
  }
}

function isInsideOrEqual(path: string, root: string): boolean {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
}

function defaultInitProject(projectPath: string): CodeGraphCliResult {
  const result = runCodeGraphCli(['init', projectPath]);
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'CodeGraph init failed');
  }
  return result;
}
