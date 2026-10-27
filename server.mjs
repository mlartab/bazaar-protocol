import crypto from "node:crypto";
import http from "node:http";
import { CAPABILITIES, registerAgent } from "./src/agent-store.js";
import { getDb } from "./src/db.js";
import { createSession, deliverWork, submitMove } from "./src/session-manager.js";

const PORT = Number(process.env.PORT ?? 3000);
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

export function hashRequest(body) {
  return crypto.createHash("sha256").update(stableStringify(body), "utf8").digest("hex");
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("body too large"), { code: "BODY_TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sessionErrorStatus(code) {
  if (code === "SESSION_NOT_FOUND" || code === "SELLER_NOT_FOUND") return 404;
  if (code === "NOT_PARTICIPANT" || code === "SELLER_ONLY") return 403;
  if (code === "INVALID_STATE") return 409;
  if (code === "BUDGET_EXCEEDED" || code === "FLOOR_EXCEEDED") return 422;
  if (code === "INTERNAL_ERROR") return 500;
  return 400;
}

export function createApp(db = getDb()) {
  const findKey = db.prepare("SELECT agent_id, request_hash, response_json FROM idempotency_keys WHERE key = ?");
  const storeKey = db.prepare(
    "INSERT INTO idempotency_keys (key, agent_id, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)"
  );

  function requireIdempotencyKey(req, res) {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.trim() === "") {
      sendJson(res, 400, {
        error: { code: "MISSING_IDEMPOTENCY_KEY", message: "Idempotency-Key header is required." },
      });
      return null;
    }
    return key;
  }

  function checkIdempotency(key, requestHash, res) {
    const cached = findKey.get(key);
    if (!cached) return null;
    if (cached.request_hash !== requestHash) {
      sendJson(res, 409, {
        error: {
          code: "IDEMPOTENCY_KEY_MISMATCH",
          message: "Idempotency-Key was already used with a different payload.",
        },
      });
      return "mismatch";
    }
    sendJson(res, 200, JSON.parse(cached.response_json));
    return "replayed";
  }

  async function parseJsonBody(req, res) {
    let raw;
    try {
      raw = await readBody(req);
    } catch {
      sendJson(res, 413, {
        error: { code: "BODY_TOO_LARGE", message: "Request body exceeds 1 MiB." },
      });
      return null;
    }
    let body;
    try {
      body = raw.trim() === "" ? {} : JSON.parse(raw);
    } catch {
      sendJson(res, 400, {
        error: { code: "INVALID_JSON", message: "Request body must be valid JSON." },
      });
      return null;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      sendJson(res, 400, {
        error: { code: "INVALID_JSON", message: "Request body must be a JSON object." },
      });
      return null;
    }
    return body;
  }

  async function handleRegister(req, res) {
    const idempotencyKey = requireIdempotencyKey(req, res);
    if (!idempotencyKey) return;

    const body = await parseJsonBody(req, res);
    if (!body) return;

    const requestHash = hashRequest(body);
    if (checkIdempotency(idempotencyKey, requestHash, res)) return;

    const result = registerAgent(body, { db });
    if (!result.success) {
      const status = result.error.code === "DUPLICATE_AGENT_ID" ? 409 : 400;
      sendJson(res, status, { error: result.error });
      return;
    }

    const payload = { agent: result.agent, hexSeal: result.agent.hexSeal };
    storeKey.run(
      idempotencyKey,
      result.agent.agentId,
      requestHash,
      JSON.stringify(payload),
      new Date().toISOString()
    );
    sendJson(res, 201, payload);
  }

  function handleListAgents(_req, res, searchParams) {
    const capability = searchParams.get("capability");
    if (capability !== null && !CAPABILITIES.includes(capability)) {
      sendJson(res, 400, {
        error: {
          code: "INVALID_CAPABILITY",
          message: `Capability must be one of: ${CAPABILITIES.join(", ")}.`,
        },
      });
      return;
    }
    const rows = capability
      ? db
          .prepare(
            "SELECT agent_id, capability, floor_price, hex_seal FROM agents WHERE status = 'ACTIVE' AND capability = ? ORDER BY agent_id"
          )
          .all(capability)
      : db
          .prepare(
            "SELECT agent_id, capability, floor_price, hex_seal FROM agents WHERE status = 'ACTIVE' ORDER BY agent_id"
          )
          .all();
    sendJson(res, 200, {
      agents: rows.map((row) => ({
        agentId: row.agent_id,
        capability: row.capability,
        floorPrice: row.floor_price,
        hexSeal: row.hex_seal,
      })),
    });
  }

  async function handleCreateSession(req, res) {
    const idempotencyKey = requireIdempotencyKey(req, res);
    if (!idempotencyKey) return;

    const body = await parseJsonBody(req, res);
    if (!body) return;

    const { buyerId, sellerId, brief, budget } = body;
    const requestHash = hashRequest(body);
    if (checkIdempotency(idempotencyKey, requestHash, res)) return;

    const result = createSession(buyerId, sellerId, brief, { db, budget });
    if (!result.success) {
      sendJson(res, sessionErrorStatus(result.error.code), { error: result.error });
      return;
    }

    const payload = { sessionId: result.session.sessionId, status: result.session.status };
    storeKey.run(
      idempotencyKey,
      buyerId,
      requestHash,
      JSON.stringify(payload),
      new Date().toISOString()
    );
    sendJson(res, 201, payload);
  }

  async function handleNegotiate(req, res, sessionId) {
    const idempotencyKey = requireIdempotencyKey(req, res);
    if (!idempotencyKey) return;

    const body = await parseJsonBody(req, res);
    if (!body) return;

    const { agentId, move } = body;
    const requestHash = hashRequest({ sessionId, agentId, move });
    if (checkIdempotency(idempotencyKey, requestHash, res)) return;

    const result = submitMove(sessionId, agentId, move, { db });
    if (!result.success) {
      sendJson(res, sessionErrorStatus(result.error.code), { error: result.error });
      return;
    }

    const payload = {
      sessionId: result.session.sessionId,
      status: result.session.status,
      agreedPrice: result.session.agreedPrice,
    };
    storeKey.run(
      idempotencyKey,
      agentId,
      requestHash,
      JSON.stringify(payload),
      new Date().toISOString()
    );
    sendJson(res, 200, payload);
  }

  async function handleDeliver(req, res, sessionId) {
    const idempotencyKey = requireIdempotencyKey(req, res);
    if (!idempotencyKey) return;

    const body = await parseJsonBody(req, res);
    if (!body) return;

    const { agentId, payload } = body;
    const requestHash = hashRequest({ sessionId, agentId, payload });
    if (checkIdempotency(idempotencyKey, requestHash, res)) return;

    const result = deliverWork(sessionId, agentId, payload, { db });
    if (!result.success) {
      sendJson(res, sessionErrorStatus(result.error.code), { error: result.error });
      return;
    }

    const response = {
      sessionId: result.session.sessionId,
      status: result.session.status,
      agreedPrice: result.session.agreedPrice,
      ...(result.session.reason ? { reason: result.session.reason } : {}),
    };
    storeKey.run(
      idempotencyKey,
      agentId,
      requestHash,
      JSON.stringify(response),
      new Date().toISOString()
    );
    sendJson(res, 200, response);
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;

      if (req.method === "GET" && path === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && path === "/api/agents") {
        handleListAgents(req, res, url.searchParams);
        return;
      }
      if (req.method === "POST" && path === "/api/agents/register") {
        await handleRegister(req, res);
        return;
      }
      if (req.method === "POST" && path === "/api/sessions") {
        await handleCreateSession(req, res);
        return;
      }
      const negotiateMatch = path.match(/^\/api\/sessions\/([^/]+)\/negotiate$/);
      if (req.method === "POST" && negotiateMatch) {
        await handleNegotiate(req, res, decodeURIComponent(negotiateMatch[1]));
        return;
      }
      const deliverMatch = path.match(/^\/api\/sessions\/([^/]+)\/deliver$/);
      if (req.method === "POST" && deliverMatch) {
        await handleDeliver(req, res, decodeURIComponent(deliverMatch[1]));
        return;
      }

      sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Not found." } });
    } catch (err) {
      console.error(err);
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: { code: "INTERNAL_ERROR", message: "Internal server error." },
        });
      }
    }
  });
}

const isMain = process.argv[1]?.endsWith("server.mjs") ?? false;
if (isMain) {
  const server = createApp();
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Bazaar Registry listening on http://127.0.0.1:${PORT}`);
  });
}
