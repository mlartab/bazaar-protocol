import crypto from "node:crypto";
import { SESSION_TTL_MS, getDb } from "./db.js";
import { verifyDelivery } from "./inspector.js";
import { creditWallet, lockFunds, refundFunds, releaseFunds, slashStake } from "./ledger.js";

export const STAKE_SLASH_AMOUNT = 50;

export const SESSION_STATUSES = [
  "NEGOTIATING",
  "ESCROW_LOCKED",
  "DELIVERED",
  "SETTLED",
  "REJECTED",
  "EXPIRED",
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

function resolveQuantity(brief, optionsQuantity) {
  if (optionsQuantity !== undefined) return optionsQuantity;
  if (brief !== null && typeof brief === "object" && !Array.isArray(brief)) {
    if (brief.quantity !== undefined) return brief.quantity;
  }
  return 1;
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

  const quantity = resolveQuantity(brief, options.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return fail(
      "INVALID_QUANTITY",
      "Quantity must be an integer greater than 0 (brief.quantity or options.quantity)."
    );
  }

  const createdAt = new Date().toISOString();
  const briefText = serializeBrief(brief);

  for (let attempt = 0; attempt < 3; attempt++) {
    const sessionId = crypto.randomUUID();
    try {
      db.prepare(
        `INSERT INTO sessions
          (id, buyer_id, seller_id, status, agreed_price, brief, buyer_budget, quantity, expires_at, created_at)
         VALUES (?, ?, ?, 'NEGOTIATING', NULL, ?, ?, ?, ?, ?)`
      ).run(
        sessionId,
        buyerId,
        sellerId,
        briefText,
        budget,
        quantity,
        Date.now() + SESSION_TTL_MS,
        createdAt
      );
      return {
        success: true,
        session: {
          sessionId,
          buyerId,
          sellerId,
          status: "NEGOTIATING",
          brief: briefText,
          buyerBudget: budget,
          quantity,
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
      "SELECT id, buyer_id, seller_id, status, agreed_price, brief, buyer_budget, delivery_payload, delivery_reject_reason, escrow_locked, quantity FROM sessions WHERE id = ?"
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
    escrowLocked: row.escrow_locked ?? 0,
    quantity: row.quantity ?? 1,
  };
}

export function expireStaleSessions(db = getDb()) {
  const now = Date.now();
  const stale = db
    .prepare(
      "SELECT id, buyer_id, status FROM sessions WHERE status IN ('NEGOTIATING', 'ESCROW_LOCKED') AND expires_at IS NOT NULL AND expires_at < ?"
    )
    .all(now);
  const sweep = db.transaction(() => {
    for (const row of stale) {
      if (row.status === "ESCROW_LOCKED") {
        const refunded = refundFunds(row.buyer_id, row.id, db);
        if (!refunded.success) {
          throw Object.assign(new Error(refunded.error.message), { sweepError: refunded.error });
        }
      }
      db.prepare("UPDATE sessions SET status = 'EXPIRED' WHERE id = ?").run(row.id);
    }
  });
  sweep();
  return stale.length;
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

  if (price > row.buyer_budget) {
    return fail(
      "BUDGET_EXCEEDED",
      `Price ${price} exceeds the buyer budget of ${row.buyer_budget}.`
    );
  }
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

  if (action === "OFFER") {
    return {
      success: true,
      session: { sessionId, status: "NEGOTIATING", agreedPrice: null },
    };
  }

  const lockAndAccept = db.transaction(() => {
    const locked = lockFunds(row.buyer_id, sessionId, price, db);
    if (!locked.success) {
      throw Object.assign(new Error(locked.error.message), { ledgerError: locked.error });
    }
    db.prepare("UPDATE sessions SET status = 'ESCROW_LOCKED', agreed_price = ? WHERE id = ?").run(
      price,
      sessionId
    );
  });
  try {
    lockAndAccept();
  } catch (err) {
    if (err?.ledgerError) return { success: false, error: err.ledgerError };
    throw err;
  }
  return {
    success: true,
    session: { sessionId, status: "ESCROW_LOCKED", agreedPrice: price },
  };
}

export async function deliverWork(sessionId, agentId, payload, options = {}) {
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
    .prepare(
      "SELECT id, buyer_id, seller_id, status, agreed_price, brief, quantity FROM sessions WHERE id = ?"
    )
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

  const seller = db
    .prepare("SELECT capability FROM agents WHERE agent_id = ?")
    .get(row.seller_id);
  if (!seller) {
    return fail("SELLER_NOT_FOUND", `Seller "${row.seller_id}" is not registered.`);
  }

  const inspect = options.verifyDelivery ?? verifyDelivery;
  let verdict;
  try {
    verdict = await inspect(sessionId, payload, {
      brief: row.brief,
      capability: seller.capability,
      quantity: row.quantity ?? 1,
    });
  } catch (err) {
    return fail("INSPECTOR_UNAVAILABLE", err?.message ?? "Inspector is unavailable.");
  }
  const validVerdict =
    verdict &&
    ((verdict.success === true && verdict.status === "SETTLED") ||
      (verdict.success === false && verdict.status === "REJECTED"));
  if (!validVerdict) {
    return fail("INSPECTOR_UNAVAILABLE", "Inspector returned an inconclusive verdict.");
  }
  if (verdict.success) {
    const settle = db.transaction(() => {
      const released = releaseFunds(row.seller_id, sessionId, db);
      if (!released.success) {
        throw Object.assign(new Error(released.error.message), { ledgerError: released.error });
      }
      db.prepare(
        "UPDATE sessions SET delivery_payload = ?, delivery_reject_reason = NULL, status = 'SETTLED' WHERE id = ?"
      ).run(payload, sessionId);
    });
    try {
      settle();
    } catch (err) {
      if (err?.ledgerError) return { success: false, error: err.ledgerError };
      throw err;
    }
    return {
      success: true,
      session: { sessionId, status: "SETTLED", agreedPrice: row.agreed_price },
    };
  }
  const refund = db.transaction(() => {
    const refunded = refundFunds(row.buyer_id, sessionId, db);
    if (!refunded.success) {
      throw Object.assign(new Error(refunded.error.message), { ledgerError: refunded.error });
    }
    const slashed = slashStake(row.seller_id, STAKE_SLASH_AMOUNT, db);
    if (!slashed.success) {
      throw Object.assign(new Error(slashed.error.message), { ledgerError: slashed.error });
    }
    const credited = creditWallet(row.buyer_id, STAKE_SLASH_AMOUNT, db);
    if (!credited.success) {
      throw Object.assign(new Error(credited.error.message), { ledgerError: credited.error });
    }
    db.prepare(
      "UPDATE sessions SET delivery_payload = ?, delivery_reject_reason = ?, status = 'REJECTED' WHERE id = ?"
    ).run(payload, verdict.reason, sessionId);
  });
  try {
    refund();
  } catch (err) {
    if (err?.ledgerError) return { success: false, error: err.ledgerError };
    throw err;
  }
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
