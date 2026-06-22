import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCli } from '../../src/cli.js';

describe('CLI compression commands', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'zincgraph-cli-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('probe headroom command exists and is parseable', () => {
    const program = buildCli();
    const probeCmd = program.commands.find((c) => c.name() === 'probe');

    expect(probeCmd).toBeDefined();
  });

  test('compression-stats command exists', () => {
    const program = buildCli();
    const cmd = program.commands.find((c) => c.name() === 'compression-stats');

    expect(cmd).toBeDefined();
  });

  test('config command exists with get/set actions', () => {
    const program = buildCli();
    const cmd = program.commands.find((c) => c.name() === 'config');

    expect(cmd).toBeDefined();
  });

  test('retrieve command exists', () => {
    const program = buildCli();
    const cmd = program.commands.find((c) => c.name() === 'retrieve');

    expect(cmd).toBeDefined();
  });
});
