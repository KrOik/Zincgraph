import { existsSync } from 'node:fs';

import type { ZVecCollection, ZVecQuery, ZVecStatus } from '@zvec/zvec';

import {
  CODE_VECTOR_SCHEMA_FIELDS,
  collectionPath,
  createCodeCollectionSchema,
  createRawCollection,
  dropRawCollection,
  filterEquals,
  openRawCollection,
  toSearchResult,
  toZvecDoc,
  type VectorDocumentInput,
  type VectorSearchResult
} from './zvec-adapter.js';
import { LocalTokenEmbedding } from './embedding/local.js';

export interface CodeVectorCollection {
  readonly path: string;
  readonly schemaFields: readonly string[];
  insertDocuments(documents: readonly VectorDocumentInput[]): void;
  query(queries: readonly CodeVectorQuery[], topk?: number): Promise<VectorSearchResult[]>;
  queryByKind(kind: string, topk?: number): VectorSearchResult[];
  count(): number;
  flush(): void;
  destroy(): void;
}

export interface CodeVectorQuery {
  text?: string;
  vector?: readonly number[];
  sparseVector?: Record<number, number>;
  filter?: string;
}

class ZvecCodeVectorCollection implements CodeVectorCollection {
  readonly path: string;
  readonly schemaFields = CODE_VECTOR_SCHEMA_FIELDS;
  private readonly embedder = new LocalTokenEmbedding();

  constructor(private readonly collection: ZVecCollection, path: string) {
    this.path = path;
  }

  insertDocuments(documents: readonly VectorDocumentInput[]): void {
    if (documents.length === 0) {
      return;
    }
    const statuses = this.collection.upsertSync(documents.map(toZvecDoc)) as ZVecStatus[];
    const failed = statuses.find((status) => !status.ok);
    if (failed) {
      throw new Error(`Zvec upsert failed: ${failed.code} ${failed.message}`);
    }
  }

  async query(queries: readonly CodeVectorQuery[], topk = 10): Promise<VectorSearchResult[]> {
    const results: VectorSearchResult[] = [];
    for (const query of queries) {
      const zvecQuery = await this.toZvecQuery(query, topk);
      results.push(...this.collection.querySync(zvecQuery).map(toSearchResult));
    }
    return dedupeById(results).slice(0, topk);
  }

  queryByKind(kind: string, topk = 10): VectorSearchResult[] {
    return this.collection
      .querySync({ filter: filterEquals('kind', kind), topk })
      .map(toSearchResult);
  }

  count(): number {
    return this.collection.stats.docCount;
  }

  flush(): void {
    this.collection.optimizeSync();
  }

  destroy(): void {
    this.collection.closeSync();
  }

  private async toZvecQuery(query: CodeVectorQuery, topk: number): Promise<ZVecQuery> {
    if (query.sparseVector) {
      return withOptionalFilter({ fieldName: 'content', vector: query.sparseVector, topk }, query.filter);
    }
    if (query.vector) {
      return withOptionalFilter({ fieldName: 'embedding', vector: [...query.vector], topk }, query.filter);
    }
    if (query.text) {
      const [embedding] = await this.embedder.embed([query.text]);
      if (!embedding) {
        return withOptionalFilter({ topk }, query.filter);
      }
      return withOptionalFilter({ fieldName: 'content', vector: embedding.sparse, topk }, query.filter);
    }
    return withOptionalFilter({ topk }, query.filter);
  }
}

function withOptionalFilter(query: ZVecQuery, filter: string | undefined): ZVecQuery {
  return filter ? { ...query, filter } : query;
}

function dedupeById(results: readonly VectorSearchResult[]): VectorSearchResult[] {
  const byId = new Map<string, VectorSearchResult>();
  for (const result of results) {
    const previous = byId.get(result.id);
    if (!previous || result.score > previous.score) {
      byId.set(result.id, result);
    }
  }
  return [...byId.values()].sort((left, right) => right.score - left.score);
}

export function createCollection(projectPath: string): CodeVectorCollection {
  const raw = createRawCollection(projectPath);
  return new ZvecCodeVectorCollection(raw, collectionPath(projectPath));
}

export function openCollection(projectPath: string): CodeVectorCollection {
  const path = collectionPath(projectPath);
  const raw = existsSync(path) ? openRawCollection(projectPath) : createRawCollection(projectPath);
  return new ZvecCodeVectorCollection(raw, path);
}

export function dropCollection(projectPath: string): void {
  dropRawCollection(projectPath);
}

export function getCollectionPath(projectPath: string): string {
  return collectionPath(projectPath);
}

export function getCollectionSchemaFieldNames(): readonly string[] {
  const schema = createCodeCollectionSchema();
  return [...schema.vectors().map((field) => field.name), ...schema.fields().map((field) => field.name)];
}
