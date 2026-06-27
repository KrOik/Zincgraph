import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { zincgraphDataDir } from '../vector/zvec-adapter.js';

export interface CcrEntry {
  hash: string;
  content: string;
  contentType: string;
  createdAt: number;
  ttl: number;
  retrievalCount: number;
  lastRetrievedAt?: number | null;
}

export interface CcrStoreOptions {
  projectPath: string;
  defaultTtl?: number;
}

type CcrEntryRow = {
  hash: string;
  content: string;
  contentType: string;
  createdAt: number;
  ttl: number;
  retrievalCount: number;
  lastRetrievedAt: number | null;
};

type PreparedStatement = ReturnType<DatabaseSync['prepare']>;

const CCR_STORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS ccr_entries(
  hash TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text',
  created_at INTEGER NOT NULL,
  ttl INTEGER NOT NULL DEFAULT 3600,
  retrieval_count INTEGER NOT NULL DEFAULT 0,
  last_retrieved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ccr_entries_created ON ccr_entries(created_at);
CREATE TABLE IF NOT EXISTS metadata(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function ccrStorePath(projectPath: string): string {
  return join(zincgraphDataDir(projectPath), 'fusion.sqlite');
}

export class CcrStore {
  readonly dbPath: string;
  private readonly defaultTtl: number;
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, PreparedStatement>();
  private closed = false;

  constructor(options: CcrStoreOptions) {
    const resolved = resolve(options.projectPath);
    this.dbPath = resolved.endsWith('.sqlite') ? resolved : ccrStorePath(resolved);
    this.defaultTtl = options.defaultTtl ?? 3600;
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    this.db.exec(CCR_STORE_SCHEMA);
  }

  put(hash: string, content: string, contentType: string, ttl?: number): void {
    this.statement(
      'INSERT INTO ccr_entries(hash,content,content_type,created_at,ttl,retrieval_count,last_retrieved_at) VALUES(?,?,?,?,?,0,NULL) ' +
      'ON CONFLICT(hash) DO UPDATE SET content=excluded.content,content_type=excluded.content_type,created_at=excluded.created_at,' +
      'ttl=excluded.ttl,last_retrieved_at=excluded.last_retrieved_at,retrieval_count=excluded.retrieval_count'
    ).run(hash, content, contentType, nowSeconds(), ttl ?? this.defaultTtl);
  }

  get(hash: string): CcrEntry | null {
    const statement = this.statement(
      'SELECT hash,content,content_type AS contentType,created_at AS createdAt,ttl,retrieval_count AS retrievalCount,last_retrieved_at AS lastRetrievedAt ' +
      'FROM ccr_entries WHERE hash = ?'
    );
    const row = statement.get(hash) as CcrEntryRow | undefined;
    if (!row) {
      return null;
    }
    this.statement(
      'UPDATE ccr_entries SET retrieval_count = retrieval_count + 1, last_retrieved_at = ? WHERE hash = ?'
    ).run(nowSeconds(), hash);
    return readCcrEntryRow(row);
  }

  search(query: string, limit?: number): CcrEntry[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) {
      return [];
    }
    const likeClauses = terms.map(() => 'content LIKE ?').join(' AND ');
    const rows = this.statement(
      `SELECT hash,content,content_type AS contentType,created_at AS createdAt,ttl,retrieval_count AS retrievalCount,last_retrieved_at AS lastRetrievedAt
       FROM ccr_entries
       WHERE ${likeClauses}
       ORDER BY created_at DESC
       LIMIT ?`
    ).all(...terms.map((term) => `%${term}%`), limit ?? 10) as CcrEntryRow[];
    return rows.map(readCcrEntryRow);
  }

  stats(): { entryCount: number; totalContentBytes: number; totalRetrievals: number } {
    return this.statement(
      'SELECT COUNT(*) AS entryCount, COALESCE(SUM(LENGTH(content)),0) AS totalContentBytes, COALESCE(SUM(retrieval_count),0) AS totalRetrievals FROM ccr_entries'
    ).get() as { entryCount: number; totalContentBytes: number; totalRetrievals: number };
  }

  evictExpired(): number {
    const result = this.statement('DELETE FROM ccr_entries WHERE created_at + ttl < ?').run(nowSeconds());
    return Number(result.changes);
  }

  evictLru(limit?: number): number {
    const result = this.statement(
      'DELETE FROM ccr_entries WHERE hash IN (SELECT hash FROM ccr_entries ORDER BY retrieval_count ASC, created_at ASC LIMIT ?)'
    ).run(limit ?? 10);
    return Number(result.changes);
  }

  clear(): void {
    this.statement('DELETE FROM ccr_entries').run();
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.db.close();
  }

  private statement(sql: string): PreparedStatement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
}

function readCcrEntryRow(row: CcrEntryRow): CcrEntry {
  return {
    hash: row.hash,
    content: row.content,
    contentType: row.contentType,
    createdAt: row.createdAt,
    ttl: row.ttl,
    retrievalCount: row.retrievalCount,
    lastRetrievedAt: row.lastRetrievedAt
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
