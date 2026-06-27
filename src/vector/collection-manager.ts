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
import { resolveActiveEmbedding, type ActiveEmbeddingConfigInput } from './embedding/config.js';
import { embedOrThrow, type EmbeddingAdapter } from './embedding/registry.js';

export interface CodeVectorCollection {
  readonly path: string;
  readonly schemaFields: readonly string[];
  insertDocuments(documents: readonly VectorDocumentInput[]): void;
  deleteDocumentsByFilePaths(filePaths: readonly string[]): void;
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
  mode?: 'hybrid' | 'dense' | 'sparse';
  filter?: string;
}

export interface CodeVectorCollectionOptions {
  embedding?: ActiveEmbeddingConfigInput;
  embeddingProfile?: string;
  chunkerVersion?: string;
  queryAdapter?: EmbeddingAdapter;
}

class ZvecCodeVectorCollection implements CodeVectorCollection {
  readonly path: string;
  readonly schemaFields = CODE_VECTOR_SCHEMA_FIELDS;
  private collection: ZVecCollection | undefined;

  constructor(
    private readonly projectPath: string,
    path: string,
    private readonly storage: { embeddingProfile: string; chunkerVersion: string },
    private readonly embedder: EmbeddingAdapter
  ) {
    this.path = path;
  }

  insertDocuments(documents: readonly VectorDocumentInput[]): void {
    if (documents.length === 0) {
      return;
    }
    const collection = this.getOrCreateCollection(firstDenseDimension(documents));
    const statuses = collection.upsertSync(documents.map(toZvecDoc)) as ZVecStatus[];
    const failed = statuses.find((status) => !status.ok);
    if (failed) {
      throw new Error(`Zvec upsert failed: ${failed.code} ${failed.message}`);
    }
  }

  deleteDocumentsByFilePaths(filePaths: readonly string[]): void {
    const collection = this.getExistingCollection();
    if (!collection) {
      return;
    }
    for (const filePath of filePaths) {
      collection.deleteByFilterSync(filterEquals('file_path', filePath));
    }
  }

  async query(queries: readonly CodeVectorQuery[], topk = 10): Promise<VectorSearchResult[]> {
    const collection = this.getExistingCollection();
    if (!collection) {
      return [];
    }
    const results: VectorSearchResult[] = [];
    for (const query of queries) {
      const zvecQueries = await this.toZvecQueries(query, topk);
      for (const zvecQuery of zvecQueries) {
        results.push(...collection.querySync(zvecQuery).map(toSearchResult));
      }
    }
    return dedupeById(results).slice(0, topk);
  }

  queryByKind(kind: string, topk = 10): VectorSearchResult[] {
    const collection = this.getExistingCollection();
    if (!collection) {
      return [];
    }
    return collection
      .querySync({ filter: filterEquals('kind', kind), topk })
      .map(toSearchResult);
  }

  count(): number {
    return this.getExistingCollection()?.stats.docCount ?? 0;
  }

  flush(): void {
    this.getExistingCollection()?.optimizeSync();
  }

  destroy(): void {
    this.collection?.closeSync();
    this.collection = undefined;
  }

  private async toZvecQueries(query: CodeVectorQuery, topk: number): Promise<ZVecQuery[]> {
    if (query.sparseVector) {
      return [withOptionalFilter({ fieldName: 'content', vector: query.sparseVector, topk }, query.filter)];
    }
    if (query.vector) {
      return [withOptionalFilter({ fieldName: 'embedding', vector: [...query.vector], topk }, query.filter)];
    }
    if (query.text) {
      const [embedding] = await embedOrThrow(this.embedder, [query.text]);
      if (!embedding) {
        return [withOptionalFilter({ topk }, query.filter)];
      }
      const zvecQueries: ZVecQuery[] = [];
      const mode = query.mode ?? 'hybrid';
      if (mode !== 'dense' && Object.keys(embedding.sparse).length > 0) {
        zvecQueries.push(withOptionalFilter({ fieldName: 'content', vector: embedding.sparse, topk }, query.filter));
      }
      if (mode !== 'sparse' && embedding.dense.length > 0) {
        zvecQueries.push(withOptionalFilter({ fieldName: 'embedding', vector: [...embedding.dense], topk }, query.filter));
      }
      return zvecQueries.length > 0 ? zvecQueries : [withOptionalFilter({ topk }, query.filter)];
    }
    return [withOptionalFilter({ topk }, query.filter)];
  }

  private getExistingCollection(): ZVecCollection | undefined {
    if (this.collection) {
      return this.collection;
    }
    if (!existsSync(this.path)) {
      return undefined;
    }
    this.collection = openRawCollection(this.projectPath, this.storage);
    return this.collection;
  }

  private getOrCreateCollection(dimension: number | undefined): ZVecCollection {
    const existing = this.getExistingCollection();
    if (existing) {
      return existing;
    }
    this.collection = createRawCollection(this.projectPath, {
      ...this.storage,
      ...(dimension === undefined ? {} : { dimension })
    });
    return this.collection;
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

export function createCollection(projectPath: string, options: CodeVectorCollectionOptions = {}): CodeVectorCollection {
  const resolved = resolveCollectionEmbedding(projectPath, options);
  return new ZvecCodeVectorCollection(
    projectPath,
    collectionPath(projectPath, {
      embeddingProfile: resolved.profile,
      chunkerVersion: resolved.chunkerVersion
    }),
    {
      embeddingProfile: resolved.profile,
      chunkerVersion: resolved.chunkerVersion
    },
    options.queryAdapter ?? resolved.adapter
  );
}

export function openCollection(projectPath: string, options: CodeVectorCollectionOptions = {}): CodeVectorCollection {
  const resolved = resolveCollectionEmbedding(projectPath, options);
  const path = collectionPath(projectPath, {
    embeddingProfile: resolved.profile,
    chunkerVersion: resolved.chunkerVersion
  });
  return new ZvecCodeVectorCollection(
    projectPath,
    path,
    {
      embeddingProfile: resolved.profile,
      chunkerVersion: resolved.chunkerVersion
    },
    options.queryAdapter ?? resolved.adapter
  );
}

export function dropCollection(projectPath: string, options: CodeVectorCollectionOptions = {}): void {
  const resolved = resolveCollectionEmbedding(projectPath, options);
  dropRawCollection(projectPath, {
    embeddingProfile: resolved.profile,
    chunkerVersion: resolved.chunkerVersion
  });
}

export function getCollectionPath(projectPath: string, options: CodeVectorCollectionOptions = {}): string {
  const resolved = resolveCollectionEmbedding(projectPath, options);
  return collectionPath(projectPath, {
    embeddingProfile: resolved.profile,
    chunkerVersion: resolved.chunkerVersion
  });
}

export function getCollectionSchemaFieldNames(): readonly string[] {
  const schema = createCodeCollectionSchema();
  return [...schema.vectors().map((field) => field.name), ...schema.fields().map((field) => field.name)];
}

function resolveCollectionEmbedding(projectPath: string, options: CodeVectorCollectionOptions) {
  return resolveActiveEmbedding(projectPath, {
    ...options.embedding,
    ...(options.embeddingProfile === undefined ? {} : { embeddingProfile: options.embeddingProfile }),
    ...(options.chunkerVersion === undefined ? {} : { chunkerVersion: options.chunkerVersion })
  });
}

function firstDenseDimension(documents: readonly VectorDocumentInput[]): number | undefined {
  for (const document of documents) {
    if (document.embedding.length > 0) {
      return document.embedding.length;
    }
  }
  return undefined;
}
