import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

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

interface FusionResponse<T> {
  ok: boolean;
  result?: T;
  error?: string;
}

const FEEDBACK_PYTHON_SCRIPT = String.raw`
import json
import sqlite3
import sys
import time

request = json.loads(sys.stdin.read())
db_path = request["dbPath"]
operation = request["operation"]
payload = request.get("payload", {})

con = sqlite3.connect(db_path)
con.execute("PRAGMA journal_mode=WAL")
con.execute("PRAGMA synchronous=NORMAL")
con.execute("""
CREATE TABLE IF NOT EXISTS retrieval_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL,
  node_id TEXT NOT NULL,
  source TEXT NOT NULL,
  content_type TEXT NOT NULL,
  kind TEXT NOT NULL,
  retrieved_at INTEGER NOT NULL,
  query_context TEXT NOT NULL DEFAULT ''
)
""")
con.execute("""
CREATE TABLE IF NOT EXISTS compression_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL,
  node_id TEXT NOT NULL,
  source TEXT NOT NULL,
  content_type TEXT NOT NULL,
  kind TEXT NOT NULL,
  compressed_at INTEGER NOT NULL
)
""")
con.execute("""
CREATE TABLE IF NOT EXISTS feedback_summary(
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (period_start, period_end)
)
""")
con.execute("""
CREATE TABLE IF NOT EXISTS ranking_adjustments(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  adjusted_at INTEGER NOT NULL,
  adjustment_type TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT NOT NULL,
  new_value TEXT NOT NULL,
  reason TEXT NOT NULL
)
""")
con.execute("""
CREATE TABLE IF NOT EXISTS session_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  input TEXT NOT NULL DEFAULT '',
  output TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  query_context TEXT NOT NULL DEFAULT ''
)
""")
con.execute("""
CREATE TABLE IF NOT EXISTS review_context(
  signature TEXT PRIMARY KEY,
  discussed_at INTEGER NOT NULL
)
""")
con.execute("CREATE INDEX IF NOT EXISTS idx_retrieval_events_hash ON retrieval_events(hash)")
con.execute("CREATE INDEX IF NOT EXISTS idx_compression_events_hash ON compression_events(hash)")
con.execute("CREATE INDEX IF NOT EXISTS idx_retrieval_events_kind ON retrieval_events(kind)")
con.execute("CREATE INDEX IF NOT EXISTS idx_compression_events_kind ON compression_events(kind)")

def row_to_retrieval(row):
  return {"hash": row[0], "nodeId": row[1], "source": row[2], "contentType": row[3], "kind": row[4], "retrievedAt": row[5], "queryContext": row[6]}

def row_to_compression(row):
  return {"hash": row[0], "nodeId": row[1], "source": row[2], "contentType": row[3], "kind": row[4], "compressedAt": row[5]}

def row_to_adjustment(row):
  return {"adjustedAt": row[0], "adjustmentType": row[1], "field": row[2], "oldValue": row[3], "newValue": row[4], "reason": row[5]}

def row_to_session_log(row):
  return {"id": row[0], "recordedAt": row[1], "toolName": row[2], "input": row[3], "output": row[4], "durationMs": row[5], "error": row[6], "queryContext": row[7]}

def row_to_review_signature(row):
  return {"signature": row[0], "discussedAt": row[1]}

result = None
if operation == "init":
  result = {"dbPath": db_path}
elif operation == "record_retrieval":
  now = int(time.time())
  con.execute(
    "INSERT INTO retrieval_events(hash,node_id,source,content_type,kind,retrieved_at,query_context) VALUES(?,?,?,?,?,?,?)",
    (payload["hash"], payload["nodeId"], payload["source"], payload["contentType"], payload["kind"], payload.get("retrievedAt", now), payload.get("queryContext", ""))
  )
  result = {"recorded": True}
elif operation == "record_compression":
  now = int(time.time())
  con.execute(
    "INSERT INTO compression_events(hash,node_id,source,content_type,kind,compressed_at) VALUES(?,?,?,?,?,?)",
    (payload["hash"], payload["nodeId"], payload["source"], payload["contentType"], payload["kind"], payload.get("compressedAt", now))
  )
  result = {"recorded": True}
elif operation == "list_retrieval_events":
  since = payload.get("since")
  if since is None:
    rows = con.execute("SELECT hash,node_id,source,content_type,kind,retrieved_at,query_context FROM retrieval_events ORDER BY retrieved_at ASC").fetchall()
  else:
    rows = con.execute("SELECT hash,node_id,source,content_type,kind,retrieved_at,query_context FROM retrieval_events WHERE retrieved_at >= ? ORDER BY retrieved_at ASC", (since,)).fetchall()
  result = [row_to_retrieval(row) for row in rows]
elif operation == "list_compression_events":
  since = payload.get("since")
  if since is None:
    rows = con.execute("SELECT hash,node_id,source,content_type,kind,compressed_at FROM compression_events ORDER BY compressed_at ASC").fetchall()
  else:
    rows = con.execute("SELECT hash,node_id,source,content_type,kind,compressed_at FROM compression_events WHERE compressed_at >= ? ORDER BY compressed_at ASC", (since,)).fetchall()
  result = [row_to_compression(row) for row in rows]
elif operation == "aggregate":
  retrievals = con.execute("SELECT source, content_type, kind, COUNT(*) FROM retrieval_events GROUP BY source, content_type, kind").fetchall()
  compressions = con.execute("SELECT source, content_type, kind, COUNT(*) FROM compression_events GROUP BY source, content_type, kind").fetchall()
  result = {"retrievals": [{"source": r[0], "contentType": r[1], "kind": r[2], "count": r[3]} for r in retrievals], "compressions": [{"source": c[0], "contentType": c[1], "kind": c[2], "count": c[3]} for c in compressions]}
elif operation == "find_compression_by_hash":
  row = con.execute(
    "SELECT hash,node_id,source,content_type,kind,compressed_at FROM compression_events WHERE hash=? ORDER BY compressed_at DESC LIMIT 1",
    (payload["hash"],)
  ).fetchone()
  result = row_to_compression(row) if row is not None else None
elif operation == "record_session_log":
  now = int(time.time())
  con.execute(
    "INSERT INTO session_logs(recorded_at,tool_name,input,output,duration_ms,error,query_context) VALUES(?,?,?,?,?,?,?)",
    (payload.get("recordedAt", now), payload["toolName"], payload.get("input", ""), payload.get("output", ""), payload.get("durationMs", 0), payload.get("error", ""), payload.get("queryContext", ""))
  )
  result = {"recorded": True}
elif operation == "list_session_logs":
  rows = con.execute("SELECT id,recorded_at,tool_name,input,output,duration_ms,error,query_context FROM session_logs ORDER BY recorded_at ASC").fetchall()
  result = [row_to_session_log(row) for row in rows]
elif operation == "clear_session_logs":
  con.execute("DELETE FROM session_logs")
  result = {"cleared": True}
elif operation == "record_review_signature":
  con.execute(
    "INSERT INTO review_context(signature, discussed_at) VALUES(?, ?) ON CONFLICT(signature) DO UPDATE SET discussed_at=excluded.discussed_at",
    (payload["signature"], payload.get("discussedAt", int(time.time())))
  )
  result = {"recorded": True}
elif operation == "list_review_signatures":
  since = payload.get("since")
  if since is None:
    rows = con.execute("SELECT signature, discussed_at FROM review_context ORDER BY discussed_at ASC, signature ASC").fetchall()
  else:
    rows = con.execute("SELECT signature, discussed_at FROM review_context WHERE discussed_at >= ? ORDER BY discussed_at ASC, signature ASC", (since,)).fetchall()
  result = [row_to_review_signature(row) for row in rows]
elif operation == "clear_review_signatures":
  con.execute("DELETE FROM review_context")
  result = {"cleared": True}
elif operation == "record_adjustment":
  con.execute(
    "INSERT INTO ranking_adjustments(adjusted_at,adjustment_type,field,old_value,new_value,reason) VALUES(?,?,?,?,?,?)",
    (payload["adjustedAt"], payload["adjustmentType"], payload["field"], payload["oldValue"], payload["newValue"], payload["reason"])
  )
  result = {"recorded": True}
elif operation == "list_adjustments":
  rows = con.execute("SELECT adjusted_at,adjustment_type,field,old_value,new_value,reason FROM ranking_adjustments ORDER BY adjusted_at ASC").fetchall()
  result = [row_to_adjustment(row) for row in rows]
elif operation == "clear":
  con.execute("DELETE FROM retrieval_events")
  con.execute("DELETE FROM compression_events")
  con.execute("DELETE FROM feedback_summary")
  con.execute("DELETE FROM ranking_adjustments")
  con.execute("DELETE FROM session_logs")
  con.execute("DELETE FROM review_context")
  result = {"cleared": True}
else:
  raise ValueError(f"unknown operation: {operation}")

con.commit()
con.close()
print(json.dumps({"ok": True, "result": result}, sort_keys=True))
`;

