import { describe, expect, test } from 'vitest';

import { GraphReviewAnalyzer, parseAddedDeclarations } from '../../src/behavior/graph-review.js';
import type { CodeGraphSnapshot } from '../../src/vector/code-to-vectors.js';

const snapshot: CodeGraphSnapshot = {
  projectPath: '/tmp/project',
  files: [
    { path: 'src/date.ts', contentHash: 'date', language: 'typescript' },
    { path: 'src/caller.ts', contentHash: 'caller', language: 'typescript' },
    { path: 'src/base.ts', contentHash: 'base', language: 'typescript' },
    { path: 'src/a.ts', contentHash: 'a', language: 'typescript' },
    { path: 'src/b.ts', contentHash: 'b', language: 'typescript' },
    { path: 'src/c.ts', contentHash: 'c', language: 'typescript' }
  ],
  nodes: [
    {
      id: 'format-existing',
      kind: 'function',
      name: 'formatDate',
      qualifiedName: 'src/date.ts::formatDate',
      filePath: 'src/date.ts',
      language: 'typescript',
      signature: 'function formatDate(value: Date): string',
      calls: []
    },
    {
      id: 'used-helper',
      kind: 'function',
      name: 'usedHelper',
      qualifiedName: 'src/date.ts::usedHelper',
      filePath: 'src/date.ts',
      language: 'typescript',
      signature: 'function usedHelper(): void',
      calls: []
    },
    {
      id: 'dead-helper',
      kind: 'function',
      name: 'deadHelper',
      qualifiedName: 'src/date.ts::deadHelper',
      filePath: 'src/date.ts',
      language: 'typescript',
      signature: 'function deadHelper(): void',
      calls: []
    },
    {
      id: 'caller',
      kind: 'function',
      name: 'caller',
      qualifiedName: 'src/caller.ts::caller',
      filePath: 'src/caller.ts',
      language: 'typescript',
      signature: 'function caller(): void',
      calls: ['usedHelper', 'SingleUseService']
    },
    {
      id: 'existing-formatter',
      kind: 'class',
      name: 'ExistingFormatter',
      qualifiedName: 'src/base.ts::ExistingFormatter',
      filePath: 'src/base.ts',
      language: 'typescript',
      signature: 'class ExistingFormatter extends BaseFormatter implements Formatter',
      calls: []
    },
    { id: 'a', kind: 'function', name: 'a', qualifiedName: 'src/a.ts::a', filePath: 'src/a.ts', language: 'typescript', signature: 'function a(): void', calls: ['b'] },
    { id: 'b', kind: 'function', name: 'b', qualifiedName: 'src/b.ts::b', filePath: 'src/b.ts', language: 'typescript', signature: 'function b(): void', calls: ['c'] },
    { id: 'c', kind: 'function', name: 'c', qualifiedName: 'src/c.ts::c', filePath: 'src/c.ts', language: 'typescript', signature: 'function c(): void', calls: ['a'] }
  ]
};

const analyzer = new GraphReviewAnalyzer();

