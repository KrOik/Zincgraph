import { describe, expect, test } from 'vitest';

import {
  buildPonytailInstructions,
  createPonytailMcpDescriptor,
  getPonytailAgentAdapters,
  runPonytailReview
} from '../../src/bridge/ponytailAdapter.js';

describe('Ponytail Phase 0 adapter', () => {
  test('builds full instructions with the six-step decision ladder', async () => {
    const instructions = await buildPonytailInstructions('full');

    expect(instructions).toContain('Does this need to exist');
    expect(instructions).toContain('Stdlib does it');
    expect(instructions).toContain('Native platform feature');
    expect(instructions).toContain('Already-installed dependency');
    expect(instructions).toContain('Can it be one line');
    expect(instructions).toContain('minimum code that works');
  });

  test('off mode stays empty for Zincgraph injection', async () => {
    await expect(buildPonytailInstructions('off')).resolves.toBe('');
  });

  test('ultra mode carries deletion-before-addition language', async () => {
    const instructions = await buildPonytailInstructions('ultra');
    expect(instructions).toMatch(/Deletion before addition/i);
  });

  test('describes MCP composition surface', () => {
    expect(createPonytailMcpDescriptor()).toEqual({
      name: 'ponytail',
      tools: ['ponytail_instructions'],
      prompts: ['ponytail']
    });
  });

  test('finds shipped agent adapter formats', () => {
    const adapters = getPonytailAgentAdapters();
    expect(adapters.map((adapter) => adapter.agent)).toEqual([
      'Claude',
      'Codex',
      'Cursor',
      'Copilot',
      'OpenCode'
    ]);
    expect(adapters.find((adapter) => adapter.agent === 'Copilot')?.exists).toBe(true);
  });

  test('delegates review command metadata', () => {
    const delegation = runPonytailReview('.', { diff: true });

    expect(delegation.command).toBe('ponytail-review');
    expect(delegation.marker).toContain('Ponytail delegated');
    expect(delegation.prompt).toContain('over-engineering');
  });
});