export function feedbackStorePath(projectPath: string): string {
  return join(zincgraphDataDir(projectPath), 'fusion.sqlite');
}

export interface FeedbackStoreOptions {
  projectPath: string;
}

export class FeedbackStore {
  readonly dbPath: string;

  constructor(options: FeedbackStoreOptions | string) {
    const projectPath = typeof options === 'string' ? options : options.projectPath;
    const resolved = resolve(projectPath);
    this.dbPath = resolved.endsWith('.sqlite') ? resolved : feedbackStorePath(resolved);
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.run('init', {});
  }

  recordRetrieval(event: RetrievalEvent): void {
    this.run('record_retrieval', event);
  }

  recordCompression(event: CompressionEvent): void {
    this.run('record_compression', event);
  }

  listRetrievalEvents(since?: number): RetrievalEvent[] {
    return this.run<RetrievalEvent[]>('list_retrieval_events', since !== undefined ? { since } : {});
  }

  listCompressionEvents(since?: number): CompressionEvent[] {
    return this.run<CompressionEvent[]>('list_compression_events', since !== undefined ? { since } : {});
  }

  aggregate(): { retrievals: Array<{ source: string; contentType: string; kind: string; count: number }>; compressions: Array<{ source: string; contentType: string; kind: string; count: number }> } {
    return this.run('aggregate', {});
  }

