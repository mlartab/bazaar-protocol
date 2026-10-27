import assert from "node:assert/strict";
import test from "node:test";

// Loopback fetch must never go through a proxy (sandboxed/proxied CI).
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");
process.env.no_proxy = [process.env.no_proxy, "127.0.0.1,localhost"].filter(Boolean).join(",");
import Database from "better-sqlite3";
import { registerAgent } from "../src/agent-store.js";
import { createDb, initSchema } from "../src/db.js";
import { creditWallet, getBalance, lockFunds, refundFunds, releaseFunds, slashStake } from "../src/ledger.js";
import { createSession, deliverWork, getSession, submitMove } from "../src/session-manager.js";
import { createApp } from "../server.mjs";

const validAgent = (overrides = {}) => ({
  agentId: "seller-1",
  publicKey: "pk-test-123",
  capability: "image_gen",
  floorPrice: 100,
  webhookUrl: "https://example.com/hook",
  ...overrides,
});

const seedSeller = (db, overrides = {}) => {
  const result = registerAgent(validAgent(overrides), { db });
  assert.equal(result.success, true);
  return result.agent;
};

const balanceOf = (db, agentId) =>
  db.prepare("SELECT balance FROM wallets WHERE agent_id = ?").get(agentId)?.balance;

const escrowOf = (db, sessionId) =>
  db.prepare("SELECT escrow_locked FROM sessions WHERE id = ?").get(sessionId).escrow_locked;

const settleInspector = async () => ({ success: true, status: "SETTLED" });
const rejectInspector = async () => ({
  success: false,
  status: "REJECTED",
  reason: "VISUAL_MISMATCH",
});

async function withServer(db, fn, appOptions = {}) {
  const server = createApp(db, appOptions);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const postJson = (url, body, key) =>
  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  });

test("wallets start at 1000 and ACCEPT locks funds atomically", () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });

  assert.equal(getBalance("buyer-1", db), 1000);
  assert.equal(getBalance("seller-1", db), 1000);

  const created = createSession("buyer-1", "seller-1", { title: "hero", budget: 500 }, { db });
  assert.equal(created.success, true);

  const accept = submitMove(
    created.session.sessionId,
    "seller-1",
    { action: "ACCEPT", price: 200 },
    { db }
  );
  assert.equal(accept.success, true);
  assert.equal(accept.session.status, "ESCROW_LOCKED");

  assert.equal(balanceOf(db, "buyer-1"), 800);
  assert.equal(balanceOf(db, "seller-1"), 1000);
  assert.equal(escrowOf(db, created.session.sessionId), 200);
  assert.equal(getSession(created.session.sessionId, { db }).escrowLocked, 200);
});

test("ACCEPT with insufficient funds fails and leaves state untouched", () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  const created = createSession("buyer-1", "seller-1", { title: "hero", budget: 500 }, { db });

  getBalance("buyer-1", db);
  db.prepare("UPDATE wallets SET balance = ? WHERE agent_id = ?").run(100, "buyer-1");

  const accept = submitMove(
    created.session.sessionId,
    "seller-1",
    { action: "ACCEPT", price: 200 },
    { db }
  );
  assert.equal(accept.success, false);
  assert.equal(accept.error.code, "INSUFFICIENT_FUNDS");

  const row = db
    .prepare("SELECT status, agreed_price, escrow_locked FROM sessions WHERE id = ?")
    .get(created.session.sessionId);
  assert.equal(row.status, "NEGOTIATING");
  assert.equal(row.agreed_price, null);
  assert.equal(row.escrow_locked, 0);
  assert.equal(balanceOf(db, "buyer-1"), 100);
});

test("SETTLED moves escrow to the seller", async () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  const created = createSession("buyer-1", "seller-1", { title: "hero", budget: 500 }, { db });
  submitMove(created.session.sessionId, "seller-1", { action: "ACCEPT", price: 200 }, { db });

  assert.equal(balanceOf(db, "buyer-1"), 800);
  assert.equal(balanceOf(db, "seller-1"), 1000);

  const result = await deliverWork(created.session.sessionId, "seller-1", "https://example.com/creative.png", {
    db,
    verifyDelivery: settleInspector,
  });
  assert.equal(result.success, true);
  assert.equal(result.session.status, "SETTLED");

  assert.equal(balanceOf(db, "buyer-1"), 800);
  assert.equal(balanceOf(db, "seller-1"), 1200);
  assert.equal(escrowOf(db, created.session.sessionId), 0);
});

test("REJECTED refunds escrow and pays the penalty bonus to the buyer", async () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  const created = createSession("buyer-1", "seller-1", { title: "hero", budget: 500 }, { db });
  submitMove(created.session.sessionId, "seller-1", { action: "ACCEPT", price: 200 }, { db });

  const result = await deliverWork(created.session.sessionId, "seller-1", "https://example.com/wrong.png", {
    db,
    verifyDelivery: rejectInspector,
  });
  assert.equal(result.success, true);
  assert.equal(result.session.status, "REJECTED");

  assert.equal(balanceOf(db, "buyer-1"), 1050);
  assert.equal(balanceOf(db, "seller-1"), 1000);
  assert.equal(escrowOf(db, created.session.sessionId), 0);
});

