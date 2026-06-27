import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  ZVecCollectionSchema,
  ZVecCreateAndOpen,
  ZVecDataType,
  ZVecIndexType,
  ZVecInitialize,
  ZVecMetricType,
  ZVecOpen,
  type ZVecCollection,
  type ZVecDoc,
  type ZVecDocInput,
  type ZVecQuery
} from '@zvec/zvec';
import { DEFAULT_CHUNKER_VERSION, chunkerCollectionDirectory } from './chunker.js';

export const CODE_VECTOR_DIMENSION = 64;
export const ZINCGRAPH_DIR = '.zincgraph';
export const CODE_COLLECTION_DIR = chunkerCollectionDirectory(DEFAULT_CHUNKER_VERSION);

export const VECTOR_FIELD_NAMES = ['content', 'embedding'] as const;
export const SCALAR_FIELD_NAMES = [
  'file_path',
  'language',
  'kind',
  'qualified_name',
  'node_id',
  'content_hash',
  'chunker_version'
] as const;
export const CODE_VECTOR_SCHEMA_FIELDS = [...VECTOR_FIELD_NAMES, ...SCALAR_FIELD_NAMES] as const;

export type CodeVectorField = (typeof CODE_VECTOR_SCHEMA_FIELDS)[number];

export interface VectorDocumentInput {
  id: string;
  nodeId: string;
  filePath: string;
  language: string;
  kind: string;
  qualifiedName: string;
  contentHash: string;
  chunkerVersion?: string;
  contentSparse: Record<number, number>;
  embedding: number[];
}

export interface VectorSearchResult {
  id: string;
  score: number;
  nodeId: string;
  filePath: string;
  language: string;
  kind: string;
  qualifiedName: string;
  contentHash: string;
  chunkerVersion: string;
}

let initialized = false;

export function initializeZvec(): void {
  if (initialized) {
    return;
  }
  ZVecInitialize({ logLevel: 3 });
  initialized = true;
}

export function zincgraphDataDir(projectPath: string): string {
  return join(resolve(projectPath), ZINCGRAPH_DIR);
}

export function collectionPath(
  projectPath: string,
  options: { embeddingProfile: string; chunkerVersion?: string }
): string {
  return join(
    zincgraphDataDir(projectPath),
    embeddingCollectionDirectory(options.embeddingProfile),
    chunkerCollectionDirectory(options.chunkerVersion ?? DEFAULT_CHUNKER_VERSION)
  );
}

export function createCodeCollectionSchema(dimension = CODE_VECTOR_DIMENSION): ZVecCollectionSchema {
  return new ZVecCollectionSchema({
    name: 'zincgraph_code_vectors',
    vectors: [
      {
        name: 'content',
        dataType: ZVecDataType.SPARSE_VECTOR_FP32,
        indexParams: {
          indexType: ZVecIndexType.HNSW,
          metricType: ZVecMetricType.IP
        }
      },
      {
        name: 'embedding',
        dataType: ZVecDataType.VECTOR_FP32,
        dimension,
        indexParams: {
          indexType: ZVecIndexType.HNSW,
          metricType: ZVecMetricType.COSINE
        }
      }
    ],
    fields: [
      { name: 'file_path', dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: 'language', dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: 'kind', dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: 'qualified_name', dataType: ZVecDataType.STRING },
      { name: 'node_id', dataType: ZVecDataType.STRING },
      { name: 'content_hash', dataType: ZVecDataType.STRING },
      { name: 'chunker_version', dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } }
    ]
  });
}

export function createRawCollection(
  projectPath: string,
  options: { embeddingProfile: string; chunkerVersion?: string; dimension?: number }
): ZVecCollection {
  initializeZvec();
  const path = collectionPath(projectPath, options);
  mkdirSync(dirname(path), { recursive: true });
  return ZVecCreateAndOpen(path, createCodeCollectionSchema(options.dimension));
}

export function openRawCollection(
  projectPath: string,
  options: { embeddingProfile: string; chunkerVersion?: string }
): ZVecCollection {
  initializeZvec();
  return ZVecOpen(collectionPath(projectPath, options));
}

export function dropRawCollection(
  projectPath: string,
  options: { embeddingProfile: string; chunkerVersion?: string }
): void {
  rmSync(collectionPath(projectPath, options), { force: true, recursive: true });
}

export function toZvecDoc(document: VectorDocumentInput): ZVecDocInput {
  return {
    id: toZvecDocumentId(document.id),
    vectors: {
      content: document.contentSparse,
      embedding: document.embedding
    },
    fields: {
      file_path: document.filePath,
      language: document.language,
      kind: document.kind,
      qualified_name: document.qualifiedName,
      node_id: document.nodeId,
      content_hash: document.contentHash,
      chunker_version: document.chunkerVersion ?? DEFAULT_CHUNKER_VERSION
    }
  };
}

export function toZvecDocumentId(nodeId: string): string {
  return `zg_${createHash('sha256').update(nodeId).digest('hex').slice(0, 32)}`;
}

export function toSearchResult(doc: ZVecDoc): VectorSearchResult {
  return {
    id: doc.id,
    score: doc.score,
    nodeId: String(doc.fields.node_id ?? doc.id),
    filePath: String(doc.fields.file_path ?? ''),
    language: String(doc.fields.language ?? ''),
    kind: String(doc.fields.kind ?? ''),
    qualifiedName: String(doc.fields.qualified_name ?? ''),
    contentHash: String(doc.fields.content_hash ?? ''),
    chunkerVersion: String(doc.fields.chunker_version ?? 'codegraph-node-v1')
  };
}

export function escapeZvecStringLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export function filterEquals(field: 'file_path' | 'language' | 'kind', value: string): string {
  return `${field} = '${escapeZvecStringLiteral(value)}'`;
}

function embeddingCollectionDirectory(embeddingProfile: string): string {
  return `embedding-${safeCollectionSegment(embeddingProfile)}`;
}

function safeCollectionSegment(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'default';
}

export type { ZVecCollection, ZVecQuery };