  findCompressionByHash(hash: string): CompressionEvent | null {
    return this.run<CompressionEvent | null>('find_compression_by_hash', { hash });
  }

  recordSessionLog(log: SessionLog): void {
    this.run('record_session_log', log);
  }

  listSessionLogs(): SessionLog[] {
    return this.run<SessionLog[]>('list_session_logs', {});
  }

  clearSessionLogs(): void {
    this.run('clear_session_logs', {});
  }

  recordReviewSignature(record: ReviewSignatureRecord): void {
    this.run('record_review_signature', record);
  }

  listReviewSignatures(since?: number): ReviewSignatureRecord[] {
    return this.run<ReviewSignatureRecord[]>('list_review_signatures', since !== undefined ? { since } : {});
  }

  clearReviewSignatures(): void {
    this.run('clear_review_signatures', {});
  }

  recordAdjustment(record: RankingAdjustmentRecord): void {
    this.run('record_adjustment', record);
  }

  listAdjustments(): RankingAdjustmentRecord[] {
    return this.run<RankingAdjustmentRecord[]>('list_adjustments', {});
  }

  clear(): void {
    this.run('clear', {});
  }

  close(): void {
    // Short-lived Python processes; nothing to close.
  }

  private run<T>(operation: string, payload: unknown): T {
    const py = process.platform === 'win32' ? 'python' : 'python3';
    const child = spawnSync(py, ['-c', FEEDBACK_PYTHON_SCRIPT], {
      input: JSON.stringify({ dbPath: this.dbPath, operation, payload }),
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });

    if (child.status !== 0) {
      throw new Error(child.stderr || `feedback store operation failed: ${operation}`);
    }

    const response = JSON.parse(child.stdout) as FusionResponse<T>;
    if (!response.ok) {
      throw new Error(response.error ?? `feedback store operation failed: ${operation}`);
    }
    return response.result as T;
  }
}
