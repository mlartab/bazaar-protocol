import assert from "node:assert/strict";
import test from "node:test";

// Loopback fetch must never go through a proxy (sandboxed/proxied CI).
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");
process.env.no_proxy = [process.env.no_proxy, "127.0.0.1,localhost"].filter(Boolean).join(",");
import { registerAgent } from "../src/agent-store.js";
import { createDb } from "../src/db.js";
import { createSession, deliverWork, submitMove } from "../src/session-manager.js";
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

const seedLockedSession = (db, { buyerId = "buyer-1", sellerId = "seller-1", budget = 500, price = 200 } = {}) => {
  const created = createSession(buyerId, sellerId, { title: "hero image", budget }, { db });
  assert.equal(created.success, true);
  const accept = submitMove(created.session.sessionId, "seller-1", { action: "ACCEPT", price }, { db });
  assert.equal(accept.success, true);
  return created.session.sessionId;
};

const settleInspector = async () => ({ success: true, status: "SETTLED" });
const rejectInspector = async () => ({
  success: false,
  status: "REJECTED",
  reason: "VISUAL_MISMATCH",
});
// Routes by payload token so HTTP-level tests stay deterministic without network.
const tokenInspector = async (_sessionId, payload) =>
  payload === "img_data_valid" ? settleInspector() : rejectInspector();

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

test("seller delivering valid data transitions the session to SETTLED", async () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  const sessionId = seedLockedSession(db);

  const result = await deliverWork(sessionId, "seller-1", "https://example.com/creative.png", {
    db,
    verifyDelivery: settleInspector,
  });
  assert.equal(result.success, true);
  assert.equal(result.session.status, "SETTLED");
  assert.equal(result.session.agreedPrice, 200);

  const row = db
    .prepare("SELECT status, delivery_payload, delivery_reject_reason FROM sessions WHERE id = ?")
    .get(sessionId);
  assert.equal(row.status, "SETTLED");
  assert.equal(row.delivery_payload, "https://example.com/creative.png");
  assert.equal(row.delivery_reject_reason, null);
});

test("seller delivering invalid data transitions the session to REJECTED", async () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  const sessionId = seedLockedSession(db);

  const result = await deliverWork(sessionId, "seller-1", "https://example.com/wrong.png", {
    db,
    verifyDelivery: rejectInspector,
  });
  assert.equal(result.success, true);
  assert.equal(result.session.status, "REJECTED");
  assert.equal(result.session.reason, "VISUAL_MISMATCH");

  const row = db
    .prepare("SELECT status, delivery_payload, delivery_reject_reason FROM sessions WHERE id = ?")
    .get(sessionId);
  assert.equal(row.status, "REJECTED");
  assert.equal(row.delivery_payload, "https://example.com/wrong.png");
  assert.equal(row.delivery_reject_reason, "VISUAL_MISMATCH");
});

test("inspector outage leaves escrow locked and reports unavailable", async () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  const sessionId = seedLockedSession(db);

  const failingInspector = async () => {
    throw Object.assign(new Error("socket hang up"), { code: "INSPECTOR_UNAVAILABLE" });
  };
  const result = await deliverWork(sessionId, "seller-1", "https://example.com/creative.png", {
    db,
    verifyDelivery: failingInspector,
  });
  assert.equal(result.success, false);
  assert.equal(result.error.code, "INSPECTOR_UNAVAILABLE");

  const row = db
    .prepare("SELECT status, escrow_locked FROM sessions WHERE id = ?")
    .get(sessionId);
  assert.equal(row.status, "ESCROW_LOCKED");
  assert.equal(row.escrow_locked, 200);
  assert.equal(db.prepare("SELECT balance FROM wallets WHERE agent_id = ?").get("buyer-1").balance, 800);
});

test("buyer cannot deliver work (seller only)", async () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  const sessionId = seedLockedSession(db);

  const result = await deliverWork(sessionId, "buyer-1", "https://example.com/creative.png", { db });
  assert.equal(result.success, false);
  assert.equal(result.error.code, "SELLER_ONLY");
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id = ?").get(sessionId).status, "ESCROW_LOCKED");
});

test("cannot deliver on a session that is still NEGOTIATING", async () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  const created = createSession("buyer-1", "seller-1", { title: "hero image", budget: 500 }, { db });
  assert.equal(created.success, true);

  const result = await deliverWork(created.session.sessionId, "seller-1", "https://example.com/creative.png", {
    db,
  });
  assert.equal(result.success, false);
  assert.equal(result.error.code, "INVALID_STATE");
});

test("POST /api/sessions/:id/deliver inspects and enforces Idempotency-Key", async () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  const goodId = seedLockedSession(db);
  const badId = seedLockedSession(db);

  await withServer(db, async (base) => {
    const missing = await postJson(`${base}/api/sessions/${goodId}/deliver`, {
      agentId: "seller-1",
      payload: "img_data_valid",
    });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error.code, "MISSING_IDEMPOTENCY_KEY");

    const settled = await postJson(
      `${base}/api/sessions/${goodId}/deliver`,
      { agentId: "seller-1", payload: "img_data_valid" },
      "deliver-key-1"
    );
    assert.equal(settled.status, 200);
    assert.deepEqual(await settled.json(), {
      sessionId: goodId,
      status: "SETTLED",
      agreedPrice: 200,
    });

    const replay = await postJson(
      `${base}/api/sessions/${goodId}/deliver`,
      { agentId: "seller-1", payload: "img_data_valid" },
      "deliver-key-1"
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), {
      sessionId: goodId,
      status: "SETTLED",
      agreedPrice: 200,
    });

    const rejected = await postJson(
      `${base}/api/sessions/${badId}/deliver`,
      { agentId: "seller-1", payload: "corrupted_data" },
      "deliver-key-2"
    );
    assert.equal(rejected.status, 200);
    const rejectedJson = await rejected.json();
    assert.equal(rejectedJson.status, "REJECTED");
    assert.equal(rejectedJson.reason, "VISUAL_MISMATCH");

    const buyerAttempt = await postJson(
      `${base}/api/sessions/${badId}/deliver`,
      { agentId: "buyer-1", payload: "img_data_valid" },
      "deliver-key-3"
    );
    assert.equal(buyerAttempt.status, 403);
    assert.equal((await buyerAttempt.json()).error.code, "SELLER_ONLY");
  }, { verifyDelivery: tokenInspector });
});

