import assert from "node:assert/strict";
import test from "node:test";

// Loopback fetch must never go through a proxy (sandboxed/proxied CI).
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");
process.env.no_proxy = [process.env.no_proxy, "127.0.0.1,localhost"].filter(Boolean).join(",");
import { registerAgent } from "../src/agent-store.js";
import { createDb } from "../src/db.js";
import { createSession, expireStaleSessions, getSession, submitMove } from "../src/session-manager.js";
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

test("10,000 CR offer on a 100 CR budget is rejected (Gap Test regression)", () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 50 });

  const created = createSession(
    "buyer-1",
    "seller-1",
    { title: "cyberpunk ad", budget: 100 },
    { db }
  );
  assert.equal(created.success, true);

  const buyerOffer = submitMove(
    created.session.sessionId,
    "buyer-1",
    { action: "OFFER", price: 10000 },
    { db }
  );
  assert.equal(buyerOffer.success, false);
  assert.equal(buyerOffer.error.code, "BUDGET_EXCEEDED");

  const sellerOffer = submitMove(
    created.session.sessionId,
    "seller-1",
    { action: "OFFER", price: 10000 },
    { db }
  );
  assert.equal(sellerOffer.success, false);
  assert.equal(sellerOffer.error.code, "BUDGET_EXCEEDED");

  const row = db
    .prepare("SELECT status, agreed_price FROM sessions WHERE id = ?")
    .get(created.session.sessionId);
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
  seedSeller(db, { agentId: "seller-3", floorPrice: 300, capability: "video_gen" });
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
          stakeBalance: 100,
        },
      ],
    });
    assert.ok(json.agents[0].hexSeal);
    assert.equal("webhookUrl" in json.agents[0], false);
    assert.equal("publicKey" in json.agents[0], false);

    const video = await fetch(`${base}/api/agents?capability=video_gen`);
    assert.equal(video.status, 200);
    const videoJson = await video.json();
    assert.equal(videoJson.agents.length, 1);
    assert.equal(videoJson.agents[0].agentId, "seller-3");
    assert.equal(videoJson.agents[0].capability, "video_gen");

    const bad = await fetch(`${base}/api/agents?capability=audio_gen`);
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, "INVALID_CAPABILITY");
  });
});

test("buyer can request a batch quantity and it is stored", () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });

  const created = createSession("buyer-1", "seller-1", { title: "hero images", budget: 500, quantity: 5 }, { db });
  assert.equal(created.success, true);
  assert.equal(created.session.quantity, 5);
  assert.equal(
    db.prepare("SELECT quantity FROM sessions WHERE id = ?").get(created.session.sessionId).quantity,
    5
  );
  assert.equal(getSession(created.session.sessionId, { db }).quantity, 5);
});

test("quantity defaults to 1 and accepts an options override", () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });

  const fromString = createSession("buyer-1", "seller-1", "a logo", { db, budget: 100 });
  assert.equal(fromString.success, true);
  assert.equal(fromString.session.quantity, 1);

  const fromObject = createSession("buyer-1", "seller-1", { title: "a logo", budget: 100 }, { db });
  assert.equal(fromObject.session.quantity, 1);

  const overridden = createSession(
    "buyer-1",
    "seller-1",
    { title: "banners", budget: 100, quantity: 5 },
    { db, quantity: 10 }
  );
  assert.equal(overridden.success, true);
  assert.equal(overridden.session.quantity, 10);
});

test("non-positive-integer quantities are rejected", () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });

  for (const quantity of [0, -2, 1.5, "5", null]) {
    const created = createSession(
      "buyer-1",
      "seller-1",
      { title: "batch", budget: 500, quantity },
      { db }
    );
    assert.equal(created.success, false, `expected quantity ${JSON.stringify(quantity)} to fail`);
    assert.equal(created.error.code, "INVALID_QUANTITY");
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
});

test("POST /api/sessions accepts a batch quantity", async () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  await withServer(db, async (base) => {
    const res = await postJson(
      `${base}/api/sessions`,
      {
        buyerId: "buyer-1",
        sellerId: "seller-1",
        brief: { title: "hero images", budget: 500, quantity: 5 },
      },
      "qty-key-1"
    );
    assert.equal(res.status, 201);
    const { sessionId } = await res.json();
    assert.equal(db.prepare("SELECT quantity FROM sessions WHERE id = ?").get(sessionId).quantity, 5);

    const bad = await postJson(
      `${base}/api/sessions`,
      {
        buyerId: "buyer-1",
        sellerId: "seller-1",
        brief: { title: "hero images", budget: 500, quantity: 0 },
      },
      "qty-key-2"
    );
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, "INVALID_QUANTITY");
  });
});

test("buyer OFFER below seller floor gets FLOOR_EXCEEDED", () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 500 });

  const created = createSession("buyer-1", "seller-1", { title: "hero image", budget: 1000 }, { db });
  assert.equal(created.success, true);

  const move = submitMove(created.session.sessionId, "buyer-1", { action: "OFFER", price: 100 }, { db });
  assert.equal(move.success, false);
  assert.equal(move.error.code, "FLOOR_EXCEEDED");

  const row = db.prepare("SELECT status, agreed_price FROM sessions WHERE id = ?").get(created.session.sessionId);
  assert.equal(row.status, "NEGOTIATING");
  assert.equal(row.agreed_price, null);
});

