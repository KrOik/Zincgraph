import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type PonytailMode = 'off' | 'lite' | 'full' | 'ultra';

export interface PonytailAgentAdapter {
  agent: 'Claude' | 'Codex' | 'Cursor' | 'Copilot' | 'OpenCode';
  path: string;
  exists: boolean;
}

export interface PonytailCommandDelegation {
  command: 'ponytail-review' | 'ponytail-audit';
  projectPath: string;
  diff: boolean;
  prompt: string;
  marker: string;
}

interface PonytailInstructionsModule {
  buildInstructions(mode?: string): string;
}

const PONYTAIL_ROOT = resolve('refer/ponytail');

function normalizeMode(mode: PonytailMode = 'full'): PonytailMode {
  return mode;
}

async function loadInstructionsModule(): Promise<PonytailInstructionsModule> {
  const packageSpecifier = 'ponytail-mcp/instructions.js';
  const packageImport = import(packageSpecifier) as Promise<unknown>;
  try {
    return (await packageImport) as PonytailInstructionsModule;
  } catch {
    const localPath = resolve(PONYTAIL_ROOT, 'ponytail-mcp/instructions.js');
    return (await import(pathToFileURL(localPath).href)) as PonytailInstructionsModule;
  }
}

export async function buildPonytailInstructions(mode: PonytailMode = 'full'): Promise<string> {
  const normalized = normalizeMode(mode);
  if (normalized === 'off') {
    return '';
  }

  const moduleValue = await loadInstructionsModule();
  return moduleValue.buildInstructions(normalized);
}

export function getPonytailAgentAdapters(): PonytailAgentAdapter[] {
  const adapters: PonytailAgentAdapter[] = [
    { agent: 'Claude', path: resolve(PONYTAIL_ROOT, '.claude-plugin/plugin.json'), exists: false },
    { agent: 'Codex', path: resolve(PONYTAIL_ROOT, '.codex-plugin/plugin.json'), exists: false },
    { agent: 'Cursor', path: resolve(PONYTAIL_ROOT, '.cursor'), exists: false },
    { agent: 'Copilot', path: resolve(PONYTAIL_ROOT, '.github/copilot-instructions.md'), exists: false },
    { agent: 'OpenCode', path: resolve(PONYTAIL_ROOT, '.opencode/plugins'), exists: false }
  ];

  return adapters.map((adapter) => ({ ...adapter, exists: existsSync(adapter.path) }));
}

export function createPonytailMcpDescriptor(): { name: string; tools: string[]; prompts: string[] } {
  return {
    name: 'ponytail',
    tools: ['ponytail_instructions'],
    prompts: ['ponytail']
  };
}

function readTomlString(filePath: string, key: string): string {
  const source = readFileSync(filePath, 'utf8');
  const match = source.match(new RegExp(`^${key}\\s*=\\s*(\".*\")$`, 'm'));
  if (!match?.[1]) {
    throw new Error(`Missing ${key} in ${filePath}`);
  }
  return JSON.parse(match[1]) as string;
}

export function runPonytailReview(projectPath: string, options: { diff?: boolean } = {}): PonytailCommandDelegation {
  const command = options.diff ? 'ponytail-review' : 'ponytail-audit';
  const commandFile = resolve(PONYTAIL_ROOT, 'commands', `${command}.toml`);
  const prompt = readTomlString(commandFile, 'prompt');

  return {
    command,
    projectPath: resolve(projectPath),
    diff: options.diff ?? false,
    prompt,
    marker: `Ponytail delegated ${command}`
  };
}
