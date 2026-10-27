import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_PATH =
  process.env.REGISTRY_DB_PATH ?? path.join(process.cwd(), "data", "registry.db");

let singleton = null;

export function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL,
      capability TEXT NOT NULL,
      floor_price INTEGER NOT NULL CHECK (floor_price > 0),
      webhook_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      hex_seal TEXT NOT NULL,
      did TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      buyer_id TEXT NOT NULL,
      seller_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'NEGOTIATING'
        CHECK (status IN ('NEGOTIATING', 'ESCROW_LOCKED', 'DELIVERED', 'SETTLED', 'REJECTED')),
      agreed_price INTEGER CHECK (agreed_price IS NULL OR agreed_price > 0),
      brief TEXT NOT NULL,
      buyer_budget INTEGER NOT NULL CHECK (buyer_budget > 0),
      delivery_payload TEXT,
      delivery_reject_reason TEXT,
      created_at TEXT NOT NULL
    );
  `);
  for (const column of ["delivery_payload", "delivery_reject_reason"]) {
    const exists = db
      .prepare("SELECT name FROM pragma_table_info('sessions') WHERE name = ?")
      .get(column);
    if (!exists) {
      db.exec(`ALTER TABLE sessions ADD COLUMN ${column} TEXT`);
    }
  }
  return db;
}

export function createDb(filename = ":memory:") {
  if (filename !== ":memory:") {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  return initSchema(db);
}

export function getDb() {
  if (!singleton) {
    singleton = createDb(DEFAULT_PATH);
  }
  return singleton;
}

export function setDb(db) {
  singleton = db;
}
