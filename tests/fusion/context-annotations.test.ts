import { describe, expect, test } from 'vitest';

import { TopoSemanticQueryEngine } from '../../src/fusion/query-engine.js';
import type { QueryEngineDependencies } from '../../src/fusion/query-engine.js';
import type { FreshnessSnapshot } from '../../src/freshness/freshness-gate.js';
import type { BehaviorAnnotation } from '../../src/fusion/context-budget.js';
import type { CodeGraphSnapshot, VectorDocument } from '../../src/vector/code-to-vectors.js';
import { DEFAULT_CHUNKER_VERSION } from '../../src/vector/chunker.js';

const snapshot: CodeGraphSnapshot = {
  projectPath: '/tmp/project',
  files: [
    { path: 'src/clone.ts', contentHash: 'clone', language: 'typescript' },
    { path: 'src/dead.ts', contentHash: 'dead', language: 'typescript' },
    { path: 'src/caller.ts', contentHash: 'caller', language: 'typescript' },
    { path: 'src/plain.ts', contentHash: 'plain', language: 'typescript' }
  ],
  nodes: [
    { id: 'clone', kind: 'function', name: 'cloneUser', qualifiedName: 'src/clone.ts::cloneUser', filePath: 'src/clone.ts', language: 'typescript', signature: 'function cloneUser(): User', docstring: 'uses lodash cloneDeep', calls: [] },
    { id: 'dead', kind: 'function', name: 'deadHelper', qualifiedName: 'src/dead.ts::deadHelper', filePath: 'src/dead.ts', language: 'typescript', signature: 'function deadHelper(): void', calls: [] },
    { id: 'caller', kind: 'function', name: 'caller', qualifiedName: 'src/caller.ts::caller', filePath: 'src/caller.ts', language: 'typescript', signature: 'function caller(): void', calls: ['plainHelper'] },
    { id: 'plain', kind: 'function', name: 'plainHelper', qualifiedName: 'src/plain.ts::plainHelper', filePath: 'src/plain.ts', language: 'typescript', signature: 'function plainHelper(): void', calls: [] }
  ]
};

function doc(nodeId: string, content: string): { id: string; nodeId: string; filePath: string; embeddingProfile: string; chunkerVersion: string; json: VectorDocument } {
  const node = snapshot.nodes.find((item) => item.id === nodeId)!;
  return {
    id: nodeId,
    nodeId,
    filePath: node.filePath,
    embeddingProfile: 'local-token-v1:64',
    chunkerVersion: DEFAULT_CHUNKER_VERSION,
    json: {
      id: nodeId,
      nodeId,
      filePath: node.filePath,
      language: node.language,
      kind: node.kind,
      qualifiedName: node.qualifiedName,
      content,
      contentHash: nodeId,
      chunkerVersion: DEFAULT_CHUNKER_VERSION,
      tokens: content.split(/\s+/),
      contentSparse: {},
      embedding: []
    }
  };
}

const docs = [
  doc('clone', 'function cloneUser() { return cloneDeep(user); } lodash cloneDeep'),
  doc('dead', 'function deadHelper() {}'),
  doc('plain', 'function plainHelper() {}')
];

const freshness: FreshnessSnapshot = { fresh: 3, pending: 0, stale: 0, failed: 0, total: 3, isFresh: true, warnings: [], entries: [] };

function engine(annotateCandidates?: QueryEngineDependencies['annotateCandidates']): TopoSemanticQueryEngine {
  return new TopoSemanticQueryEngine('/tmp/project', {
    dependencies: {
      readSnapshot: () => snapshot,
      vectorSearch: async (_project, _text, _topk) => [],
      listVectorDocuments: () => docs,
      readFreshness: () => freshness,
      ...(annotateCandidates ? { annotateCandidates } : {})
    }
  });
}

describe('Phase 3 context behavior annotations', () => {
  test('adds stdlib replacement annotations for lodash cloneDeep content', async () => {
    const capsule = await engine().query('cloneDeep', { topk: 5 });
    const annotation = capsule.nodes.find((node) => node.nodeId === 'clone')?.annotations?.find((item) => item.type === 'stdlib-replacement');
    expect(annotation?.message).toContain('structuredClone');
  });

  test('does not infer dead-code annotations by default from zero reverse callers', async () => {
    const capsule = await engine().query('deadHelper', { topk: 5 });
    expect(capsule.nodes.find((node) => node.nodeId === 'dead')?.annotations).toBeUndefined();
  });

  test('accepts semantic duplicate annotations from injected provider', async () => {
    const duplicate: BehaviorAnnotation = {
      type: 'semantic-duplicate',
      severity: 'suggestion',
      message: 'Semantic duplicate of src/date.ts::formatDateTime',
      evidence: { duplicateOf: 'src/date.ts::formatDateTime' }
    };
    const capsule = await engine(() => ({ plain: [duplicate] })).query('plainHelper', { topk: 5 });
    expect(capsule.nodes.find((node) => node.nodeId === 'plain')?.annotations?.[0]).toMatchObject({ type: 'semantic-duplicate' });
  });

  test('accepts array-style annotation provider output', async () => {
    const injected: BehaviorAnnotation = {
      type: 'dead-code',
      severity: 'info',
      message: 'Injected no-callers evidence',
      evidence: { callerCount: 0 }
    };
    const capsule = await engine(() => [{ nodeId: 'dead', annotations: [injected] }]).query('deadHelper', { topk: 5 });
    expect(capsule.nodes.find((node) => node.nodeId === 'dead')?.annotations?.[0]).toMatchObject({ type: 'dead-code' });
  });

  test('default provider does not emit semantic duplicate annotations', async () => {
    const capsule = await engine().query('plainHelper', { topk: 5 });
    expect(capsule.nodes.flatMap((node) => node.annotations ?? []).some((item) => item.type === 'semantic-duplicate')).toBe(false);
  });

  test('does not annotate plain called nodes without provider findings', async () => {
    const capsule = await engine().query('plainHelper', { topk: 5 });
    expect(capsule.nodes.find((node) => node.nodeId === 'plain')?.annotations).toBeUndefined();
  });

  test('context budget carries annotations onto candidate excerpts', async () => {
    const capsule = await engine().query('cloneDeep', { topk: 5 });
    const excerpt = capsule.context.blocks.flatMap((block) => block.candidates).find((candidate) => candidate.nodeId === 'clone');
    expect(excerpt?.annotations?.some((item) => item.type === 'stdlib-replacement')).toBe(true);
  });
});
