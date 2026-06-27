import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  LocalTokenEmbedding,
  NetworkPolicy,
  OpenAIEmbedding,
  QwenEmbedding,
  HTTPEmbedding,
  RemoteProviderBlockedError,
  SiliconFlowEmbedding,
  cosineSimilarity,
  getAdapter,
  resolveActiveEmbedding,
  updateEmbeddingMetadataCache,
  tokenizeCodeText
} from '../../src/vector/embedding/index.js';
import { FusionStore } from '../../src/freshness/fusion-store.js';

const tempProjects: string[] = [];
const servers: Server[] = [];
const fusionStores: FusionStore[] = [];

async function dense(text: string): Promise<number[]> {
  const [result] = await new LocalTokenEmbedding().embed([text]);
  return result?.dense ?? [];
}

function tempProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'zincgraph-embedding-test-'));
  tempProjects.push(project);
  return project;
}

async function startEmbeddingServer(
  handler: (texts: string[]) => number[][]
): Promise<{ url: string; requests: string[][] }> {
  const requests: string[][] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input?: string[] };
    const texts = payload.input ?? [];
    requests.push(texts);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      data: handler(texts).map((embedding) => ({ embedding }))
    }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('missing embedding server address');
  }
  return { url: `http://127.0.0.1:${address.port}/embeddings`, requests };
}

afterEach(async () => {
  for (const store of fusionStores.splice(0)) {
    store.close();
  }
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  for (const project of tempProjects.splice(0)) {
    rmSync(project, { force: true, recursive: true });
  }
});

function trackedFusionStore(project: string): FusionStore {
  const store = new FusionStore(project);
  fusionStores.push(store);
  return store;
}

