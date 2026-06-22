import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  createCollection,
  dropCollection,
  getCollectionPath,
  getCollectionSchemaFieldNames,
  openCollection
} from '../../src/vector/collection-manager.js';
import { toZvecDoc, toZvecDocumentId, type VectorDocumentInput } from '../../src/vector/zvec-adapter.js';

const tempProjects: string[] = [];

function tempProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'zincgraph-zvec-test-'));
  tempProjects.push(project);
  return project;
}

function doc(id: string, kind = 'function'): VectorDocumentInput {
  return {
    id,
    nodeId: id,
    filePath: `src/${id}.ts`,
    language: 'typescript',
    kind,
    qualifiedName: `src/${id}.ts::${id}`,
    contentHash: `${id}-hash`,
    contentSparse: { 1: 1, 2: id === 'validateToken' ? 2 : 1 },
    embedding: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  };
}

afterEach(() => {
  for (const project of tempProjects.splice(0)) {
    rmSync(project, { force: true, recursive: true });
  }
});

describe('Phase 1 Zvec collection adapter', () => {
  test('creates a collection directory on disk', () => {
    const project = tempProject();
    const collection = createCollection(project);
    try {
      expect(getCollectionPath(project)).toContain('.zincgraph');
      expect(collection.path).toBe(getCollectionPath(project));
    } finally {
      collection.destroy();
    }
  });

  test('schema contains current vector and scalar fields', () => {
    expect(getCollectionSchemaFieldNames()).toEqual([
      'content',
      'embedding',
      'file_path',
      'language',
      'kind',
      'qualified_name',
      'node_id',
      'content_hash',
      'chunker_version'
    ]);
  });

  test('inserts and counts vector documents', () => {
    const project = tempProject();
    const collection = createCollection(project);
    try {
      collection.insertDocuments([doc('validateToken')]);
      expect(collection.count()).toBe(1);
    } finally {
      collection.destroy();
    }
  });

  test('uses Zvec-safe document ids while preserving raw CodeGraph node ids', () => {
    const rawId = 'interface:3d741249405c99c44397d425cd060893';
    const zvecDoc = toZvecDoc(doc(rawId));
    expect(toZvecDocumentId(rawId)).toMatch(/^zg_[a-f0-9]{32}$/);
    expect(zvecDoc.id).toBe(toZvecDocumentId(rawId));
    expect(zvecDoc.fields?.node_id).toBe(rawId);
  });

  test('reopens the same collection', () => {
    const project = tempProject();
    const collection = createCollection(project);
    collection.insertDocuments([doc('validateToken')]);
    collection.destroy();

    const reopened = openCollection(project);
    try {
      expect(reopened.count()).toBe(1);
    } finally {
      reopened.destroy();
    }
  });

  test('supports inverted-index filtered query by kind', () => {
    const project = tempProject();
    const collection = createCollection(project);
    try {
      collection.insertDocuments([doc('validateToken', 'function'), doc('TokenService', 'class')]);
      const results = collection.queryByKind('function');
      expect(results.map((result) => result.kind)).toEqual(['function']);
    } finally {
      collection.destroy();
    }
  });

  test('drops collection data', () => {
    const project = tempProject();
    const collection = createCollection(project);
    collection.destroy();
    dropCollection(project);
    const reopened = openCollection(project);
    try {
      expect(reopened.count()).toBe(0);
    } finally {
      reopened.destroy();
    }
  });
});