test("ledger guards: wrong owner, double release, and bad amount", () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  const created = createSession("buyer-1", "seller-1", { title: "hero", budget: 500 }, { db });
  const sessionId = created.session.sessionId;

  assert.equal(lockFunds("buyer-1", sessionId, 0, db).error.code, "INVALID_AMOUNT");
  assert.equal(lockFunds("intruder", sessionId, 200, db).error.code, "NOT_PARTICIPANT");

  const locked = lockFunds("buyer-1", sessionId, 200, db);
  assert.equal(locked.success, true);
  assert.equal(locked.escrowLocked, 200);
  assert.equal(locked.balance, 800);

  assert.equal(lockFunds("buyer-1", sessionId, 200, db).error.code, "INVALID_STATE");
  assert.equal(releaseFunds("seller-1", "missing-session", db).error.code, "SESSION_NOT_FOUND");

  const released = releaseFunds("seller-1", sessionId, db);
  assert.equal(released.success, true);
  assert.equal(released.released, 200);
  assert.equal(released.balance, 1200);

  assert.equal(releaseFunds("seller-1", sessionId, db).error.code, "NO_ESCROW");
  assert.equal(refundFunds("buyer-1", sessionId, db).error.code, "NO_ESCROW");
});

test("initSchema backfills escrow_locked on a legacy sessions table", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE agents (agent_id TEXT PRIMARY KEY, public_key TEXT NOT NULL, capability TEXT NOT NULL, floor_price INTEGER NOT NULL, webhook_url TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE', hex_seal TEXT NOT NULL, did TEXT, created_at TEXT NOT NULL);
    CREATE TABLE idempotency_keys (key TEXT PRIMARY KEY, agent_id TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, buyer_id TEXT NOT NULL, seller_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'NEGOTIATING', agreed_price INTEGER,
      brief TEXT NOT NULL, buyer_budget INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO sessions (id, buyer_id, seller_id, status, brief, buyer_budget, created_at)
    VALUES ('legacy-1', 'buyer-1', 'seller-1', 'NEGOTIATING', '{}', 500, '2026-01-01T00:00:00.000Z');
    INSERT INTO agents (agent_id, public_key, capability, floor_price, webhook_url, status, hex_seal, created_at)
    VALUES ('seller-1', 'pk', 'image_gen', 100, 'https://example.com/hook', 'ACTIVE', 'seal', '2026-01-01T00:00:00.000Z');
  `);
  initSchema(db);

  const columns = db.prepare("SELECT name FROM pragma_table_info('sessions')").all().map((r) => r.name);
  assert.ok(columns.includes("escrow_locked"));
  assert.ok(columns.includes("delivery_payload"));
  assert.ok(columns.includes("quantity"));
  assert.equal(db.prepare("SELECT escrow_locked FROM sessions WHERE id = ?").get("legacy-1").escrow_locked, 0);
  assert.equal(db.prepare("SELECT quantity FROM sessions WHERE id = ?").get("legacy-1").quantity, 1);
  assert.ok(columns.includes("expires_at"));
  assert.ok(
    db.prepare("SELECT expires_at FROM sessions WHERE id = ?").get("legacy-1").expires_at > Date.now()
  );

  const agentColumns = db.prepare("SELECT name FROM pragma_table_info('agents')").all().map((r) => r.name);
  assert.ok(agentColumns.includes("stake_balance"));
  assert.equal(
    db.prepare("SELECT stake_balance FROM agents WHERE agent_id = ?").get("seller-1").stake_balance,
    100
  );

  const wallets = db.prepare("SELECT name FROM sqlite_master WHERE name = 'wallets'").get();
  assert.ok(wallets);
  db.close();
});

test("GET /api/wallets/:agentId tracks balances before and after settlement", async () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  await withServer(db, async (base) => {
    const beforeBuyer = await fetch(`${base}/api/wallets/buyer-1`);
    assert.equal(beforeBuyer.status, 200);
    assert.deepEqual(await beforeBuyer.json(), { agentId: "buyer-1", balance: 1000 });

    const created = await postJson(
      `${base}/api/sessions`,
      { buyerId: "buyer-1", sellerId: "seller-1", brief: { title: "hero", budget: 500 } },
      "wallet-sess-1"
    );
    assert.equal(created.status, 201);
    const { sessionId } = await created.json();

    const accepted = await postJson(
      `${base}/api/sessions/${sessionId}/negotiate`,
      { agentId: "seller-1", move: { action: "ACCEPT", price: 200 } },
      "wallet-move-1"
    );
    assert.equal(accepted.status, 200);

    const lockedBuyer = await fetch(`${base}/api/wallets/buyer-1`);
    assert.deepEqual(await lockedBuyer.json(), { agentId: "buyer-1", balance: 800 });

    const settled = await postJson(
      `${base}/api/sessions/${sessionId}/deliver`,
      { agentId: "seller-1", payload: "https://example.com/creative.png" },
      "wallet-deliver-1"
    );
    assert.equal(settled.status, 200);

    const afterSeller = await fetch(`${base}/api/wallets/seller-1`);
    assert.deepEqual(await afterSeller.json(), { agentId: "seller-1", balance: 1200 });
    const afterBuyer = await fetch(`${base}/api/wallets/buyer-1`);
    assert.deepEqual(await afterBuyer.json(), { agentId: "buyer-1", balance: 800 });
  }, { verifyDelivery: settleInspector });
});

test("registration seeds a wallet and idempotent replays never double-move money", async () => {
  const db = createDb();
  await withServer(db, async (base) => {
    const registered = await postJson(
      `${base}/api/agents/register`,
      validAgent({ agentId: "seller-9" }),
      "wallet-reg-1"
    );
    assert.equal(registered.status, 201);
    const wallet = await fetch(`${base}/api/wallets/seller-9`);
    assert.deepEqual(await wallet.json(), { agentId: "seller-9", balance: 1000 });

    const created = await postJson(
      `${base}/api/sessions`,
      { buyerId: "buyer-9", sellerId: "seller-9", brief: { title: "hero", budget: 500 } },
      "wallet-sess-2"
    );
    const { sessionId } = await created.json();

    const acceptBody = { agentId: "seller-9", move: { action: "ACCEPT", price: 200 } };
    const first = await postJson(`${base}/api/sessions/${sessionId}/negotiate`, acceptBody, "wallet-move-2");
    assert.equal(first.status, 200);
    const firstJson = await first.json();
    const replay = await postJson(`${base}/api/sessions/${sessionId}/negotiate`, acceptBody, "wallet-move-2");
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), firstJson);

    const buyerWallet = await fetch(`${base}/api/wallets/buyer-9`);
    assert.deepEqual(await buyerWallet.json(), { agentId: "buyer-9", balance: 800 });

    const deliverBody = { agentId: "seller-9", payload: "https://example.com/creative.png" };
    const delivered = await postJson(`${base}/api/sessions/${sessionId}/deliver`, deliverBody, "wallet-deliver-2");
    assert.equal(delivered.status, 200);
    const deliveredReplay = await postJson(
      `${base}/api/sessions/${sessionId}/deliver`,
      deliverBody,
      "wallet-deliver-2"
    );
    assert.equal(deliveredReplay.status, 200);

    const sellerWallet = await fetch(`${base}/api/wallets/seller-9`);
    assert.deepEqual(await sellerWallet.json(), { agentId: "seller-9", balance: 1200 });
  }, { verifyDelivery: settleInspector });
});

test("API surfaces INSUFFICIENT_FUNDS as 422 without locking", async () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  getBalance("buyer-1", db);
  db.prepare("UPDATE wallets SET balance = ? WHERE agent_id = ?").run(50, "buyer-1");

  await withServer(db, async (base) => {
    const created = await postJson(
      `${base}/api/sessions`,
      { buyerId: "buyer-1", sellerId: "seller-1", brief: { title: "hero", budget: 500 } },
      "wallet-sess-3"
    );
    const { sessionId } = await created.json();

    const accept = await postJson(
      `${base}/api/sessions/${sessionId}/negotiate`,
      { agentId: "seller-1", move: { action: "ACCEPT", price: 200 } },
      "wallet-move-3"
    );
    assert.equal(accept.status, 422);
    assert.equal((await accept.json()).error.code, "INSUFFICIENT_FUNDS");
    assert.equal(escrowOf(db, sessionId), 0);
    assert.equal(balanceOf(db, "buyer-1"), 50);
  });
});

test("slashStake deducts stake and suspends below 20", () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  seedSeller(db, { agentId: "seller-2", floorPrice: 100 });

  const first = slashStake("seller-1", 50, db);
  assert.deepEqual(first, { success: true, stakeBalance: 50, status: "ACTIVE" });

  const boundary = slashStake("seller-2", 80, db);
  assert.deepEqual(boundary, { success: true, stakeBalance: 20, status: "ACTIVE" });

  const second = slashStake("seller-1", 50, db);
  assert.deepEqual(second, { success: true, stakeBalance: 0, status: "SUSPENDED" });
  assert.equal(
    db.prepare("SELECT status FROM agents WHERE agent_id = ?").get("seller-1").status,
    "SUSPENDED"
  );

  assert.equal(slashStake("ghost", 50, db).error.code, "SELLER_NOT_FOUND");
  assert.equal(slashStake("seller-1", 0, db).error.code, "INVALID_AMOUNT");
});

test("creditWallet tops up an existing or new wallet", () => {
  const db = createDb();
  assert.deepEqual(creditWallet("buyer-1", 50, db), { success: true, balance: 1050 });
  assert.deepEqual(creditWallet("buyer-1", 25, db), { success: true, balance: 1075 });
  assert.equal(creditWallet("buyer-1", -5, db).error.code, "INVALID_AMOUNT");
});