test("buyer OFFER below floor returns 422 over HTTP", async () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 500 });
  await withServer(db, async (base) => {
    const created = await postJson(
      `${base}/api/sessions`,
      { buyerId: "buyer-1", sellerId: "seller-1", brief: { title: "hero image", budget: 1000 } },
      "floor-key-1"
    );
    assert.equal(created.status, 201);
    const { sessionId } = await created.json();

    const low = await postJson(
      `${base}/api/sessions/${sessionId}/negotiate`,
      { agentId: "buyer-1", move: { action: "OFFER", price: 100 } },
      "floor-key-2"
    );
    assert.equal(low.status, 422);
    assert.equal((await low.json()).error.code, "FLOOR_EXCEEDED");
  });
});

test("GET /api/sessions/:id/state returns the session projection", async () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  await withServer(db, async (base) => {
    const created = await postJson(
      `${base}/api/sessions`,
      { buyerId: "buyer-1", sellerId: "seller-1", brief: { title: "hero image", budget: 500 } },
      "state-key-1"
    );
    assert.equal(created.status, 201);
    const { sessionId } = await created.json();

    const res = await fetch(`${base}/api/sessions/${sessionId}/state`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.sessionId, sessionId);
    assert.equal(json.buyerId, "buyer-1");
    assert.equal(json.sellerId, "seller-1");
    assert.equal(json.status, "NEGOTIATING");
    assert.equal(json.agreedPrice, null);
    assert.equal(json.buyerBudget, 500);
    assert.equal(json.quantity, 1);
    assert.match(json.brief, /hero image/);
    assert.equal("deliveryPayload" in json, false);
  });
});

test("GET /api/sessions/:id/state returns 404 for unknown sessions", async () => {
  const db = createDb();
  await withServer(db, async (base) => {
    const res = await fetch(`${base}/api/sessions/does-not-exist/state`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "SESSION_NOT_FOUND");
  });
});

test("expired ESCROW_LOCKED session refunds the buyer on the next POST", async () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  const created = createSession("buyer-1", "seller-1", { title: "hero image", budget: 500 }, { db });
  const accept = submitMove(created.session.sessionId, "seller-1", { action: "ACCEPT", price: 200 }, { db });
  assert.equal(accept.success, true);
  assert.equal(db.prepare("SELECT balance FROM wallets WHERE agent_id = ?").get("buyer-1").balance, 800);

  db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, created.session.sessionId);

  await withServer(db, async (base) => {
    const move = await postJson(
      `${base}/api/sessions/${created.session.sessionId}/negotiate`,
      { agentId: "buyer-1", move: { action: "OFFER", price: 250 } },
      "expiry-key-1"
    );
    assert.equal(move.status, 409);
    assert.equal((await move.json()).error.code, "INVALID_STATE");
  });

  const row = db.prepare("SELECT status, escrow_locked FROM sessions WHERE id = ?").get(created.session.sessionId);
  assert.equal(row.status, "EXPIRED");
  assert.equal(row.escrow_locked, 0);
  assert.equal(db.prepare("SELECT balance FROM wallets WHERE agent_id = ?").get("buyer-1").balance, 1000);
});

test("expired NEGOTIATING session flips to EXPIRED without moving funds", async () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  const created = createSession("buyer-1", "seller-1", { title: "hero image", budget: 500 }, { db });
  db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, created.session.sessionId);

  await withServer(db, async (base) => {
    const move = await postJson(
      `${base}/api/sessions/${created.session.sessionId}/negotiate`,
      { agentId: "buyer-1", move: { action: "OFFER", price: 250 } },
      "expiry-key-2"
    );
    assert.equal(move.status, 409);
    assert.equal((await move.json()).error.code, "INVALID_STATE");
  });

  assert.equal(
    db.prepare("SELECT status FROM sessions WHERE id = ?").get(created.session.sessionId).status,
    "EXPIRED"
  );
  assert.equal(db.prepare("SELECT * FROM wallets WHERE agent_id = ?").get("buyer-1"), undefined);
});

test("GET /api/agents sorts by highest stake first", async () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  seedSeller(db, { agentId: "seller-2", floorPrice: 250 });
  db.prepare("UPDATE agents SET stake_balance = ? WHERE agent_id = ?").run(40, "seller-1");

  await withServer(db, async (base) => {
    const res = await fetch(`${base}/api/agents?capability=image_gen`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.deepEqual(
      json.agents.map((a) => [a.agentId, a.stakeBalance]),
      [["seller-2", 100], ["seller-1", 40]]
    );
  });
});

test("createSession sets expires_at about ten minutes out", () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  const before = Date.now();
  const created = createSession("buyer-1", "seller-1", { title: "hero", budget: 500 }, { db });
  const expiresAt = db
    .prepare("SELECT expires_at FROM sessions WHERE id = ?")
    .get(created.session.sessionId).expires_at;
  assert.ok(expiresAt >= before + 600000);
  assert.ok(expiresAt <= Date.now() + 600000);
});

test("expireStaleSessions returns the expired count and skips fresh sessions", () => {
  const db = createDb();
  seedSeller(db, { agentId: "seller-1", floorPrice: 100 });
  const stale = createSession("buyer-1", "seller-1", { title: "old", budget: 500 }, { db });
  const fresh = createSession("buyer-1", "seller-1", { title: "new", budget: 500 }, { db });
  db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(
    Date.now() - 1000,
    stale.session.sessionId
  );

  assert.equal(expireStaleSessions(db), 1);
  assert.equal(
    db.prepare("SELECT status FROM sessions WHERE id = ?").get(stale.session.sessionId).status,
    "EXPIRED"
  );
  assert.equal(
    db.prepare("SELECT status FROM sessions WHERE id = ?").get(fresh.session.sessionId).status,
    "NEGOTIATING"
  );
  assert.equal(expireStaleSessions(db), 0);
});
