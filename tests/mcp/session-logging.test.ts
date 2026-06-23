import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createZincgraphToolRegistry } from '../../src/mcp/tool-registry.js';
import { CompressionFeedbackLoop } from '../../src/compression/feedback-loop.js';
import { FeedbackStore } from '../../src/compression/feedback-store.js';

describe('MCP session logging', () => {
  let tempDir: string;
  let store: FeedbackStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'zincgraph-session-'));
    store = new FeedbackStore({ projectPath: tempDir });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('records input, output, and duration for successful tool calls', async () => {
    const registry = createZincgraphToolRegistry({
      feedbackStore: store,
      runCodeGraphCli: (args) => ({ command: 'codegraph', args, status: 0, stdout: 'ok', stderr: '' })
    });

    const result = await registry.callTool('zincgraph_status', { project: tempDir, json: true });
    expect(result.isError).toBeUndefined();

    const logs = store.listSessionLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.toolName).toBe('zincgraph_status');
    expect(logs[0]?.input).toContain('"project"');
    expect(logs[0]?.output).toContain('ok');
    expect(logs[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(logs[0]?.error).toBe('');
  });

  test('records failures without dropping the dispatch attempt', async () => {
    const registry = createZincgraphToolRegistry({ feedbackStore: store });

    const result = await registry.callTool('zincgraph_dedup_check', { project: tempDir });
    expect(result.isError).toBe(true);

    const logs = store.listSessionLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.toolName).toBe('zincgraph_dedup_check');
    expect(logs[0]?.error).toContain('Missing required argument: describe');
  });

  test('zincgraph_retrieve keeps retrieval feedback intact', async () => {
    const loop = new CompressionFeedbackLoop({ store });
    loop.recordCompression({
      hash: 'hash-1',
      nodeId: 'node-1',
      source: 'graph',
      contentType: 'json',
      kind: 'function',
      compressedAt: Date.now()
    });

    const registry = createZincgraphToolRegistry({
      feedbackLoop: loop,
      feedbackStore: store,
      retrieveContent: async () => 'original content'
    });

    const result = await registry.callTool('zincgraph_retrieve', { hash: 'hash-1', query: 'auth' });
    expect(result.isError).toBeUndefined();
    expect(loop.recentRetrievals()).toHaveLength(1);
    expect(loop.recentRetrievals()[0]?.hash).toBe('hash-1');
    expect(loop.recentRetrievals()[0]?.queryContext).toBe('auth');
    expect(store.listSessionLogs()[0]?.output).toContain('retrieved content omitted');
    expect(store.listSessionLogs()[0]?.output).not.toContain('original content');
  }, 15000);

  test('redacts JSON and quoted secret values from session logs', async () => {
    const registry = createZincgraphToolRegistry({
      feedbackStore: store,
      compressContent: async () => ({
        compressed: '{"apiKey":"sk-secret-123","authorization":"Bearer token-456"}',
        tokensBefore: 20,
        tokensAfter: 8,
        hash: 'hash-secret'
      })
    });

    const result = await registry.callTool('zincgraph_compress', {
      project: tempDir,
      content: '{"apiKey":"sk-secret-123","authorization":"Bearer token-456"}',
      content_type: 'json',
      max_tokens: 20
    });

    expect(result.isError).toBeUndefined();

    const logs = store.listSessionLogs();
    expect(logs).toHaveLength(1);
    const log = logs[0];
    expect(log?.input).not.toContain('sk-secret-123');
    expect(log?.input).not.toContain('token-456');
    expect(log?.input).toContain('[REDACTED]');
    expect(log?.output).not.toContain('sk-secret-123');
    expect(log?.output).not.toContain('token-456');
    expect(log?.output).toContain('[REDACTED]');
  });

  test('redacts unquoted secret assignments from session logs', async () => {
    const registry = createZincgraphToolRegistry({
      feedbackStore: store,
      compressContent: async () => ({
        compressed: 'api_key=sk-secret-123 password=hunter2 token=abc123',
        tokensBefore: 20,
        tokensAfter: 8,
        hash: 'hash-secret-unquoted'
      })
    });

    const result = await registry.callTool('zincgraph_compress', {
      project: tempDir,
      content: 'api_key=sk-secret-123 password=hunter2 token=abc123',
      content_type: 'text',
      max_tokens: 20
    });

    expect(result.isError).toBeUndefined();

    const logs = store.listSessionLogs();
    expect(logs).toHaveLength(1);
    const log = logs[0];
    expect(log?.input).not.toContain('sk-secret-123');
    expect(log?.input).not.toContain('hunter2');
    expect(log?.input).not.toContain('abc123');
    expect(log?.input).toContain('[REDACTED]');
    expect(log?.output).not.toContain('sk-secret-123');
    expect(log?.output).not.toContain('hunter2');
    expect(log?.output).not.toContain('abc123');
    expect(log?.output).toContain('[REDACTED]');
  });
});
