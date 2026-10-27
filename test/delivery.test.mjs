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

async function withServer(db, fn) {
  const server = createApp(db);
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

test("seller delivering valid data transitions the session to SETTLED", () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  const sessionId = seedLockedSession(db);

  const result = deliverWork(sessionId, "seller-1", "img_data_valid", { db });
  assert.equal(result.success, true);
  assert.equal(result.session.status, "SETTLED");
  assert.equal(result.session.agreedPrice, 200);

  const row = db
    .prepare("SELECT status, delivery_payload, delivery_reject_reason FROM sessions WHERE id = ?")
    .get(sessionId);
  assert.equal(row.status, "SETTLED");
  assert.equal(row.delivery_payload, "img_data_valid");
  assert.equal(row.delivery_reject_reason, null);
});

test("seller delivering invalid data transitions the session to REJECTED", () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  const sessionId = seedLockedSession(db);

  const result = deliverWork(sessionId, "seller-1", "corrupted_data", { db });
  assert.equal(result.success, true);
  assert.equal(result.session.status, "REJECTED");
  assert.equal(result.session.reason, "INVALID_IMAGE_FORMAT");

  const row = db
    .prepare("SELECT status, delivery_payload, delivery_reject_reason FROM sessions WHERE id = ?")
    .get(sessionId);
  assert.equal(row.status, "REJECTED");
  assert.equal(row.delivery_payload, "corrupted_data");
  assert.equal(row.delivery_reject_reason, "INVALID_IMAGE_FORMAT");
});

test("buyer cannot deliver work (seller only)", () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  const sessionId = seedLockedSession(db);

  const result = deliverWork(sessionId, "buyer-1", "img_data_valid", { db });
  assert.equal(result.success, false);
  assert.equal(result.error.code, "SELLER_ONLY");
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id = ?").get(sessionId).status, "ESCROW_LOCKED");
});

test("cannot deliver on a session that is still NEGOTIATING", () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  const created = createSession("buyer-1", "seller-1", { title: "hero image", budget: 500 }, { db });
  assert.equal(created.success, true);

  const result = deliverWork(created.session.sessionId, "seller-1", "img_data_valid", { db });
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
    assert.equal(rejectedJson.reason, "INVALID_IMAGE_FORMAT");

    const buyerAttempt = await postJson(
      `${base}/api/sessions/${badId}/deliver`,
      { agentId: "buyer-1", payload: "img_data_valid" },
      "deliver-key-3"
    );
    assert.equal(buyerAttempt.status, 403);
    assert.equal((await buyerAttempt.json()).error.code, "SELLER_ONLY");
  });
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
