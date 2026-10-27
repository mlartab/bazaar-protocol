import assert from "node:assert/strict";
import test from "node:test";

// Loopback fetch must never go through a proxy (sandboxed/proxied CI).
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");
process.env.no_proxy = [process.env.no_proxy, "127.0.0.1,localhost"].filter(Boolean).join(",");
import { registerAgent } from "../src/agent-store.js";
import { createDb } from "../src/db.js";
import { createSession, submitMove } from "../src/session-manager.js";
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

test("buyer can create a session and make a valid OFFER", () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });

  const created = createSession("buyer-1", "seller-1", { title: "hero image", budget: 500 }, { db });
  assert.equal(created.success, true);
  assert.match(created.session.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(created.session.status, "NEGOTIATING");

  const row = db.prepare("SELECT status FROM sessions WHERE id = ?").get(created.session.sessionId);
  assert.equal(row.status, "NEGOTIATING");

  const move = submitMove(created.session.sessionId, "buyer-1", { action: "OFFER", price: 200 }, { db });
  assert.equal(move.success, true);
  assert.equal(move.session.status, "NEGOTIATING");
});

test("buyer OFFER over budget gets BUDGET_EXCEEDED", () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });

  const created = createSession("buyer-1", "seller-1", { title: "hero image", budget: 300 }, { db });
  assert.equal(created.success, true);

  const move = submitMove(created.session.sessionId, "buyer-1", { action: "OFFER", price: 400 }, { db });
  assert.equal(move.success, false);
  assert.equal(move.error.code, "BUDGET_EXCEEDED");

  const row = db.prepare("SELECT status, agreed_price FROM sessions WHERE id = ?").get(created.session.sessionId);
  assert.equal(row.status, "NEGOTIATING");
  assert.equal(row.agreed_price, null);
});

test("seller OFFER below floor gets FLOOR_EXCEEDED", () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 500 });

  const created = createSession("buyer-1", "seller-1", { title: "hero image", budget: 1000 }, { db });
  assert.equal(created.success, true);

  const move = submitMove(created.session.sessionId, "seller-1", { action: "OFFER", price: 100 }, { db });
  assert.equal(move.success, false);
  assert.equal(move.error.code, "FLOOR_EXCEEDED");
});

test("ACCEPT transitions the state to ESCROW_LOCKED", () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });

  const created = createSession("buyer-1", "seller-1", { title: "hero image", budget: 500 }, { db });
  assert.equal(created.success, true);

  const offer = submitMove(created.session.sessionId, "buyer-1", { action: "OFFER", price: 200 }, { db });
  assert.equal(offer.success, true);

  const accept = submitMove(created.session.sessionId, "seller-1", { action: "ACCEPT", price: 200 }, { db });
  assert.equal(accept.success, true);
  assert.equal(accept.session.status, "ESCROW_LOCKED");
  assert.equal(accept.session.agreedPrice, 200);

  const row = db.prepare("SELECT status, agreed_price FROM sessions WHERE id = ?").get(created.session.sessionId);
  assert.equal(row.status, "ESCROW_LOCKED");
  assert.equal(row.agreed_price, 200);

  const late = submitMove(created.session.sessionId, "buyer-1", { action: "OFFER", price: 250 }, { db });
  assert.equal(late.success, false);
  assert.equal(late.error.code, "INVALID_STATE");
});

test("ACCEPT runs the same referee checks before locking", () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 200 });

  const over = createSession("buyer-1", "seller-1", { title: "a", budget: 300 }, { db });
  const buyerAccept = submitMove(over.session.sessionId, "buyer-1", { action: "ACCEPT", price: 999 }, { db });
  assert.equal(buyerAccept.success, false);
  assert.equal(buyerAccept.error.code, "BUDGET_EXCEEDED");

  const under = createSession("buyer-1", "seller-1", { title: "b", budget: 1000 }, { db });
  const sellerAccept = submitMove(under.session.sessionId, "seller-1", { action: "ACCEPT", price: 50 }, { db });
  assert.equal(sellerAccept.success, false);
  assert.equal(sellerAccept.error.code, "FLOOR_EXCEEDED");
});

test("WALK transitions the state to REJECTED", () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });

  const created = createSession("buyer-1", "seller-1", { title: "hero image", budget: 500 }, { db });
  const walk = submitMove(created.session.sessionId, "buyer-1", { action: "WALK" }, { db });
  assert.equal(walk.success, true);
  assert.equal(walk.session.status, "REJECTED");
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id = ?").get(created.session.sessionId).status, "REJECTED");
});

test("POST /api/sessions creates a session and negotiate enforces Idempotency-Key", async () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  await withServer(db, async (base) => {
    const created = await postJson(
      `${base}/api/sessions`,
      { buyerId: "buyer-1", sellerId: "seller-1", brief: { title: "hero image", budget: 500 } },
      "sess-key-1"
    );
    assert.equal(created.status, 201);
    const { sessionId } = await created.json();
    assert.match(sessionId, /^[0-9a-f-]{36}$/);

    const missing = await postJson(`${base}/api/sessions/${sessionId}/negotiate`, {
      agentId: "buyer-1",
      move: { action: "OFFER", price: 200 },
    });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error.code, "MISSING_IDEMPOTENCY_KEY");

    const first = await postJson(
      `${base}/api/sessions/${sessionId}/negotiate`,
      { agentId: "buyer-1", move: { action: "OFFER", price: 200 } },
      "move-key-1"
    );
    assert.equal(first.status, 200);
    const firstJson = await first.json();
    assert.equal(firstJson.status, "NEGOTIATING");

    const replay = await postJson(
      `${base}/api/sessions/${sessionId}/negotiate`,
      { agentId: "buyer-1", move: { action: "OFFER", price: 200 } },
      "move-key-1"
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), firstJson);

    const clash = await postJson(
      `${base}/api/sessions/${sessionId}/negotiate`,
      { agentId: "buyer-1", move: { action: "OFFER", price: 250 } },
      "move-key-1"
    );
    assert.equal(clash.status, 409);
    assert.equal((await clash.json()).error.code, "IDEMPOTENCY_KEY_MISMATCH");
  });
});

test("GET /api/agents lists ACTIVE agents with public fields and capability filter", async () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  seedSeller(db, { agentId: "seller-2", floorPrice: 250 });
  db.prepare("UPDATE agents SET status = 'SUSPENDED' WHERE agent_id = ?").run("seller-2");

  await withServer(db, async (base) => {
    const res = await fetch(`${base}/api/agents?capability=image_gen`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.deepEqual(json, {
      agents: [
        {
          agentId: "seller-1",
          capability: "image_gen",
          floorPrice: 100,
          hexSeal: json.agents[0].hexSeal,
        },
      ],
    });
    assert.ok(json.agents[0].hexSeal);
    assert.equal("webhookUrl" in json.agents[0], false);
    assert.equal("publicKey" in json.agents[0], false);

    const bad = await fetch(`${base}/api/agents?capability=video_gen`);
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, "INVALID_CAPABILITY");
  });
});