describe('Phase 1 LocalTokenEmbedding', () => {
  test('splits camelCase identifiers', () => {
    expect(tokenizeCodeText('authenticateUser')).toEqual(expect.arrayContaining(['authenticate', 'user']));
  });

  test('adds simple morphological stems', () => {
    expect(tokenizeCodeText('validating tokens')).toEqual(expect.arrayContaining(['validat', 'token']));
  });

  test('expands query terms without changing default tokenization', () => {
    const expanded = tokenizeCodeText('priority ordering when results are mixed', { expandSynonyms: true });
    expect(expanded).toEqual(expect.arrayContaining([
      'priority',
      'ranking',
      'order',
      'result',
      'candidate',
      'fusion',
      'intent',
      'parse',
      'query',
      'route',
      'router'
    ]));
    expect(tokenizeCodeText('priority ordering when results are mixed')).not.toEqual(expect.arrayContaining(['ranking']));
  });

  test('produces sparse and dense vectors with token metadata', async () => {
    const [result] = await new LocalTokenEmbedding().embed(['authenticateUser']);
    expect(result?.tokens).toEqual(expect.arrayContaining(['authenticate', 'user']));
    expect(Object.keys(result?.sparse ?? {}).length).toBeGreaterThan(0);
    expect(result?.dense).toHaveLength(64);
  });

  test('similar code phrases score higher than unrelated phrases', async () => {
    const similar = cosineSimilarity(await dense('token validation handler'), await dense('validate tokens request'));
    const unrelated = cosineSimilarity(await dense('token validation handler'), await dense('render graph adapter'));
    expect(similar).toBeGreaterThan(unrelated);
  });

  test('registry returns local adapter by default', () => {
    expect(getAdapter('local')).toBeInstanceOf(LocalTokenEmbedding);
  });

  test('remote adapters are blocked without explicit opt-in', async () => {
    await expect(new OpenAIEmbedding(NetworkPolicy.disabled()).embed(['x'])).rejects.toBeInstanceOf(RemoteProviderBlockedError);
    await expect(new QwenEmbedding(NetworkPolicy.disabled()).embed(['x'])).rejects.toBeInstanceOf(RemoteProviderBlockedError);
    await expect(new HTTPEmbedding(NetworkPolicy.disabled()).embed(['x'])).rejects.toBeInstanceOf(RemoteProviderBlockedError);
    await expect(new SiliconFlowEmbedding(NetworkPolicy.disabled()).embed(['x'])).rejects.toBeInstanceOf(RemoteProviderBlockedError);
  });

  test('HTTPEmbedding succeeds against a fake embedding endpoint', async () => {
    const server = await startEmbeddingServer((texts) => texts.map((_text, index) => [index + 1, 0, 0]));
    const adapter = new HTTPEmbedding(NetworkPolicy.enabledFor(['http']), {
      endpoint: server.url,
      profile: 'http:test-v1'
    });

    const results = await adapter.embed(['alpha', 'beta']);
    expect(server.requests).toEqual([['alpha', 'beta']]);
    expect(results[0]?.dense).toEqual([1, 0, 0]);
    expect(results[1]?.dense).toEqual([2, 0, 0]);
    expect(results[0]?.tokens).toContain('alpha');
    expect(Object.keys(results[0]?.sparse ?? {}).length).toBeGreaterThan(0);
  });

  test('shared resolver reads project metadata for provider/profile configuration', async () => {
    const project = tempProject();
    const server = await startEmbeddingServer(() => [[0.25, 0.5, 0.75]]);
    const store = trackedFusionStore(project);
    store.setMetadata('embedding.provider', 'http');
    store.setMetadata('embedding.profile', 'repo-http-v1');
    store.setMetadata('embedding.network', 'enabled');
    store.setMetadata('embedding.http.endpoint', server.url);
    store.close();

    const resolved = resolveActiveEmbedding(project);
    const [result] = await resolved.adapter.embed(['semantic foundation']);

    expect(resolved.provider).toBe('http');
    expect(resolved.profile).toBe('repo-http-v1');
    expect(result?.dense).toEqual([0.25, 0.5, 0.75]);
  });

  test('shared resolver prefers sqlite metadata over a stale sidecar mirror', async () => {
    const project = tempProject();
    const server = await startEmbeddingServer(() => [[0.9, 0.1, 0.4]]);
    const store = trackedFusionStore(project);
    store.setMetadata('embedding.provider', 'http');
    store.setMetadata('embedding.profile', 'repo-http-v2');
    store.setMetadata('embedding.network', 'enabled');
    store.setMetadata('embedding.http.endpoint', server.url);
    store.close();
    updateEmbeddingMetadataCache(project, {
      'embedding.provider': 'local',
      'embedding.profile': 'stale-local-v1'
    });

    const resolved = resolveActiveEmbedding(project);
    const [result] = await resolved.adapter.embed(['semantic foundation']);

    expect(resolved.provider).toBe('http');
    expect(resolved.profile).toBe('repo-http-v2');
    expect(result?.dense).toEqual([0.9, 0.1, 0.4]);
  });

  test('SiliconFlowEmbedding succeeds against a fake embedding endpoint', async () => {
    const server = await startEmbeddingServer((texts) => texts.map((_text, index) => [index + 1, 1, 0]));
    const adapter = new SiliconFlowEmbedding(NetworkPolicy.enabledFor(['siliconflow']), {
      apiKey: 'test-key',
      baseUrl: server.url,
      model: 'BAAI/bge-m3',
      profile: 'siliconflow:BAAI/bge-m3'
    });

    const results = await adapter.embed(['alpha', 'beta']);
    expect(server.requests).toEqual([['alpha', 'beta']]);
    expect(results[0]?.dense).toEqual([1, 1, 0]);
    expect(results[1]?.dense).toEqual([2, 1, 0]);
  });

  test('shared resolver loads a project .env file for SiliconFlow credentials', async () => {
    const project = tempProject();
    const server = await startEmbeddingServer(() => [[0.4, 0.5, 0.6]]);
    const previousSilicon = process.env.silicon;
    const previousProfile = process.env.ZINCGRAPH_EMBEDDING_PROVIDER;
    delete process.env.silicon;
    delete process.env.ZINCGRAPH_EMBEDDING_PROVIDER;
    try {
      writeFileSync(join(project, '.env'), 'silicon=env-test-key\n');
      const store = trackedFusionStore(project);
      store.setMetadata('embedding.provider', 'siliconflow');
      store.setMetadata('embedding.network', 'enabled');
      store.setMetadata('embedding.siliconflow.baseUrl', server.url);
      store.setMetadata('embedding.siliconflow.model', 'BAAI/bge-m3');

      const resolved = resolveActiveEmbedding(project);
      const [result] = await resolved.adapter.embed(['semantic foundation']);

      expect(resolved.provider).toBe('siliconflow');
      expect(resolved.profile).toBe('siliconflow:BAAI/bge-m3');
      expect(result?.dense).toEqual([0.4, 0.5, 0.6]);
    } finally {
      if (previousSilicon === undefined) {
        delete process.env.silicon;
      } else {
        process.env.silicon = previousSilicon;
      }
      if (previousProfile === undefined) {
        delete process.env.ZINCGRAPH_EMBEDDING_PROVIDER;
      } else {
        process.env.ZINCGRAPH_EMBEDDING_PROVIDER = previousProfile;
      }
    }
  });
});
