import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { zincgraphDataDir } from '../vector/zvec-adapter.js';

export type FeedbackSource = 'graph' | 'vector' | 'fts';

export interface RetrievalEvent {
  hash: string;
  nodeId: string;
  source: FeedbackSource;
  contentType: string;
  kind: string;
  retrievedAt: number;
  queryContext: string;
}

export interface CompressionEvent {
  hash: string;
  nodeId: string;
  source: FeedbackSource;
  contentType: string;
  kind: string;
  compressedAt: number;
}

export interface SessionLog {
  id?: number;
  recordedAt: number;
  toolName: string;
  input: string;
  output: string;
  durationMs: number;
  error?: string;
  queryContext?: string;
}

export interface RankingAdjustmentRecord {
  adjustedAt: number;
  adjustmentType: string;
  field: string;
  oldValue: string;
  newValue: string;
  reason: string;
}

export interface ReviewSignatureRecord {
  signature: string;
  discussedAt: number;
}

type RetrievalRow = {
  hash: string;
  nodeId: string;
  source: FeedbackSource;
  contentType: string;
  kind: string;
  retrievedAt: number;
  queryContext: string;
};

type CompressionRow = {
  hash: string;
  nodeId: string;
  source: FeedbackSource;
  contentType: string;
  kind: string;
  compressedAt: number;
};

type AdjustmentRow = {
  adjustedAt: number;
  adjustmentType: string;
  field: string;
  oldValue: string;
  newValue: string;
  reason: string;
};

type SessionLogRow = {
  id: number;
  recordedAt: number;
  toolName: string;
  input: string;
  output: string;
  durationMs: number;
  error: string;
  queryContext: string;
};

type ReviewSignatureRow = {
  signature: string;
  discussedAt: number;
};

type PreparedStatement = ReturnType<DatabaseSync['prepare']>;

