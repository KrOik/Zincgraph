import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { zincgraphDataDir } from '../vector/zvec-adapter.js';

export interface StoredVectorDocument {
  id: string;
  nodeId: string;
  filePath: string;
  embeddingProfile: string;
  chunkerVersion: string;
  json: unknown;
}

export interface StoredManifestEntry {
  entryKey: string;
  filePath: string;
  embeddingProfile: string;
  chunkerVersion: string;
  json: unknown;
}

type VectorDocumentRow = {
  id: string;
  nodeId: string;
  filePath: string;
  embeddingProfile: string;
  chunkerVersion: string;
  json: string;
};

type ManifestEntryRow = {
  entryKey: string;
  filePath: string;
  embeddingProfile: string;
  chunkerVersion: string;
  json: string;
};

type MetadataRow = {
  key: string;
  value: string;
};

const VECTOR_DOCUMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS vector_documents(
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  embedding_profile TEXT NOT NULL,
  chunker_version TEXT NOT NULL DEFAULT 'codegraph-node-v1',
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS manifest_entries(
  entry_key TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  embedding_profile TEXT NOT NULL,
  chunker_version TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS metadata(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vector_documents_file ON vector_documents(file_path);
CREATE INDEX IF NOT EXISTS idx_vector_documents_node ON vector_documents(node_id);
CREATE INDEX IF NOT EXISTS idx_manifest_entries_file ON manifest_entries(file_path);
`;

export function fusionStorePath(projectPath: string): string {
  return join(zincgraphDataDir(projectPath), 'fusion.sqlite');
}

export class FusionStore {
  readonly dbPath: string;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(projectPathOrDbPath: string) {
    const resolved = resolve(projectPathOrDbPath);
    this.dbPath = resolved.endsWith('.sqlite') ? resolved : fusionStorePath(resolved);
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    this.db.exec(VECTOR_DOCUMENT_SCHEMA);
    ensureVectorDocumentChunkerVersion(this.db);
  }

  upsertVectorDocuments(documents: readonly StoredVectorDocument[]): void {
    if (documents.length === 0) {
      return;
    }
    const statement = this.db.prepare(
      'INSERT INTO vector_documents(id,node_id,file_path,embedding_profile,chunker_version,json) VALUES(?,?,?,?,?,?) ' +
      'ON CONFLICT(id) DO UPDATE SET node_id=excluded.node_id,file_path=excluded.file_path,embedding_profile=excluded.embedding_profile,' +
      'chunker_version=excluded.chunker_version,json=excluded.json'
    );
    runInTransaction(this.db, () => {
      for (const document of documents) {
        statement.run(
          document.id,
          document.nodeId,
          document.filePath,
          document.embeddingProfile,
          document.chunkerVersion,
          JSON.stringify(document.json)
        );
      }
    });
  }

  deleteVectorDocumentsByFilePaths(filePaths: readonly string[], embeddingProfile: string, chunkerVersion: string): void {
    if (filePaths.length === 0) {
      return;
    }
    const placeholders = filePaths.map(() => '?').join(',');
    const statement = this.db.prepare(
      `DELETE FROM vector_documents WHERE file_path IN (${placeholders}) AND embedding_profile = ? AND chunker_version = ?`
    );
    statement.run(...filePaths, embeddingProfile, chunkerVersion);
  }

  listVectorDocuments(embeddingProfile?: string, chunkerVersion?: string): StoredVectorDocument[] {
    const { sql, params } = buildVectorDocumentListQuery(embeddingProfile, chunkerVersion);
    const rows = this.db.prepare(sql).all(...params) as VectorDocumentRow[];
    return rows.map(readVectorDocumentRow);
  }

  getVectorDocumentsByNodeIds(nodeIds: readonly string[], embeddingProfile: string, chunkerVersion: string): StoredVectorDocument[] {
    const uniqueNodeIds = [...new Set(nodeIds.filter((nodeId) => nodeId.length > 0))];
    if (uniqueNodeIds.length === 0) {
      return [];
    }
    const placeholders = uniqueNodeIds.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT id,node_id AS nodeId,file_path AS filePath,embedding_profile AS embeddingProfile,chunker_version AS chunkerVersion,json
       FROM vector_documents
       WHERE node_id IN (${placeholders}) AND embedding_profile = ? AND chunker_version = ?
       ORDER BY id`
    ).all(...uniqueNodeIds, embeddingProfile, chunkerVersion) as VectorDocumentRow[];
    return rows.map(readVectorDocumentRow);
  }

  countVectorDocuments(embeddingProfile?: string, chunkerVersion?: string): number {
    const { sql, params } = buildVectorDocumentCountQuery(embeddingProfile, chunkerVersion);
    const row = this.db.prepare(sql).get(...params) as { count?: number | bigint } | undefined;
    return Number(row?.count ?? 0);
  }

  upsertManifestEntries(entries: readonly StoredManifestEntry[]): void {
    if (entries.length === 0) {
      return;
    }
    const statement = this.db.prepare(
      'INSERT INTO manifest_entries(entry_key,file_path,embedding_profile,chunker_version,json) VALUES(?,?,?,?,?) ' +
      'ON CONFLICT(entry_key) DO UPDATE SET file_path=excluded.file_path,embedding_profile=excluded.embedding_profile,' +
      'chunker_version=excluded.chunker_version,json=excluded.json'
    );
    runInTransaction(this.db, () => {
      for (const entry of entries) {
        statement.run(
          entry.entryKey,
          entry.filePath,
          entry.embeddingProfile,
          entry.chunkerVersion,
          JSON.stringify(entry.json)
        );
      }
    });
  }

  deleteManifestEntriesByFilePaths(filePaths: readonly string[], embeddingProfile: string, chunkerVersion: string): void {
    if (filePaths.length === 0) {
      return;
    }
    const placeholders = filePaths.map(() => '?').join(',');
    const statement = this.db.prepare(
      `DELETE FROM manifest_entries WHERE file_path IN (${placeholders}) AND embedding_profile = ? AND chunker_version = ?`
    );
    statement.run(...filePaths, embeddingProfile, chunkerVersion);
  }

  listManifestEntries(embeddingProfile?: string, chunkerVersion?: string): StoredManifestEntry[] {
    const { sql, params } = buildManifestEntryListQuery(embeddingProfile, chunkerVersion);
    const rows = this.db.prepare(sql).all(...params) as ManifestEntryRow[];
    return rows.map(readManifestEntryRow);
  }

  getManifestEntry(entryKey: string): StoredManifestEntry | null {
    const row = this.db.prepare(
      'SELECT entry_key AS entryKey,file_path AS filePath,embedding_profile AS embeddingProfile,chunker_version AS chunkerVersion,json ' +
      'FROM manifest_entries WHERE entry_key = ?'
    ).get(entryKey) as ManifestEntryRow | undefined;
    return row ? readManifestEntryRow(row) : null;
  }

  setMetadata(key: string, value: string): void {
    this.db.prepare(
      'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    ).run(key, value);
  }

  setMetadataEntries(entries: Readonly<Record<string, string>>): void {
    const normalized = Object.fromEntries(
      Object.entries(entries).filter((entry): entry is [string, string] => entry[0].length > 0 && entry[1].length > 0)
    );
    if (Object.keys(normalized).length === 0) {
      return;
    }
    const statement = this.db.prepare(
      'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    );
    runInTransaction(this.db, () => {
      for (const [key, value] of Object.entries(normalized)) {
        statement.run(key, value);
      }
    });
  }

  getMetadata(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as MetadataRow | undefined;
    return row?.value ?? null;
  }

  getMetadataEntries(keys: readonly string[]): Record<string, string> {
    const uniqueKeys = [...new Set(keys.filter((key) => key.length > 0))];
    if (uniqueKeys.length === 0) {
      return {};
    }
    const placeholders = uniqueKeys.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT key,value FROM metadata WHERE key IN (${placeholders})`
    ).all(...uniqueKeys) as MetadataRow[];
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.db.close();
  }
}

export function scopedStoredVectorDocumentId(nodeId: string, embeddingProfile: string, chunkerVersion: string): string {
  return createHash('sha256')
    .update(`${nodeId}\0${embeddingProfile}\0${chunkerVersion}`)
    .digest('hex');
}

function ensureVectorDocumentChunkerVersion(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(vector_documents)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'chunker_version')) {
    db.exec("ALTER TABLE vector_documents ADD COLUMN chunker_version TEXT NOT NULL DEFAULT 'codegraph-node-v1'");
  }
}

function buildVectorDocumentListQuery(
  embeddingProfile?: string,
  chunkerVersion?: string
): { sql: string; params: readonly string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (embeddingProfile !== undefined) {
    clauses.push('embedding_profile = ?');
    params.push(embeddingProfile);
  }
  if (chunkerVersion !== undefined) {
    clauses.push('chunker_version = ?');
    params.push(chunkerVersion);
  }
  const sql = [
    'SELECT id,node_id AS nodeId,file_path AS filePath,embedding_profile AS embeddingProfile,chunker_version AS chunkerVersion,json',
    'FROM vector_documents',
    clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    'ORDER BY id'
  ].filter(Boolean).join(' ');
  return { sql, params };
}

function buildVectorDocumentCountQuery(
  embeddingProfile?: string,
  chunkerVersion?: string
): { sql: string; params: readonly string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (embeddingProfile !== undefined) {
    clauses.push('embedding_profile = ?');
    params.push(embeddingProfile);
  }
  if (chunkerVersion !== undefined) {
    clauses.push('chunker_version = ?');
    params.push(chunkerVersion);
  }
  const sql = [
    'SELECT COUNT(*) AS count',
    'FROM vector_documents',
    clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  ].filter(Boolean).join(' ');
  return { sql, params };
}

function buildManifestEntryListQuery(
  embeddingProfile?: string,
  chunkerVersion?: string
): { sql: string; params: readonly string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (embeddingProfile !== undefined) {
    clauses.push('embedding_profile = ?');
    params.push(embeddingProfile);
  }
  if (chunkerVersion !== undefined) {
    clauses.push('chunker_version = ?');
    params.push(chunkerVersion);
  }
  const sql = [
    'SELECT entry_key AS entryKey,file_path AS filePath,embedding_profile AS embeddingProfile,chunker_version AS chunkerVersion,json',
    'FROM manifest_entries',
    clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    'ORDER BY file_path'
  ].filter(Boolean).join(' ');
  return { sql, params };
}

function readVectorDocumentRow(row: VectorDocumentRow): StoredVectorDocument {
  return {
    id: row.id,
    nodeId: row.nodeId,
    filePath: row.filePath,
    embeddingProfile: row.embeddingProfile,
    chunkerVersion: row.chunkerVersion,
    json: JSON.parse(row.json)
  };
}

function readManifestEntryRow(row: ManifestEntryRow): StoredManifestEntry {
  return {
    entryKey: row.entryKey,
    filePath: row.filePath,
    embeddingProfile: row.embeddingProfile,
    chunkerVersion: row.chunkerVersion,
    json: JSON.parse(row.json)
  };
}

function runInTransaction(db: DatabaseSync, action: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    action();
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore rollback failures and rethrow the original error.
    }
    throw error;
  }
}