test("POST /api/sessions strictly requires Idempotency-Key and dedupes retries", async () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });

  await withServer(db, async (base) => {
    const body = { buyerId: "buyer-1", sellerId: "seller-1", brief: { title: "hero image", budget: 500 } };

    const missing = await postJson(`${base}/api/sessions`, body);
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error.code, "MISSING_IDEMPOTENCY_KEY");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);

    const first = await postJson(`${base}/api/sessions`, body, "sess-strict-1");
    assert.equal(first.status, 201);
    const firstJson = await first.json();
    assert.match(firstJson.sessionId, /^[0-9a-f-]{36}$/);

    const retry = await postJson(`${base}/api/sessions`, body, "sess-strict-1");
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), firstJson);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 1);
  });
});

test("text_gen delivery settles end to end without vision credentials", async () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100, capability: "text_gen" });
  const created = createSession(
    "buyer-1",
    "seller-1",
    { title: "taglines", budget: 500, quantity: 5 },
    { db }
  );
  assert.equal(created.success, true);
  const accept = submitMove(created.session.sessionId, "seller-1", { action: "ACCEPT", price: 200 }, { db });
  assert.equal(accept.success, true);

  const savedKey = process.env.MODEL_API_KEY;
  const savedBase = process.env.META_BASE_URL;
  delete process.env.MODEL_API_KEY;
  delete process.env.META_BASE_URL;
  try {
    // No verifyDelivery stub: the real inspector must bypass vision for text.
    const result = await deliverWork(created.session.sessionId, "seller-1", "Buy now! Sale ends soon.", { db });
    assert.equal(result.success, true);
    assert.equal(result.session.status, "SETTLED");
  } finally {
    if (savedKey !== undefined) process.env.MODEL_API_KEY = savedKey;
    if (savedBase !== undefined) process.env.META_BASE_URL = savedBase;
  }

  assert.equal(db.prepare("SELECT balance FROM wallets WHERE agent_id = ?").get("buyer-1").balance, 800);
  assert.equal(db.prepare("SELECT balance FROM wallets WHERE agent_id = ?").get("seller-1").balance, 1200);
});

test("rejected delivery slashes 50 stake and pays the buyer a bonus on top of the refund", async () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  const sessionId = seedLockedSession(db);

  const result = await deliverWork(sessionId, "seller-1", "https://example.com/wrong.png", {
    db,
    verifyDelivery: rejectInspector,
  });
  assert.equal(result.success, true);
  assert.equal(result.session.status, "REJECTED");

  const seller = db.prepare("SELECT stake_balance, status FROM agents WHERE agent_id = ?").get("seller-1");
  assert.equal(seller.stake_balance, 50);
  assert.equal(seller.status, "ACTIVE");
  assert.equal(db.prepare("SELECT balance FROM wallets WHERE agent_id = ?").get("buyer-1").balance, 1050);
  assert.equal(db.prepare("SELECT escrow_locked FROM sessions WHERE id = ?").get(sessionId).escrow_locked, 0);
});

test("slashing below 20 stake suspends the seller", async () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  db.prepare("UPDATE agents SET stake_balance = ? WHERE agent_id = ?").run(60, "seller-1");
  const sessionId = seedLockedSession(db);

  const result = await deliverWork(sessionId, "seller-1", "https://example.com/wrong.png", {
    db,
    verifyDelivery: rejectInspector,
  });
  assert.equal(result.success, true);
  assert.equal(result.session.status, "REJECTED");

  const seller = db.prepare("SELECT stake_balance, status FROM agents WHERE agent_id = ?").get("seller-1");
  assert.equal(seller.stake_balance, 10);
  assert.equal(seller.status, "SUSPENDED");
  assert.equal(db.prepare("SELECT balance FROM wallets WHERE agent_id = ?").get("buyer-1").balance, 1050);
});

test("settled delivery leaves stake untouched and pays no bonus", async () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  const sessionId = seedLockedSession(db);

  const result = await deliverWork(sessionId, "seller-1", "https://example.com/creative.png", {
    db,
    verifyDelivery: settleInspector,
  });
  assert.equal(result.success, true);
  assert.equal(result.session.status, "SETTLED");

  assert.equal(
    db.prepare("SELECT stake_balance FROM agents WHERE agent_id = ?").get("seller-1").stake_balance,
    100
  );
  assert.equal(db.prepare("SELECT balance FROM wallets WHERE agent_id = ?").get("buyer-1").balance, 800);
  assert.equal(db.prepare("SELECT balance FROM wallets WHERE agent_id = ?").get("seller-1").balance, 1200);
});