const FEEDBACK_STORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS retrieval_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL,
  node_id TEXT NOT NULL,
  source TEXT NOT NULL,
  content_type TEXT NOT NULL,
  kind TEXT NOT NULL,
  retrieved_at INTEGER NOT NULL,
  query_context TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS compression_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL,
  node_id TEXT NOT NULL,
  source TEXT NOT NULL,
  content_type TEXT NOT NULL,
  kind TEXT NOT NULL,
  compressed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback_summary(
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (period_start, period_end)
);
CREATE TABLE IF NOT EXISTS ranking_adjustments(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  adjusted_at INTEGER NOT NULL,
  adjustment_type TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT NOT NULL,
  new_value TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  input TEXT NOT NULL DEFAULT '',
  output TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  query_context TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS review_context(
  signature TEXT PRIMARY KEY,
  discussed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_retrieval_events_hash ON retrieval_events(hash);
CREATE INDEX IF NOT EXISTS idx_compression_events_hash ON compression_events(hash);
CREATE INDEX IF NOT EXISTS idx_retrieval_events_kind ON retrieval_events(kind);
CREATE INDEX IF NOT EXISTS idx_compression_events_kind ON compression_events(kind);
`;

export function feedbackStorePath(projectPath: string): string {
  return join(zincgraphDataDir(projectPath), 'fusion.sqlite');
}

export interface FeedbackStoreOptions {
  projectPath: string;
}

export class FeedbackStore {
  readonly dbPath: string;
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, PreparedStatement>();
  private closed = false;

  constructor(options: FeedbackStoreOptions | string) {
    const projectPath = typeof options === 'string' ? options : options.projectPath;
    const resolved = resolve(projectPath);
    this.dbPath = resolved.endsWith('.sqlite') ? resolved : feedbackStorePath(resolved);
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    this.db.exec(FEEDBACK_STORE_SCHEMA);
  }

  recordRetrieval(event: RetrievalEvent): void {
    this.statement(
      'INSERT INTO retrieval_events(hash,node_id,source,content_type,kind,retrieved_at,query_context) VALUES(?,?,?,?,?,?,?)'
    ).run(
      event.hash,
      event.nodeId,
      event.source,
      event.contentType,
      event.kind,
      event.retrievedAt,
      event.queryContext
    );
  }

  recordCompression(event: CompressionEvent): void {
    this.statement(
      'INSERT INTO compression_events(hash,node_id,source,content_type,kind,compressed_at) VALUES(?,?,?,?,?,?)'
    ).run(event.hash, event.nodeId, event.source, event.contentType, event.kind, event.compressedAt);
  }

  listRetrievalEvents(since?: number): RetrievalEvent[] {
    const rows = since === undefined
      ? this.statement(
        'SELECT hash,node_id AS nodeId,source,content_type AS contentType,kind,retrieved_at AS retrievedAt,query_context AS queryContext ' +
        'FROM retrieval_events ORDER BY retrieved_at ASC'
      ).all()
      : this.statement(
        'SELECT hash,node_id AS nodeId,source,content_type AS contentType,kind,retrieved_at AS retrievedAt,query_context AS queryContext ' +
        'FROM retrieval_events WHERE retrieved_at >= ? ORDER BY retrieved_at ASC'
      ).all(since);
    return (rows as RetrievalRow[]).map(readRetrievalRow);
  }

  listCompressionEvents(since?: number): CompressionEvent[] {
    const rows = since === undefined
      ? this.statement(
        'SELECT hash,node_id AS nodeId,source,content_type AS contentType,kind,compressed_at AS compressedAt ' +
        'FROM compression_events ORDER BY compressed_at ASC'
      ).all()
      : this.statement(
        'SELECT hash,node_id AS nodeId,source,content_type AS contentType,kind,compressed_at AS compressedAt ' +
        'FROM compression_events WHERE compressed_at >= ? ORDER BY compressed_at ASC'
      ).all(since);
    return (rows as CompressionRow[]).map(readCompressionRow);
  }

  aggregate(): { retrievals: Array<{ source: string; contentType: string; kind: string; count: number }>; compressions: Array<{ source: string; contentType: string; kind: string; count: number }> } {
    const retrievals = this.statement(
      'SELECT source, content_type AS contentType, kind, COUNT(*) AS count FROM retrieval_events GROUP BY source, content_type, kind'
    ).all() as Array<{ source: string; contentType: string; kind: string; count: number }>;
    const compressions = this.statement(
      'SELECT source, content_type AS contentType, kind, COUNT(*) AS count FROM compression_events GROUP BY source, content_type, kind'
    ).all() as Array<{ source: string; contentType: string; kind: string; count: number }>;
    return { retrievals, compressions };
  }

  findCompressionByHash(hash: string): CompressionEvent | null {
    const row = this.statement(
      'SELECT hash,node_id AS nodeId,source,content_type AS contentType,kind,compressed_at AS compressedAt ' +
      'FROM compression_events WHERE hash = ? ORDER BY compressed_at DESC LIMIT 1'
    ).get(hash) as CompressionRow | undefined;
    return row ? readCompressionRow(row) : null;
  }

  recordSessionLog(log: SessionLog): void {
    this.statement(
      'INSERT INTO session_logs(recorded_at,tool_name,input,output,duration_ms,error,query_context) VALUES(?,?,?,?,?,?,?)'
    ).run(
      log.recordedAt,
      log.toolName,
      log.input,
      log.output,
      log.durationMs,
      log.error ?? '',
      log.queryContext ?? ''
    );
  }

  listSessionLogs(): SessionLog[] {
    const rows = this.statement(
      'SELECT id,recorded_at AS recordedAt,tool_name AS toolName,input,output,duration_ms AS durationMs,error,query_context AS queryContext ' +
      'FROM session_logs ORDER BY recorded_at ASC'
    ).all() as SessionLogRow[];
    return rows.map(readSessionLogRow);
  }

  clearSessionLogs(): void {
    this.statement('DELETE FROM session_logs').run();
  }

  recordReviewSignature(record: ReviewSignatureRecord): void {
    this.statement(
      'INSERT INTO review_context(signature, discussed_at) VALUES(?, ?) ON CONFLICT(signature) DO UPDATE SET discussed_at=excluded.discussed_at'
    ).run(record.signature, record.discussedAt);
  }

  listReviewSignatures(since?: number): ReviewSignatureRecord[] {
    const rows = since === undefined
      ? this.statement('SELECT signature, discussed_at AS discussedAt FROM review_context ORDER BY discussed_at ASC, signature ASC').all()
      : this.statement(
        'SELECT signature, discussed_at AS discussedAt FROM review_context WHERE discussed_at >= ? ORDER BY discussed_at ASC, signature ASC'
      ).all(since);
    return rows as ReviewSignatureRow[];
  }

  clearReviewSignatures(): void {
    this.statement('DELETE FROM review_context').run();
  }

  recordAdjustment(record: RankingAdjustmentRecord): void {
    this.statement(
      'INSERT INTO ranking_adjustments(adjusted_at,adjustment_type,field,old_value,new_value,reason) VALUES(?,?,?,?,?,?)'
    ).run(
      record.adjustedAt,
      record.adjustmentType,
      record.field,
      record.oldValue,
      record.newValue,
      record.reason
    );
  }

  listAdjustments(): RankingAdjustmentRecord[] {
    const rows = this.statement(
      'SELECT adjusted_at AS adjustedAt,adjustment_type AS adjustmentType,field,old_value AS oldValue,new_value AS newValue,reason ' +
      'FROM ranking_adjustments ORDER BY adjusted_at ASC'
    ).all() as AdjustmentRow[];
    return rows.map(readAdjustmentRow);
  }

  clear(): void {
    this.statement('DELETE FROM retrieval_events').run();
    this.statement('DELETE FROM compression_events').run();
    this.statement('DELETE FROM feedback_summary').run();
    this.statement('DELETE FROM ranking_adjustments').run();
    this.statement('DELETE FROM session_logs').run();
    this.statement('DELETE FROM review_context').run();
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

function readRetrievalRow(row: RetrievalRow): RetrievalEvent {
  return {
    hash: row.hash,
    nodeId: row.nodeId,
    source: row.source,
    contentType: row.contentType,
    kind: row.kind,
    retrievedAt: row.retrievedAt,
    queryContext: row.queryContext
  };
}

function readCompressionRow(row: CompressionRow): CompressionEvent {
  return {
    hash: row.hash,
    nodeId: row.nodeId,
    source: row.source,
    contentType: row.contentType,
    kind: row.kind,
    compressedAt: row.compressedAt
  };
}

function readSessionLogRow(row: SessionLogRow): SessionLog {
  return {
    id: row.id,
    recordedAt: row.recordedAt,
    toolName: row.toolName,
    input: row.input,
    output: row.output,
    durationMs: row.durationMs,
    error: row.error,
    queryContext: row.queryContext
  };
}

function readAdjustmentRow(row: AdjustmentRow): RankingAdjustmentRecord {
  return {
    adjustedAt: row.adjustedAt,
    adjustmentType: row.adjustmentType,
    field: row.field,
    oldValue: row.oldValue,
    newValue: row.newValue,
    reason: row.reason
  };
}
