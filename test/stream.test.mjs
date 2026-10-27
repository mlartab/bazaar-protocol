import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

// Loopback fetch must never go through a proxy (sandboxed/proxied CI).
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");
process.env.no_proxy = [process.env.no_proxy, "127.0.0.1,localhost"].filter(Boolean).join(",");
import { registerAgent } from "../src/agent-store.js";
import { createDb } from "../src/db.js";
import { createApp } from "../server.mjs";

async function withServer(db, fn) {
  const server = createApp(db);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(server, `http://127.0.0.1:${port}`);
  } finally {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
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

// Connect a fake SSE client by emitting a synthetic request directly on the
// server. This bypasses TCP streaming (unavailable in proxy-only sandboxes)
// while still exercising the real router, handleStream, and broadcast path.
function connectFakeStream(server) {
  const req = new EventEmitter();
  req.method = "GET";
  req.url = "/api/stream";
  req.headers = {};
  const client = { status: null, headers: null, chunks: [] };
  const res = {
    writeHead(status, headers) {
      client.status = status;
      client.headers = headers;
    },
    write(chunk) {
      client.chunks.push(chunk.toString());
      return true;
    },
  };
  server.emit("request", req, res);
  return { req, client };
}

const ssePayloads = (client) =>
  client.chunks
    .join("")
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => JSON.parse(frame.slice("data: ".length)));

test("GET /api/stream registers an SSE client and receives session_update frames", async () => {
  const db = createDb();
  const seller = registerAgent(
    {
      agentId: "seller-sse",
      publicKey: "pk-sse-1",
      capability: "image_gen",
      floorPrice: 100,
      webhookUrl: "https://example.com/hook",
    },
    { db }
  );
  assert.equal(seller.success, true);

  await withServer(db, async (server, base) => {
    const { req, client } = connectFakeStream(server);
    assert.equal(client.status, 200);
    assert.match(client.headers["Content-Type"] ?? "", /text\/event-stream/);
    assert.match(client.headers["Cache-Control"] ?? "", /no-cache/);
    assert.match(client.headers["Connection"] ?? "", /keep-alive/i);

    const created = await postJson(
      `${base}/api/sessions`,
      { buyerId: "buyer-sse", sellerId: "seller-sse", brief: { title: "sse pic", budget: 500 } },
      "sse-create-1"
    );
    assert.equal(created.status, 201);
    const createdJson = await created.json();
    assert.deepEqual(Object.keys(createdJson).sort(), ["sessionId", "status"]);
    const { sessionId } = createdJson;

    let frames = ssePayloads(client);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].sessionId, sessionId);
    assert.equal(frames[0].status, "NEGOTIATING");

    const negotiated = await postJson(
      `${base}/api/sessions/${sessionId}/negotiate`,
      { agentId: "buyer-sse", move: { action: "OFFER", price: 200 } },
      "sse-move-1"
    );
    assert.equal(negotiated.status, 200);
    const negotiatedJson = await negotiated.json();
    assert.equal(negotiatedJson.sessionId, sessionId);

    frames = ssePayloads(client);
    assert.equal(frames.length, 2);
    assert.equal(frames[1].sessionId, sessionId);

    // Idempotency replay returns cached JSON and must not re-emit.
    const replay = await postJson(
      `${base}/api/sessions/${sessionId}/negotiate`,
      { agentId: "buyer-sse", move: { action: "OFFER", price: 200 } },
      "sse-move-1"
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), negotiatedJson);
    assert.equal(ssePayloads(client).length, 2);

    // Closing the stream unregisters the client: further emits go nowhere.
    req.emit("close");
    const created2 = await postJson(
      `${base}/api/sessions`,
      { buyerId: "buyer-sse", sellerId: "seller-sse", brief: { title: "sse pic 2", budget: 500 } },
      "sse-create-2"
    );
    assert.equal(created2.status, 201);
    assert.equal(ssePayloads(client).length, 2);
  });
});