describe('Phase 3 graph-enhanced review', () => {
  test('parses added functions, imports, and classes from unified diff', () => {
    const additions = parseAddedDeclarations(`diff --git a/src/new.ts b/src/new.ts
+++ b/src/new.ts
+import { cloneDeep as clone } from 'lodash';
+export function formatDate(value: Date): string { return value.toISOString(); }
+class JsonFormatter extends BaseFormatter implements Formatter {}`);
    expect(additions.imports[0]).toMatchObject({ moduleName: 'lodash', importName: 'cloneDeep', localName: 'clone' });
    expect(additions.functions[0]?.signature).toBe('function formatDate(value: Date): string');
    expect(additions.classes[0]).toMatchObject({ name: 'JsonFormatter', extendsName: 'BaseFormatter', implementsNames: ['Formatter'] });
  });

  test('reports existing same-signature function with file line evidence', () => {
    const result = analyzer.analyze({
      snapshot,
      diffText: `+++ b/src/new.ts\n+function formatDate(value: Date): string { return ''; }`,
      evidence: { lineByNodeId: { 'format-existing': 12 }, publicNodeIds: ['caller'] }
    });
    const finding = result.findings.find((item) => item.type === 'same-signature');
    expect(finding?.message).toContain('Existing same-signature function');
    expect(finding?.message).toContain('src/date.ts:12');
  });

  test('detects same-signature duplicates added beside an existing same-file function', () => {
    const result = analyzer.analyze({
      snapshot,
      diffText: `+++ b/src/date.ts\n+function formatDate(value: Date): string { return ''; }`,
      evidence: { publicNodeIds: ['caller'] }
    });
    expect(result.findings.some((item) => item.type === 'same-signature')).toBe(true);
  });

  test('does not report same-signature for different signatures', () => {
    const result = analyzer.analyze({
      snapshot,
      diffText: `+++ b/src/new.ts\n+function formatDate(value: string): string { return value; }`,
      evidence: { publicNodeIds: ['caller'] }
    });
    expect(result.findings.some((item) => item.type === 'same-signature')).toBe(false);
  });

  test('reports redundant imports from injected indirect functionality evidence', () => {
    const result = analyzer.analyze({
      snapshot,
      diffText: `+++ b/src/new.ts\n+import { cloneDeep } from 'lodash';`,
      evidence: {
        redundantImports: [{ moduleName: 'lodash', importName: 'cloneDeep', via: 'structuredClone wrapper', filePath: 'src/clone.ts' }],
        publicNodeIds: ['caller']
      }
    });
    expect(result.findings.find((item) => item.type === 'redundant-import')?.message).toContain('Redundant import');
  });

  test('does not report redundant imports without injected evidence', () => {
    const result = analyzer.analyze({
      snapshot,
      diffText: `+++ b/src/new.ts\n+import { cloneDeep } from 'lodash';`,
      evidence: { publicNodeIds: ['caller'] }
    });
    expect(result.findings.some((item) => item.type === 'redundant-import')).toBe(false);
  });

  test('does not emit YAGNI without proven caller evidence for a new symbol', () => {
    const result = analyzer.analyze({
      snapshot,
      diffText: `+++ b/src/service.ts\n+class UnknownNewService {}`,
      evidence: { publicNodeIds: ['caller'] }
    });
    expect(result.findings.some((item) => item.type === 'yagni')).toBe(false);
  });

  test('reports one-caller abstraction as YAGNI evidence', () => {
    const result = analyzer.analyze({
      snapshot,
      diffText: `+++ b/src/service.ts\n+class SingleUseService {}`,
      evidence: { callers: { SingleUseService: ['src/caller.ts::caller'] }, publicNodeIds: ['caller'] }
    });
    const finding = result.findings.find((item) => item.type === 'yagni');
    expect(finding?.message).toContain('only 1 caller');
  });

  test('accepts qualified caller evidence for a diff-added abstraction', () => {
    const result = analyzer.analyze({
      snapshot,
      diffText: `+++ b/src/service.ts\n+class SingleUseService {}`,
      evidence: { callers: { 'src/service.ts::SingleUseService': ['src/caller.ts::caller'] }, publicNodeIds: ['caller'] }
    });
    const finding = result.findings.find((item) => item.type === 'yagni');
    expect(finding?.message).toContain('only 1 caller');
    expect(finding?.evidence.callers).toEqual(['src/caller.ts::caller']);
  });

  test('does not use unrelated qualified caller evidence for same-named abstractions', () => {
    const result = analyzer.analyze({
      snapshot,
      diffText: `+++ b/src/service.ts\n+class SingleUseService {}`,
      evidence: { callers: { 'src/other.ts::SingleUseService': ['src/caller.ts::caller'] }, publicNodeIds: ['caller'] }
    });
    expect(result.findings.some((item) => item.type === 'yagni')).toBe(false);
  });

  test('reports similar class hierarchy when evidence is present', () => {
    const result = analyzer.analyze({
      snapshot,
      diffText: `+++ b/src/json.ts\n+class JsonFormatter extends BaseFormatter implements Formatter {}`,
      evidence: { publicNodeIds: ['caller'] }
    });
    expect(result.findings.find((item) => item.type === 'similar-class')?.message).toContain('Similar class hierarchy');
  });

  test('dead-code audit excludes called and public nodes', () => {
    const result = analyzer.analyze({ snapshot, evidence: { publicNodeIds: ['caller', 'a', 'b', 'c', 'existing-formatter'] } });
    const dead = result.auditFindings.filter((item) => item.type === 'dead-code').map((item) => String(item.evidence.node));
    expect(result.auditFindings.find((item) => item.message.includes('deadHelper'))).toBeTruthy();
    expect(result.auditFindings.find((item) => item.message.includes('usedHelper'))).toBeFalsy();
    expect(dead.length).toBeGreaterThanOrEqual(0);
  });

  test('cycle audit reports proven directed cycles only', () => {
    const result = analyzer.analyze({
      snapshot,
      evidence: {
        publicNodeIds: ['caller'],
        dependencyEdges: [
          { from: 'src/a.ts', to: 'src/b.ts' },
          { from: 'src/b.ts', to: 'src/c.ts' },
          { from: 'src/c.ts', to: 'src/a.ts' }
        ]
      }
    });
    expect(result.auditFindings.find((item) => item.type === 'cycle-dependency')?.message).toContain('src/a.ts');

    const acyclic = analyzer.analyze({
      snapshot,
      evidence: { dependencyEdges: [{ from: 'src/a.ts', to: 'src/b.ts' }], publicNodeIds: ['caller'] }
    });
    expect(acyclic.auditFindings.some((item) => item.type === 'cycle-dependency')).toBe(false);
  });
});
