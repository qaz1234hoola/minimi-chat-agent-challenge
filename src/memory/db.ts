import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

const DATA_DIR = path.resolve(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "memory.db");

export const db = new Database(DB_PATH);

// Enable Write-Ahead Logging so background writes never block concurrent reads
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Load the native sqlite-vec C extension for 768-dim cosine similarity
sqliteVec.load(db);

db.exec(`
  -- 1. Core episodic log (raw user + assistant pairs + exact temporal metadata)
  CREATE TABLE IF NOT EXISTS episodic_turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_index INTEGER NOT NULL,
    user_message TEXT NOT NULL,
    assistant_response TEXT NOT NULL,
    created_at_iso TEXT NOT NULL,
    date_only TEXT NOT NULL,
    day_of_week TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_turns_date ON episodic_turns(date_only);
  CREATE INDEX IF NOT EXISTS idx_turns_session ON episodic_turns(session_id, turn_index);

  -- 2. Structured facts & prior claims extracted asynchronously in onFinish
  CREATE TABLE IF NOT EXISTS turn_snapshots (
    turn_id TEXT PRIMARY KEY REFERENCES episodic_turns(id) ON DELETE CASCADE,
    topic_summary TEXT NOT NULL,
    entities_json TEXT NOT NULL,
    claims_json TEXT NOT NULL
  );

  -- 3. BM25 Full-Text Search index for exact proper nouns / product names
  CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
    turn_id UNINDEXED,
    user_message,
    assistant_response,
    topic_summary,
    entities_json
  );

  -- 4. Vector search table (768 dims matching nomic-embed-text-v1.5)
  CREATE VIRTUAL TABLE IF NOT EXISTS turns_vec USING vec0(
    turn_id TEXT PRIMARY KEY,
    embedding FLOAT[768] distance_metric=cosine
  );
`);

console.log(`[DB] SQLite initialized in WAL mode at ${DB_PATH}`);