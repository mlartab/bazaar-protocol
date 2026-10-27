import crypto from "node:crypto";
import { getDb } from "./db.js";
import { verifyDelivery } from "./inspector.js";

export const SESSION_STATUSES = [
  "NEGOTIATING",
  "ESCROW_LOCKED",
  "DELIVERED",
  "SETTLED",
  "REJECTED",
];

export const MOVE_ACTIONS = ["OFFER", "ACCEPT", "WALK"];

const fail = (code, message) => ({ success: false, error: { code, message } });

function resolveBudget(brief, optionsBudget) {
  if (optionsBudget !== undefined) return optionsBudget;
  if (brief !== null && typeof brief === "object" && !Array.isArray(brief)) {
    return brief.budget;
  }
  return undefined;
}

function serializeBrief(brief) {
  if (typeof brief === "string") return brief;
  return JSON.stringify(brief);
}

export function createSession(buyerId, sellerId, brief, options = {}) {
  const db = options.db ?? getDb();

  if (typeof buyerId !== "string" || buyerId.trim() === "") {
    return fail("INVALID_BUYER_ID", "Buyer ID must be a non-empty string.");
  }
  if (typeof sellerId !== "string" || sellerId.trim() === "") {
    return fail("INVALID_SELLER_ID", "Seller ID must be a non-empty string.");
  }
  const briefIsString = typeof brief === "string" && brief.trim() !== "";
  const briefIsObject = brief !== null && typeof brief === "object" && !Array.isArray(brief);
  if (!briefIsString && !briefIsObject) {
    return fail("INVALID_BRIEF", "Brief must be a non-empty string or object.");
  }

  const budget = resolveBudget(brief, options.budget);
  if (!Number.isInteger(budget) || budget <= 0) {
    return fail(
      "INVALID_BUDGET",
      "Budget must be an integer greater than 0 (brief.budget or options.budget)."
    );
  }

  const createdAt = new Date().toISOString();
  const briefText = serializeBrief(brief);

  for (let attempt = 0; attempt < 3; attempt++) {
    const sessionId = crypto.randomUUID();
    try {
      db.prepare(
        `INSERT INTO sessions
          (id, buyer_id, seller_id, status, agreed_price, brief, buyer_budget, created_at)
         VALUES (?, ?, ?, 'NEGOTIATING', NULL, ?, ?, ?)`
      ).run(sessionId, buyerId, sellerId, briefText, budget, createdAt);
      return {
        success: true,
        session: {
          sessionId,
          buyerId,
          sellerId,
          status: "NEGOTIATING",
          brief: briefText,
          buyerBudget: budget,
          agreedPrice: null,
        },
      };
    } catch (err) {
      if (
        attempt < 2 &&
        (err?.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || err?.code === "SQLITE_CONSTRAINT_UNIQUE")
      ) {
        continue;
      }
      throw err;
    }
  }
  return fail("INTERNAL_ERROR", "Could not generate a unique session ID.");
}

export function getSession(sessionId, options = {}) {
  const db = options.db ?? getDb();
  const row = db
    .prepare(
      "SELECT id, buyer_id, seller_id, status, agreed_price, brief, buyer_budget, delivery_payload, delivery_reject_reason FROM sessions WHERE id = ?"
    )
    .get(sessionId);
  if (!row) return null;
  return {
    sessionId: row.id,
    buyerId: row.buyer_id,
    sellerId: row.seller_id,
    status: row.status,
    agreedPrice: row.agreed_price,
    brief: row.brief,
    buyerBudget: row.buyer_budget,
    deliveryPayload: row.delivery_payload,
    deliveryRejectReason: row.delivery_reject_reason,
  };
}

