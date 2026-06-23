import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

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

interface FusionResponse<T> {
  ok: boolean;
  result?: T;
  error?: string;
}

const CCR_PYTHON_SCRIPT = String.raw`
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
CREATE TABLE IF NOT EXISTS ccr_entries(
  hash TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text',
  created_at INTEGER NOT NULL,
  ttl INTEGER NOT NULL DEFAULT 3600,
  retrieval_count INTEGER NOT NULL DEFAULT 0,
  last_retrieved_at INTEGER
)
""")
columns = [row[1] for row in con.execute("PRAGMA table_info(ccr_entries)").fetchall()]
if "content_type" not in columns:
  con.execute("ALTER TABLE ccr_entries ADD COLUMN content_type TEXT NOT NULL DEFAULT 'text'")
if "retrieval_count" not in columns:
  con.execute("ALTER TABLE ccr_entries ADD COLUMN retrieval_count INTEGER NOT NULL DEFAULT 0")
if "last_retrieved_at" not in columns:
  con.execute("ALTER TABLE ccr_entries ADD COLUMN last_retrieved_at INTEGER")
con.execute("CREATE INDEX IF NOT EXISTS idx_ccr_entries_created ON ccr_entries(created_at)")
con.execute("""
CREATE TABLE IF NOT EXISTS metadata(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)
""")

def row_to_ccr(row):
  return {
    "hash": row[0],
    "content": row[1],
    "contentType": row[2],
    "createdAt": row[3],
    "ttl": row[4],
    "retrievalCount": row[5],
    "lastRetrievedAt": row[6]
  }

result = None
if operation == "init":
  result = {"dbPath": db_path}
elif operation == "put":
  now = int(time.time())
  con.execute(
    "INSERT INTO ccr_entries(hash,content,content_type,created_at,ttl,retrieval_count,last_retrieved_at) VALUES(?,?,?,?,?,0,NULL) "
    "ON CONFLICT(hash) DO UPDATE SET content=excluded.content,content_type=excluded.content_type,created_at=excluded.created_at,ttl=excluded.ttl,last_retrieved_at=excluded.last_retrieved_at",
    (payload["hash"], payload["content"], payload.get("contentType", "text"), now, payload.get("ttl", 3600))
  )
  result = {"hash": payload["hash"]}
elif operation == "get":
  row = con.execute(
    "SELECT hash,content,content_type,created_at,ttl,retrieval_count,last_retrieved_at FROM ccr_entries WHERE hash=?",
    (payload["hash"],)
  ).fetchone()
  if row is not None:
    con.execute(
      "UPDATE ccr_entries SET retrieval_count=retrieval_count+1,last_retrieved_at=? WHERE hash=?",
      (int(time.time()), payload["hash"])
    )
    result = row_to_ccr(row)
  else:
    result = None
elif operation == "search":
  query = payload.get("query", "")
  terms = query.lower().split()
  if not terms:
    result = []
  else:
    like_clauses = " AND ".join(["content LIKE ?"] * len(terms))
    params = [f"%{t}%" for t in terms]
    rows = con.execute(
      f"SELECT hash,content,content_type,created_at,ttl,retrieval_count,last_retrieved_at FROM ccr_entries WHERE {like_clauses} ORDER BY created_at DESC LIMIT ?",
      (*params, payload.get("limit", 10))
    ).fetchall()
    result = [row_to_ccr(row) for row in rows]
elif operation == "stats":
  row = con.execute(
    "SELECT COUNT(*), COALESCE(SUM(LENGTH(content)),0), COALESCE(SUM(retrieval_count),0) FROM ccr_entries"
  ).fetchone()
  result = {"entryCount": row[0], "totalContentBytes": row[1], "totalRetrievals": row[2]}
elif operation == "evict_expired":
  now = int(time.time())
  cursor = con.execute("DELETE FROM ccr_entries WHERE created_at + ttl < ?", (now,))
  result = {"evicted": cursor.rowcount}
elif operation == "evict_lru":
  limit = payload.get("limit", 10)
  cursor = con.execute(
    "DELETE FROM ccr_entries WHERE hash IN (SELECT hash FROM ccr_entries ORDER BY retrieval_count ASC, created_at ASC LIMIT ?)",
    (limit,)
  )
  result = {"evicted": cursor.rowcount}
elif operation == "clear":
  con.execute("DELETE FROM ccr_entries")
  result = {"cleared": True}
else:
  raise ValueError(f"unknown operation: {operation}")

con.commit()
con.close()
print(json.dumps({"ok": True, "result": result}, sort_keys=True))
`;

export function ccrStorePath(projectPath: string): string {
  return join(zincgraphDataDir(projectPath), 'fusion.sqlite');
}

export class CcrStore {
  readonly dbPath: string;
  private readonly defaultTtl: number;

  constructor(options: CcrStoreOptions) {
    const resolved = resolve(options.projectPath);
    this.dbPath = resolved.endsWith('.sqlite') ? resolved : ccrStorePath(resolved);
    this.defaultTtl = options.defaultTtl ?? 3600;
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.run('init', {});
  }

  put(hash: string, content: string, contentType: string, ttl?: number): void {
    this.run('put', { hash, content, contentType, ttl: ttl ?? this.defaultTtl });
  }

  get(hash: string): CcrEntry | null {
    return this.run<CcrEntry | null>('get', { hash });
  }

  search(query: string, limit?: number): CcrEntry[] {
    return this.run<CcrEntry[]>('search', { query, limit: limit ?? 10 });
  }

  stats(): { entryCount: number; totalContentBytes: number; totalRetrievals: number } {
    return this.run('stats', {});
  }

  evictExpired(): number {
    const result = this.run<{ evicted: number }>('evict_expired', {});
    return result.evicted;
  }

  evictLru(limit?: number): number {
    const result = this.run<{ evicted: number }>('evict_lru', { limit: limit ?? 10 });
    return result.evicted;
  }

  clear(): void {
    this.run('clear', {});
  }

  close(): void {
    // Short-lived Python processes; nothing to close.
  }

  private run<T>(operation: string, payload: unknown): T {
    const py = process.platform === 'win32' ? 'python' : 'python3';
    const child = spawnSync(py, ['-c', CCR_PYTHON_SCRIPT], {
      input: JSON.stringify({ dbPath: this.dbPath, operation, payload }),
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });

    if (child.status !== 0) {
      throw new Error(child.stderr || `ccr store operation failed: ${operation}`);
    }

    const response = JSON.parse(child.stdout) as FusionResponse<T>;
    if (!response.ok) {
      throw new Error(response.error ?? `ccr store operation failed: ${operation}`);
    }
    return response.result as T;
  }
}
