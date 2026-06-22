import { describe, expect, test } from 'vitest';

import {
  LocalTokenEmbedding,
  NetworkPolicy,
  OpenAIEmbedding,
  QwenEmbedding,
  HTTPEmbedding,
  RemoteProviderBlockedError,
  cosineSimilarity,
  getAdapter,
  tokenizeCodeText
} from '../../src/vector/embedding/index.js';

async function dense(text: string): Promise<number[]> {
  const [result] = await new LocalTokenEmbedding().embed([text]);
  return result?.dense ?? [];
}

describe('Phase 1 LocalTokenEmbedding', () => {
  test('splits camelCase identifiers', () => {
    expect(tokenizeCodeText('authenticateUser')).toEqual(expect.arrayContaining(['authenticate', 'user']));
  });

  test('adds simple morphological stems', () => {
    expect(tokenizeCodeText('validating tokens')).toEqual(expect.arrayContaining(['validat', 'token']));
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
  });
});
