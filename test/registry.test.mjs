import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

// Loopback fetch must never go through a proxy (sandboxed/proxied CI).
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");
process.env.no_proxy = [process.env.no_proxy, "127.0.0.1,localhost"].filter(Boolean).join(",");
import { registerAgent } from "../src/agent-store.js";
import { createDb } from "../src/db.js";
import { createApp } from "../server.mjs";

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

const validAgent = (overrides = {}) => ({
  agentId: "agent-1",
  publicKey: "pk-test-123",
  capability: "image_gen",
  floorPrice: 100,
  webhookUrl: "https://example.com/hook",
  ...overrides,
});

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

const postRegister = (base, body, key) =>
  fetch(`${base}/api/agents/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  });

test("valid agent registers successfully and gets a Hex Seal", () => {
  const db = createDb();
  const result = registerAgent(validAgent(), { db });
  assert.equal(result.success, true);
  assert.equal(result.agent.hexSeal, sha256("agent-1pk-test-123"));
  assert.equal(result.agent.status, "ACTIVE");
  const row = db.prepare("SELECT agent_id, status, hex_seal FROM agents WHERE agent_id = ?").get("agent-1");
  assert.equal(row.status, "ACTIVE");
  assert.equal(row.hex_seal, result.agent.hexSeal);
});

test("agent with a negative floor price is rejected", () => {
  const db = createDb();
  const result = registerAgent(validAgent({ agentId: "neg-1", floorPrice: -5 }), { db });
  assert.deepEqual(result, {
    success: false,
    error: {
      code: "INVALID_FLOOR_PRICE",
      message: "Floor price must be an integer greater than 0.",
    },
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agents").get().n, 0);
});

test("agent trying to use a duplicate ID is rejected", () => {
  const db = createDb();
  assert.equal(registerAgent(validAgent({ agentId: "dup-1" }), { db }).success, true);
  const result = registerAgent(validAgent({ agentId: "dup-1" }), { db });
  assert.equal(result.success, false);
  assert.equal(result.error.code, "DUPLICATE_AGENT_ID");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agents").get().n, 1);
});

test("retry with the same Idempotency-Key returns the same result without duplicating", async () => {
  const db = createDb();
  await withServer(db, async (base) => {
    const body = validAgent({ agentId: "idem-1" });
    const first = await postRegister(base, body, "key-abc");
    assert.equal(first.status, 201);
    const firstJson = await first.json();
    assert.ok(firstJson.hexSeal);

    const second = await postRegister(base, body, "key-abc");
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), firstJson);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agents").get().n, 1);
  });
});

test("idempotency collision with a different payload is rejected with 409", async () => {
  const db = createDb();
  await withServer(db, async (base) => {
    const first = await postRegister(base, validAgent({ agentId: "col-1", floorPrice: 100 }), "key-collide");
    assert.equal(first.status, 201);

    const second = await postRegister(base, validAgent({ agentId: "col-1", floorPrice: 999 }), "key-collide");
    assert.equal(second.status, 409);
    const json = await second.json();
    assert.equal(json.error.code, "IDEMPOTENCY_KEY_MISMATCH");
    assert.equal(db.prepare("SELECT floor_price FROM agents WHERE agent_id = ?").get("col-1").floor_price, 100);
  });
});

test("SSRF webhook URLs are rejected", () => {
  const blocked = [
    "http://localhost/hook",
    "http://localhost:3000/hook",
    "http://127.0.0.1/hook",
    "http://127.0.0.1:8080/hook",
    "http://10.0.0.5/hook",
    "http://192.168.1.1/hook",
    "http://172.16.4.2/hook",
    "http://172.31.255.1/hook",
  ];
  for (const [i, webhookUrl] of blocked.entries()) {
    const db = createDb();
    const result = registerAgent(validAgent({ agentId: `ssrf-${i}`, webhookUrl }), { db });
    assert.equal(result.success, false, `expected ${webhookUrl} to be rejected`);
    assert.equal(result.error.code, "INVALID_WEBHOOK_URL");
  }
});

test("optional DID is stored and included in the Hex Seal", () => {
  const db = createDb();
  const did = "did:bazaar:agent-42";
  const result = registerAgent(validAgent({ agentId: "did-1", did }), { db });
  assert.equal(result.success, true);
  assert.equal(result.agent.hexSeal, sha256(`did-1pk-test-123${did}`));
  assert.equal(result.agent.did, did);
  assert.equal(db.prepare("SELECT did FROM agents WHERE agent_id = ?").get("did-1").did, did);
});
