import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

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

interface FusionResponse<T> {
  ok: boolean;
  result?: T;
  error?: string;
}

const PYTHON_SCRIPT = String.raw`
import json
import sqlite3
import sys

request = json.loads(sys.stdin.read())
db_path = request["dbPath"]
operation = request["operation"]
payload = request.get("payload", {})

con = sqlite3.connect(db_path)
con.execute("PRAGMA journal_mode=WAL")
con.execute("PRAGMA synchronous=NORMAL")
con.execute("""
CREATE TABLE IF NOT EXISTS vector_documents(
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  embedding_profile TEXT NOT NULL,
  chunker_version TEXT NOT NULL DEFAULT 'codegraph-node-v1',
  json TEXT NOT NULL
)
""")
columns = [row[1] for row in con.execute("PRAGMA table_info(vector_documents)").fetchall()]
if "chunker_version" not in columns:
  con.execute("ALTER TABLE vector_documents ADD COLUMN chunker_version TEXT NOT NULL DEFAULT 'codegraph-node-v1'")
con.execute("""
CREATE TABLE IF NOT EXISTS manifest_entries(
  entry_key TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  embedding_profile TEXT NOT NULL,
  chunker_version TEXT NOT NULL,
  json TEXT NOT NULL
)
""")
con.execute("""
CREATE TABLE IF NOT EXISTS metadata(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)
""")
con.execute("CREATE INDEX IF NOT EXISTS idx_vector_documents_file ON vector_documents(file_path)")
con.execute("CREATE INDEX IF NOT EXISTS idx_manifest_entries_file ON manifest_entries(file_path)")

def row_to_vector(row):
  return {"id": row[0], "nodeId": row[1], "filePath": row[2], "embeddingProfile": row[3], "chunkerVersion": row[4], "json": json.loads(row[5])}

def row_to_manifest(row):
  return {"entryKey": row[0], "filePath": row[1], "embeddingProfile": row[2], "chunkerVersion": row[3], "json": json.loads(row[4])}

result = None
if operation == "init":
  result = {"dbPath": db_path}
elif operation == "upsert_vector_documents":
  docs = payload.get("documents", [])
  con.executemany(
    "INSERT INTO vector_documents(id,node_id,file_path,embedding_profile,chunker_version,json) VALUES(?,?,?,?,?,?) "
    "ON CONFLICT(id) DO UPDATE SET node_id=excluded.node_id,file_path=excluded.file_path,embedding_profile=excluded.embedding_profile,chunker_version=excluded.chunker_version,json=excluded.json",
    [(d["id"], d["nodeId"], d["filePath"], d["embeddingProfile"], d.get("chunkerVersion", "codegraph-node-v1"), json.dumps(d["json"], sort_keys=True)) for d in docs]
  )
  result = {"count": len(docs)}
elif operation == "list_vector_documents":
  rows = con.execute("SELECT id,node_id,file_path,embedding_profile,chunker_version,json FROM vector_documents ORDER BY id").fetchall()
  result = [row_to_vector(row) for row in rows]
elif operation == "count_vector_documents":
  result = con.execute("SELECT count(*) FROM vector_documents").fetchone()[0]
elif operation == "upsert_manifest_entries":
  entries = payload.get("entries", [])
  con.executemany(
    "INSERT INTO manifest_entries(entry_key,file_path,embedding_profile,chunker_version,json) VALUES(?,?,?,?,?) "
    "ON CONFLICT(entry_key) DO UPDATE SET file_path=excluded.file_path,embedding_profile=excluded.embedding_profile,chunker_version=excluded.chunker_version,json=excluded.json",
    [(e["entryKey"], e["filePath"], e["embeddingProfile"], e["chunkerVersion"], json.dumps(e["json"], sort_keys=True)) for e in entries]
  )
  result = {"count": len(entries)}
elif operation == "list_manifest_entries":
  rows = con.execute("SELECT entry_key,file_path,embedding_profile,chunker_version,json FROM manifest_entries ORDER BY file_path").fetchall()
  result = [row_to_manifest(row) for row in rows]
elif operation == "get_manifest_entry":
  row = con.execute("SELECT entry_key,file_path,embedding_profile,chunker_version,json FROM manifest_entries WHERE entry_key=?", (payload["entryKey"],)).fetchone()
  result = None if row is None else row_to_manifest(row)
elif operation == "set_metadata":
  con.execute("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (payload["key"], payload["value"]))
  result = True
elif operation == "get_metadata":
  row = con.execute("SELECT value FROM metadata WHERE key=?", (payload["key"],)).fetchone()
  result = None if row is None else row[0]
else:
  raise ValueError(f"unknown operation: {operation}")

con.commit()
con.close()
print(json.dumps({"ok": True, "result": result}, sort_keys=True))
`;

export function fusionStorePath(projectPath: string): string {
  return join(zincgraphDataDir(projectPath), 'fusion.sqlite');
}

export class FusionStore {
  readonly dbPath: string;

  constructor(projectPathOrDbPath: string) {
    const resolved = resolve(projectPathOrDbPath);
    this.dbPath = resolved.endsWith('.sqlite') ? resolved : fusionStorePath(resolved);
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.run('init', {});
  }

  upsertVectorDocuments(documents: readonly StoredVectorDocument[]): void {
    this.run('upsert_vector_documents', { documents });
  }

  listVectorDocuments(): StoredVectorDocument[] {
    return this.run<StoredVectorDocument[]>('list_vector_documents', {});
  }

  countVectorDocuments(): number {
    return this.run<number>('count_vector_documents', {});
  }

  upsertManifestEntries(entries: readonly StoredManifestEntry[]): void {
    this.run('upsert_manifest_entries', { entries });
  }

  listManifestEntries(): StoredManifestEntry[] {
    return this.run<StoredManifestEntry[]>('list_manifest_entries', {});
  }

  getManifestEntry(entryKey: string): StoredManifestEntry | null {
    return this.run<StoredManifestEntry | null>('get_manifest_entry', { entryKey });
  }

  setMetadata(key: string, value: string): void {
    this.run('set_metadata', { key, value });
  }

  getMetadata(key: string): string | null {
    return this.run<string | null>('get_metadata', { key });
  }

  close(): void {
    // Connections are short-lived Python sqlite3 processes; nothing to close here.
  }

  private run<T>(operation: string, payload: unknown): T {
    const py = process.platform === 'win32' ? 'python' : 'python3';
    const child = spawnSync(py, ['-c', PYTHON_SCRIPT], {
      input: JSON.stringify({ dbPath: this.dbPath, operation, payload }),
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });

    if (child.status !== 0) {
      throw new Error(child.stderr || `fusion sqlite operation failed: ${operation}`);
    }

    const response = JSON.parse(child.stdout) as FusionResponse<T>;
    if (!response.ok) {
      throw new Error(response.error ?? `fusion sqlite operation failed: ${operation}`);
    }
    return response.result as T;
  }
}
