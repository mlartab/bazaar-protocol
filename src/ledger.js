import { getDb } from "./db.js";

export const STARTING_BALANCE = 1000;

const fail = (code, message) => ({ success: false, error: { code, message } });

function assertAgentId(agentId) {
  if (typeof agentId !== "string" || agentId.trim() === "") {
    throw Object.assign(new Error("Agent ID must be a non-empty string."), {
      code: "INVALID_AGENT_ID",
    });
  }
}

function runAtomically(db, fn) {
  if (db.inTransaction) return fn();
  return db.transaction(fn)();
}

export function ensureWallet(agentId, db = getDb()) {
  assertAgentId(agentId);
  db.prepare("INSERT OR IGNORE INTO wallets (agent_id, balance) VALUES (?, ?)").run(
    agentId,
    STARTING_BALANCE
  );
  return db.prepare("SELECT balance FROM wallets WHERE agent_id = ?").get(agentId).balance;
}

export function getBalance(agentId, db = getDb()) {
  return ensureWallet(agentId, db);
}

export function lockFunds(buyerId, sessionId, amount, db = getDb()) {
  if (typeof buyerId !== "string" || buyerId.trim() === "") {
    return fail("INVALID_BUYER_ID", "Buyer ID must be a non-empty string.");
  }
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    return fail("INVALID_SESSION_ID", "Session ID must be a non-empty string.");
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    return fail("INVALID_AMOUNT", "Amount must be an integer greater than 0.");
  }

  const session = db
    .prepare("SELECT id, buyer_id, seller_id, escrow_locked FROM sessions WHERE id = ?")
    .get(sessionId);
  if (!session) {
    return fail("SESSION_NOT_FOUND", `Session "${sessionId}" was not found.`);
  }
  if (session.buyer_id !== buyerId) {
    return fail("NOT_PARTICIPANT", "Buyer does not own this session.");
  }
  if ((session.escrow_locked ?? 0) !== 0) {
    return fail("INVALID_STATE", "Escrow is already locked for this session.");
  }

  ensureWallet(buyerId, db);
  ensureWallet(session.seller_id, db);

  const apply = () => {
    const debit = db
      .prepare("UPDATE wallets SET balance = balance - ? WHERE agent_id = ? AND balance >= ?")
      .run(amount, buyerId, amount);
    if (debit.changes === 0) {
      return fail(
        "INSUFFICIENT_FUNDS",
        `Buyer "${buyerId}" has insufficient funds to lock ${amount}.`
      );
    }
    db.prepare("UPDATE sessions SET escrow_locked = ? WHERE id = ?").run(amount, sessionId);
    const balance = db.prepare("SELECT balance FROM wallets WHERE agent_id = ?").get(buyerId).balance;
    return { success: true, escrowLocked: amount, balance };
  };

  return runAtomically(db, apply);
}

function moveEscrowTo(agentId, sessionId, expectedRole, db) {
  if (typeof agentId !== "string" || agentId.trim() === "") {
    return fail("INVALID_AGENT_ID", "Agent ID must be a non-empty string.");
  }
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    return fail("INVALID_SESSION_ID", "Session ID must be a non-empty string.");
  }

  const session = db
    .prepare("SELECT id, buyer_id, seller_id, escrow_locked FROM sessions WHERE id = ?")
    .get(sessionId);
  if (!session) {
    return fail("SESSION_NOT_FOUND", `Session "${sessionId}" was not found.`);
  }
  const ownerId = expectedRole === "seller" ? session.seller_id : session.buyer_id;
  if (ownerId !== agentId) {
    const code = expectedRole === "seller" ? "SELLER_ONLY" : "NOT_PARTICIPANT";
    return fail(code, "Agent does not own this escrow leg.");
  }
  const locked = session.escrow_locked ?? 0;
  if (!Number.isInteger(locked) || locked <= 0) {
    return fail("NO_ESCROW", "No escrow is locked for this session.");
  }

  ensureWallet(agentId, db);

  const apply = () => {
    const cleared = db
      .prepare("UPDATE sessions SET escrow_locked = 0 WHERE id = ? AND escrow_locked = ?")
      .run(sessionId, locked);
    if (cleared.changes === 0) {
      return fail("NO_ESCROW", "No escrow is locked for this session.");
    }
    db.prepare("UPDATE wallets SET balance = balance + ? WHERE agent_id = ?").run(locked, agentId);
    const balance = db.prepare("SELECT balance FROM wallets WHERE agent_id = ?").get(agentId).balance;
    return { success: true, released: locked, balance };
  };

  return runAtomically(db, apply);
}

export function releaseFunds(sellerId, sessionId, db = getDb()) {
  return moveEscrowTo(sellerId, sessionId, "seller", db);
}

export function refundFunds(buyerId, sessionId, db = getDb()) {
  return moveEscrowTo(buyerId, sessionId, "buyer", db);
}

export function slashStake(sellerId, amount, db = getDb()) {
  if (typeof sellerId !== "string" || sellerId.trim() === "") {
    return fail("INVALID_SELLER_ID", "Seller ID must be a non-empty string.");
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    return fail("INVALID_AMOUNT", "Amount must be an integer greater than 0.");
  }
  const seller = db
    .prepare("SELECT agent_id, stake_balance, status FROM agents WHERE agent_id = ?")
    .get(sellerId);
  if (!seller) {
    return fail("SELLER_NOT_FOUND", `Seller "${sellerId}" is not registered.`);
  }

  const apply = () => {
    const stakeBalance = (seller.stake_balance ?? 0) - amount;
    const status = stakeBalance < 20 ? "SUSPENDED" : seller.status;
    db.prepare("UPDATE agents SET stake_balance = ?, status = ? WHERE agent_id = ?").run(
      stakeBalance,
      status,
      sellerId
    );
    return { success: true, stakeBalance, status };
  };

  return runAtomically(db, apply);
}

export function creditWallet(agentId, amount, db = getDb()) {
  if (typeof agentId !== "string" || agentId.trim() === "") {
    return fail("INVALID_AGENT_ID", "Agent ID must be a non-empty string.");
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    return fail("INVALID_AMOUNT", "Amount must be an integer greater than 0.");
  }

  ensureWallet(agentId, db);

  const apply = () => {
    db.prepare("UPDATE wallets SET balance = balance + ? WHERE agent_id = ?").run(amount, agentId);
    const balance = db.prepare("SELECT balance FROM wallets WHERE agent_id = ?").get(agentId).balance;
    return { success: true, balance };
  };

  return runAtomically(db, apply);
}