export function submitMove(sessionId, agentId, move, options = {}) {
  const db = options.db ?? getDb();

  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    return fail("INVALID_SESSION_ID", "Session ID must be a non-empty string.");
  }
  if (typeof agentId !== "string" || agentId.trim() === "") {
    return fail("INVALID_AGENT_ID", "Agent ID must be a non-empty string.");
  }
  if (move === null || typeof move !== "object" || Array.isArray(move)) {
    return fail("INVALID_MOVE", "Move must be an object.");
  }
  const { action, price } = move;
  if (!MOVE_ACTIONS.includes(action)) {
    return fail("INVALID_MOVE", `Action must be one of: ${MOVE_ACTIONS.join(", ")}.`);
  }

  const row = db
    .prepare(
      "SELECT id, buyer_id, seller_id, status, agreed_price, buyer_budget FROM sessions WHERE id = ?"
    )
    .get(sessionId);
  if (!row) {
    return fail("SESSION_NOT_FOUND", `Session "${sessionId}" was not found.`);
  }
  const isBuyer = agentId === row.buyer_id;
  const isSeller = agentId === row.seller_id;
  if (!isBuyer && !isSeller) {
    return fail("NOT_PARTICIPANT", "Agent is not a participant in this session.");
  }
  if (row.status !== "NEGOTIATING") {
    return fail(
      "INVALID_STATE",
      `Session is ${row.status}; moves are only accepted while NEGOTIATING.`
    );
  }

  if (action === "WALK") {
    db.prepare("UPDATE sessions SET status = 'REJECTED' WHERE id = ?").run(sessionId);
    return {
      success: true,
      session: { sessionId, status: "REJECTED", agreedPrice: null },
    };
  }

  if (!Number.isInteger(price) || price <= 0) {
    return fail("INVALID_PRICE", "Price must be an integer greater than 0.");
  }

  if (isBuyer && price > row.buyer_budget) {
    return fail(
      "BUDGET_EXCEEDED",
      `Price ${price} exceeds the buyer budget of ${row.buyer_budget}.`
    );
  }
  if (isSeller) {
    const seller = db
      .prepare("SELECT floor_price FROM agents WHERE agent_id = ?")
      .get(row.seller_id);
    if (!seller) {
      return fail("SELLER_NOT_FOUND", `Seller "${row.seller_id}" is not registered.`);
    }
    if (price < seller.floor_price) {
      return fail(
        "FLOOR_EXCEEDED",
        `Price ${price} is below the seller floor of ${seller.floor_price}.`
      );
    }
  }

  if (action === "OFFER") {
    return {
      success: true,
      session: { sessionId, status: "NEGOTIATING", agreedPrice: null },
    };
  }

  db.prepare("UPDATE sessions SET status = 'ESCROW_LOCKED', agreed_price = ? WHERE id = ?").run(
    price,
    sessionId
  );
  return {
    success: true,
    session: { sessionId, status: "ESCROW_LOCKED", agreedPrice: price },
  };
}

export function deliverWork(sessionId, agentId, payload, options = {}) {
  const db = options.db ?? getDb();

  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    return fail("INVALID_SESSION_ID", "Session ID must be a non-empty string.");
  }
  if (typeof agentId !== "string" || agentId.trim() === "") {
    return fail("INVALID_AGENT_ID", "Agent ID must be a non-empty string.");
  }
  if (typeof payload !== "string" || payload.trim() === "") {
    return fail("INVALID_PAYLOAD", "Payload must be a non-empty string.");
  }

  const row = db
    .prepare("SELECT id, buyer_id, seller_id, status, agreed_price FROM sessions WHERE id = ?")
    .get(sessionId);
  if (!row) {
    return fail("SESSION_NOT_FOUND", `Session "${sessionId}" was not found.`);
  }
  if (agentId !== row.seller_id) {
    return fail("SELLER_ONLY", "Only the assigned seller can deliver work.");
  }
  if (row.status !== "ESCROW_LOCKED") {
    return fail(
      "INVALID_STATE",
      `Session is ${row.status}; delivery is only accepted while ESCROW_LOCKED.`
    );
  }

  const verdict = verifyDelivery(sessionId, payload);
  if (verdict.success) {
    db.prepare(
      "UPDATE sessions SET delivery_payload = ?, delivery_reject_reason = NULL, status = 'SETTLED' WHERE id = ?"
    ).run(payload, sessionId);
    return {
      success: true,
      session: { sessionId, status: "SETTLED", agreedPrice: row.agreed_price },
    };
  }
  db.prepare(
    "UPDATE sessions SET delivery_payload = ?, delivery_reject_reason = ?, status = 'REJECTED' WHERE id = ?"
  ).run(payload, verdict.reason, sessionId);
  return {
    success: true,
    session: {
      sessionId,
      status: "REJECTED",
      agreedPrice: row.agreed_price,
      reason: verdict.reason,
    },
  };
}
