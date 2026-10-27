import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_PATH =
  process.env.REGISTRY_DB_PATH ?? path.join(process.cwd(), "data", "registry.db");

export const SESSION_TTL_MS = 600000;

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
      stake_balance INTEGER NOT NULL DEFAULT 100,
      title TEXT,
      description TEXT,
      category TEXT,
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
        CHECK (status IN ('NEGOTIATING', 'ESCROW_LOCKED', 'DELIVERED', 'SETTLED', 'REJECTED', 'EXPIRED')),
      agreed_price INTEGER CHECK (agreed_price IS NULL OR agreed_price > 0),
      brief TEXT NOT NULL,
      buyer_budget INTEGER NOT NULL CHECK (buyer_budget > 0),
      delivery_payload TEXT,
      delivery_reject_reason TEXT,
      escrow_locked INTEGER NOT NULL DEFAULT 0 CHECK (escrow_locked >= 0),
      quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
      expires_at INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wallets (
      agent_id TEXT PRIMARY KEY,
      balance INTEGER NOT NULL DEFAULT 1000 CHECK (balance >= 0)
    );
  `);
  const backfillColumns = [
    ["sessions", "delivery_payload", "TEXT"],
    ["sessions", "delivery_reject_reason", "TEXT"],
    ["sessions", "escrow_locked", "INTEGER NOT NULL DEFAULT 0"],
    ["sessions", "quantity", "INTEGER NOT NULL DEFAULT 1"],
    ["sessions", "expires_at", "INTEGER"],
    ["agents", "stake_balance", "INTEGER NOT NULL DEFAULT 100"],
    ["agents", "title", "TEXT"],
    ["agents", "description", "TEXT"],
    ["agents", "category", "TEXT"],
  ];
  for (const [table, column, type] of backfillColumns) {
    const exists = db
      .prepare(`SELECT name FROM pragma_table_info('${table}') WHERE name = ?`)
      .get(column);
    if (!exists) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
  db.prepare("UPDATE sessions SET expires_at = ? WHERE expires_at IS NULL").run(
    Date.now() + SESSION_TTL_MS
  );
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
