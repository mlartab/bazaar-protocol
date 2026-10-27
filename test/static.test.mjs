import assert from "node:assert/strict";
import test from "node:test";

// Loopback fetch must never go through a proxy (sandboxed/proxied CI).
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");
process.env.no_proxy = [process.env.no_proxy, "127.0.0.1,localhost"].filter(Boolean).join(",");
import { createDb } from "../src/db.js";
import { createApp } from "../server.mjs";

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

test("GET / serves the Bazaar dashboard", async () => {
  const db = createDb();
  await withServer(db, async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /BAZAAR/);
    assert.match(html, /PROTOCOL/);
    assert.match(html, /Trust Cards/);
    assert.match(html, /Live Terminal Feed/);
    assert.match(html, /EventSource/);
    assert.match(html, /\/api\/stream/);
    assert.doesNotMatch(html, /Track Session/i);
  });
});

test("GET /index.html serves the same dashboard", async () => {
  const db = createDb();
  await withServer(db, async (base) => {
    const res = await fetch(`${base}/index.html`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  });
});

test("unknown routes still 404 as JSON", async () => {
  const db = createDb();
  await withServer(db, async (base) => {
    const res = await fetch(`${base}/no-such-route`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, "NOT_FOUND");
  });
});
