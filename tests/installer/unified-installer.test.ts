import { mkdtempSync, mkdirSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  detectInstallTargets,
  installZincgraph,
  planZincgraphInstall,
  type AgentInstallTargetInput,
  type UnifiedInstallOptions
} from '../../src/installer/unified-installer.js';
import type { AgentInstallTargetInput as RootAgentInstallTargetInput } from '../../src/index.js';

function fixture(): string {
  return mkdtempSync(join(tmpdir(), 'zincgraph-installer-'));
}

describe('Phase 4 unified installer', () => {
  test('detects Claude Code project marker', () => {
    const root = fixture();
    mkdirSync(join(root, '.claude'));
    const targets = detectInstallTargets(root);
    expect(targets.find((target) => target.agent === 'Claude Code')?.detected).toBe(true);
  });

  test('dry-run plan reports writes without touching disk', async () => {
    const root = fixture();
    mkdirSync(join(root, '.claude'));
    const result = await planZincgraphInstall({ projectPath: root, dependencies: { buildInstructions: async () => 'RULES' } });
    expect(result.dryRun).toBe(true);
    expect(result.writes).toHaveLength(2);
    expect(existsSync(join(root, '.mcp.json'))).toBe(false);
  });

  test('built-in planning skips undetected project-local agents', async () => {
    const root = fixture();
    const result = await planZincgraphInstall({
      projectPath: root,
      dependencies: { buildInstructions: async () => 'RULES' }
    });
    expect(result.selectedTargets).toHaveLength(0);
    expect(result.skippedTargets.every((target) => !target.detected)).toBe(true);
  });

  test('install --yes writes MCP config and behavior rules inside config root', async () => {
    const root = fixture();
    mkdirSync(join(root, '.claude'));
    const result = await installZincgraph({
      projectPath: root,
      yes: true,
      initializeProject: false,
      dependencies: { buildInstructions: async () => 'PONYTAIL RULES' }
    });
    expect(result.writtenPaths).toContain(join(root, '.mcp.json'));
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toContain('zincgraph');
    expect(readFileSync(join(root, '.claude/zincgraph-rules.md'), 'utf8')).toContain('PONYTAIL RULES');
  });

  test('non-interactive mode initializes and vectorizes through injectable dependencies', async () => {
    const root = fixture();
    mkdirSync(join(root, '.claude'));
    const events: string[] = [];
    const result = await installZincgraph({
      projectPath: root,
      yes: true,
      dependencies: {
        buildInstructions: async () => 'RULES',
        initProject: async () => { events.push('init'); },
        vectorize: async () => { events.push('vectorize'); }
      }
    });
    expect(events).toEqual(['init', 'vectorize']);
    expect(result.initialized).toBe(true);
    expect(result.vectorized).toBe(true);
  });

  test('explicit configRoot bounds writes', async () => {
    const project = fixture();
    const configRoot = join(project, 'config');
    mkdirSync(join(configRoot, '.claude'), { recursive: true });
    const result = await installZincgraph({
      projectPath: project,
      configRoot,
      yes: true,
      initializeProject: false,
      dependencies: { buildInstructions: async () => 'RULES' }
    });
    expect(result.writtenPaths.every((path) => path.startsWith(configRoot))).toBe(true);
  });

  test('rejects symlinked agent directories that would escape config root', async () => {
    const root = fixture();
    const outside = fixture();
    symlinkSync(outside, join(root, '.claude'), 'dir');

    await expect(installZincgraph({
      projectPath: root,
      yes: true,
      initializeProject: false,
      dependencies: { buildInstructions: async () => 'RULES' }
    })).rejects.toThrow(/symlink/);

    expect(existsSync(join(outside, 'zincgraph-rules.md'))).toBe(false);
    expect(existsSync(join(root, '.mcp.json'))).toBe(false);
  });

  test('rejects final MCP config symlink before writing', async () => {
    const root = fixture();
    const outside = fixture();
    mkdirSync(join(root, '.claude'));
    const outsideConfig = join(outside, 'mcp.json');
    writeFileSync(outsideConfig, '{}', 'utf8');
    symlinkSync(outsideConfig, join(root, '.mcp.json'));

    await expect(installZincgraph({
      projectPath: root,
      yes: true,
      initializeProject: false,
      dependencies: { buildInstructions: async () => 'RULES' }
    })).rejects.toThrow(/symlink/);
  });

  test('merges MCP config without deleting existing servers', async () => {
    const root = fixture();
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({
      mcpServers: {
        existing: {
          command: 'other-mcp'
        }
      },
      metadata: {
        keep: true
      }
    }, null, 2), 'utf8');

    await installZincgraph({
      projectPath: root,
      yes: true,
      initializeProject: false,
      dependencies: { buildInstructions: async () => 'RULES' }
    });

    const config = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { command: string; args?: string[]; cwd?: string }>;
      metadata: { keep: boolean };
    };
    expect(config.mcpServers.existing?.command).toBe('other-mcp');
    expect(config.mcpServers.zincgraph).toMatchObject({ command: 'zincgraph', args: ['mcp'], cwd: root });
    expect(config.metadata.keep).toBe(true);
  });

  test('malformed MCP config fails unless overwrite is explicit', async () => {
    const root = fixture();
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.mcp.json'), '{not-json', 'utf8');

    await expect(installZincgraph({
      projectPath: root,
      yes: true,
      initializeProject: false,
      dependencies: { buildInstructions: async () => 'RULES' }
    })).rejects.toThrow(/malformed/);

    await installZincgraph({
      projectPath: root,
      yes: true,
      overwrite: true,
      initializeProject: false,
      dependencies: { buildInstructions: async () => 'RULES' }
    });

    const config = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(config.mcpServers.zincgraph).toBeTruthy();
  });

  test('existing behavior rules conflict fails unless overwrite is explicit', async () => {
    const root = fixture();
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude/zincgraph-rules.md'), 'OLD RULES', 'utf8');

    await expect(installZincgraph({
      projectPath: root,
      yes: true,
      initializeProject: false,
      dependencies: { buildInstructions: async () => 'NEW RULES' }
    })).rejects.toThrow(/behavior rules/);

    await installZincgraph({
      projectPath: root,
      yes: true,
      overwrite: true,
      initializeProject: false,
      dependencies: { buildInstructions: async () => 'NEW RULES' }
    });

    expect(readFileSync(join(root, '.claude/zincgraph-rules.md'), 'utf8')).toContain('NEW RULES');
  });

  test('plan rejects unsafe injected MCP and rules paths before returning writes', async () => {
    const root = fixture();
    const unsafeMcp: AgentInstallTargetInput = {
      agent: 'Codex',
      markerPath: '.custom-agent',
      mcpConfigPath: '../escape/mcp.json',
      rulesPath: '.custom/rules.md'
    };
    const unsafeRules: AgentInstallTargetInput = {
      agent: 'Codex',
      markerPath: '.custom-agent',
      mcpConfigPath: '.custom/mcp.json',
      rulesPath: '../escape/rules.md'
    };

    await expect(planZincgraphInstall({
      projectPath: root,
      targets: [unsafeMcp],
      dependencies: { buildInstructions: async () => 'RULES' }
    })).rejects.toThrow(/outside config root/);
    await expect(planZincgraphInstall({
      projectPath: root,
      targets: [unsafeRules],
      dependencies: { buildInstructions: async () => 'RULES' }
    })).rejects.toThrow(/outside config root/);
  });

  test('plan rejects absolute injected paths outside config root', async () => {
    const root = fixture();
    const outside = fixture();
    await expect(planZincgraphInstall({
      projectPath: root,
      targets: [{
        agent: 'Codex',
        markerPath: '.custom-agent',
        mcpConfigPath: join(outside, 'mcp.json'),
        rulesPath: '.custom/rules.md'
      }],
      dependencies: { buildInstructions: async () => 'RULES' }
    })).rejects.toThrow(/outside config root/);
  });

  test('plan rejects symlinked path components without creating directories or files', async () => {
    const root = fixture();
    const outside = fixture();
    symlinkSync(outside, join(root, 'linked'), 'dir');

    await expect(planZincgraphInstall({
      projectPath: root,
      targets: [{
        agent: 'Codex',
        markerPath: '.custom-agent',
        mcpConfigPath: '.safe/mcp.json',
        rulesPath: 'linked/nested/rules.md'
      }],
      dependencies: { buildInstructions: async () => 'RULES' }
    })).rejects.toThrow(/symlink/);

    expect(existsSync(join(root, '.safe'))).toBe(false);
    expect(existsSync(join(outside, 'nested'))).toBe(false);
  });

  test('plan rejects final file symlinks before returning writes', async () => {
    const root = fixture();
    const outside = fixture();
    mkdirSync(join(root, '.custom'));
    const outsideConfig = join(outside, 'mcp.json');
    writeFileSync(outsideConfig, '{}', 'utf8');
    symlinkSync(outsideConfig, join(root, '.custom/mcp.json'));

    await expect(planZincgraphInstall({
      projectPath: root,
      targets: [{
        agent: 'Codex',
        markerPath: '.custom-agent',
        mcpConfigPath: '.custom/mcp.json',
        rulesPath: '.custom/rules.md'
      }],
      dependencies: { buildInstructions: async () => 'RULES' }
    })).rejects.toThrow(/symlink/);

    expect(readFileSync(outsideConfig, 'utf8')).toBe('{}');
  });

  test('plan and install reject dangling final symlinks before outside target creation', async () => {
    const planRoot = fixture();
    const planOutside = fixture();
    mkdirSync(join(planRoot, '.custom'));
    const planOutsideConfig = join(planOutside, 'missing-mcp.json');
    symlinkSync(planOutsideConfig, join(planRoot, '.custom/mcp.json'));

    await expect(planZincgraphInstall({
      projectPath: planRoot,
      targets: [{
        agent: 'Codex',
        markerPath: '.custom-agent',
        mcpConfigPath: '.custom/mcp.json',
        rulesPath: '.custom/rules.md'
      }],
      dependencies: { buildInstructions: async () => 'RULES' }
    })).rejects.toThrow(/symlink/);
    expect(existsSync(planOutsideConfig)).toBe(false);

    const installRoot = fixture();
    const installOutside = fixture();
    mkdirSync(join(installRoot, '.custom'));
    const installOutsideConfig = join(installOutside, 'missing-mcp.json');
    symlinkSync(installOutsideConfig, join(installRoot, '.custom/mcp.json'));

    await expect(installZincgraph({
      projectPath: installRoot,
      yes: true,
      initializeProject: false,
      targets: [{
        agent: 'Codex',
        markerPath: '.custom-agent',
        mcpConfigPath: '.custom/mcp.json',
        rulesPath: '.custom/rules.md'
      }],
      dependencies: { buildInstructions: async () => 'RULES' }
    })).rejects.toThrow(/symlink/);
    expect(existsSync(installOutsideConfig)).toBe(false);
  });

  test('plan rejects configRoot with symlinked ancestor without side effects', async () => {
    const project = fixture();
    const outside = fixture();
    symlinkSync(outside, join(project, 'linked'), 'dir');
    const configRoot = join(project, 'linked/config');

    await expect(planZincgraphInstall({
      projectPath: project,
      configRoot,
      targets: [{
        agent: 'Codex',
        markerPath: '.custom-agent',
        mcpConfigPath: '.custom/mcp.json',
        rulesPath: '.custom/rules.md'
      }],
      dependencies: { buildInstructions: async () => 'RULES' }
    })).rejects.toThrow(/symlink/);

    expect(existsSync(join(outside, 'config'))).toBe(false);
  });

  test('install rejects configRoot with symlinked ancestor before mkdir or writes', async () => {
    const project = fixture();
    const outside = fixture();
    symlinkSync(outside, join(project, 'linked'), 'dir');
    const configRoot = join(project, 'linked/config');

    await expect(installZincgraph({
      projectPath: project,
      configRoot,
      yes: true,
      initializeProject: false,
      targets: [{
        agent: 'Codex',
        markerPath: '.custom-agent',
        mcpConfigPath: '.custom/mcp.json',
        rulesPath: '.custom/rules.md'
      }],
      dependencies: { buildInstructions: async () => 'RULES' }
    })).rejects.toThrow(/symlink/);

    expect(existsSync(join(outside, 'config'))).toBe(false);
    expect(existsSync(join(outside, 'config/.custom/mcp.json'))).toBe(false);
  });

  test('unsafe configRoot is rejected even when no targets are selected', async () => {
    const project = fixture();
    const outside = fixture();
    symlinkSync(outside, join(project, 'linked'), 'dir');
    const configRoot = join(project, 'linked/config');
    const events: string[] = [];

    await expect(planZincgraphInstall({
      projectPath: project,
      configRoot,
      dependencies: { buildInstructions: async () => { events.push('instructions'); return 'RULES'; } }
    })).rejects.toThrow(/symlink/);

    await expect(installZincgraph({
      projectPath: project,
      configRoot,
      yes: true,
      dependencies: {
        buildInstructions: async () => { events.push('instructions'); return 'RULES'; },
        initProject: async () => { events.push('init'); },
        vectorize: async () => { events.push('vectorize'); }
      }
    })).rejects.toThrow(/symlink/);

    expect(events).toEqual([]);
    expect(existsSync(join(outside, 'config'))).toBe(false);
  });

  test('safe missing configRoot still plans and installs inside config root', async () => {
    const project = fixture();
    const configRoot = join(project, 'config');
    const target: AgentInstallTargetInput = {
      agent: 'Codex',
      markerPath: '.custom-agent',
      mcpConfigPath: '.custom/mcp.json',
      rulesPath: '.custom/rules.md'
    };

    const plan = await planZincgraphInstall({
      projectPath: project,
      configRoot,
      targets: [target],
      dependencies: { buildInstructions: async () => 'RULES' }
    });
    expect(plan.writes.map((write) => write.path)).toEqual([
      join(configRoot, '.custom/mcp.json'),
      join(configRoot, '.custom/rules.md')
    ]);
    expect(existsSync(configRoot)).toBe(false);

    const result = await installZincgraph({
      projectPath: project,
      configRoot,
      yes: true,
      initializeProject: false,
      targets: [target],
      dependencies: { buildInstructions: async () => 'RULES' }
    });
    expect(result.writtenPaths).toEqual([
      join(configRoot, '.custom/mcp.json'),
      join(configRoot, '.custom/rules.md')
    ]);
    expect(existsSync(join(configRoot, '.custom/mcp.json'))).toBe(true);
  });

  test('public options expose overwrite and injected targets for planning and install', async () => {
    const root = fixture();
    const injectedTarget: AgentInstallTargetInput = {
      agent: 'Codex',
      markerPath: '.custom-agent',
      mcpConfigPath: '.custom/mcp.json',
      rulesPath: '.custom/rules.md'
    };
    const options: UnifiedInstallOptions = {
      projectPath: root,
      targets: [injectedTarget],
      overwrite: true,
      initializeProject: false,
      dependencies: { buildInstructions: async () => 'INJECTED RULES' }
    };

    const plan = await planZincgraphInstall(options);
    expect(plan.selectedTargets).toHaveLength(1);
    expect(plan.selectedTargets[0]?.detected).toBe(true);
    expect(plan.writes.map((write) => write.path)).toEqual([
      join(root, '.custom/mcp.json'),
      join(root, '.custom/rules.md')
    ]);

    const result = await installZincgraph({ ...options, yes: true });
    expect(result.writtenPaths).toEqual([
      join(root, '.custom/mcp.json'),
      join(root, '.custom/rules.md')
    ]);
    expect(readFileSync(join(root, '.custom/rules.md'), 'utf8')).toContain('INJECTED RULES');
  });

  test('injected target selection does not depend on detected state', async () => {
    const root = fixture();
    const rootExportTarget: RootAgentInstallTargetInput = {
      agent: 'Gemini',
      markerPath: '.gemini-custom',
      mcpConfigPath: '.gemini-custom/mcp.json',
      rulesPath: '.gemini-custom/rules.md'
    };
    const falseDetectedTarget: AgentInstallTargetInput = {
      ...rootExportTarget,
      detected: false
    };
    const dependencies = { buildInstructions: async () => 'RULES' };

    const defaultPlan = await planZincgraphInstall({ projectPath: root, targets: [rootExportTarget], dependencies });
    expect(defaultPlan.selectedTargets.map((target) => target.agent)).toEqual(['Gemini']);
    expect(defaultPlan.selectedTargets[0]?.detected).toBe(true);

    const falseDetectedPlan = await planZincgraphInstall({ projectPath: root, targets: [falseDetectedTarget], dependencies });
    expect(falseDetectedPlan.selectedTargets.map((target) => target.agent)).toEqual(['Gemini']);
    expect(falseDetectedPlan.selectedTargets[0]?.detected).toBe(false);

    const includedPlan = await planZincgraphInstall({
      projectPath: root,
      targets: [falseDetectedTarget],
      agents: ['Gemini'],
      dependencies
    });
    expect(includedPlan.selectedTargets.map((target) => target.agent)).toEqual(['Gemini']);

    const excludedPlan = await planZincgraphInstall({
      projectPath: root,
      targets: [falseDetectedTarget],
      agents: ['Codex'],
      dependencies
    });
    expect(excludedPlan.selectedTargets).toHaveLength(0);
    expect(excludedPlan.skippedTargets.map((target) => target.agent)).toEqual(['Gemini']);
  });
});
