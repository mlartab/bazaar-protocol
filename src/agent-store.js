import crypto from "node:crypto";
import net from "node:net";
import { getDb } from "./db.js";

export const CAPABILITIES = ["image_gen", "video_gen", "text_gen", "doc_gen", "report_gen"];

const fail = (code, message) => ({ success: false, error: { code, message } });

function isPrivateIPv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  return false;
}

function isBlockedHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
  if (host.startsWith("::ffff:")) {
    const v4 = host.slice("::ffff:".length);
    if (net.isIPv4(v4) && isPrivateIPv4(v4)) return true;
  }
  if (net.isIPv4(host)) return isPrivateIPv4(host);
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10)
  if (net.isIPv6(host)) {
    const h = host.toLowerCase();
    if (h.startsWith("fc") || h.startsWith("fd")) return true;
    if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) {
      return true;
    }
  }
  return false;
}

export function validateWebhookUrl(webhookUrl) {
  let parsed;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    return fail("INVALID_WEBHOOK_URL", "Webhook URL must be a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return fail("INVALID_WEBHOOK_URL", "Webhook URL must use http or https.");
  }
  if (!parsed.hostname || isBlockedHostname(parsed.hostname)) {
    return fail(
      "INVALID_WEBHOOK_URL",
      "Webhook URL must not target localhost, loopback, or private network addresses."
    );
  }
  return null;
}

export function computeHexSeal(agentId, publicKey, did) {
  const input = did ? `${agentId}${publicKey}${did}` : `${agentId}${publicKey}`;
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

export function registerAgent(agentData, options = {}) {
  const db = options.db ?? getDb();
  const { agentId, publicKey, capability, floorPrice, webhookUrl, did, profile } = agentData ?? {};

  if (typeof agentId !== "string" || agentId.trim() === "") {
    return fail("INVALID_AGENT_ID", "Agent ID must be a non-empty string.");
  }
  if (typeof publicKey !== "string" || publicKey.trim() === "") {
    return fail("INVALID_PUBLIC_KEY", "Public key must be a non-empty string.");
  }
  if (!CAPABILITIES.includes(capability)) {
    return fail(
      "INVALID_CAPABILITY",
      `Capability must be one of: ${CAPABILITIES.join(", ")}.`
    );
  }
  if (!Number.isInteger(floorPrice) || floorPrice <= 0) {
    return fail("INVALID_FLOOR_PRICE", "Floor price must be an integer greater than 0.");
  }
  const webhookError = validateWebhookUrl(webhookUrl);
  if (webhookError) return webhookError;
  if (did !== undefined && did !== null && did !== "") {
    if (typeof did !== "string" || did.trim() === "") {
      return fail("INVALID_DID", "DID must be a non-empty string when provided.");
    }
  }
  const normalizedDid = typeof did === "string" && did.trim() !== "" ? did : null;

  if (profile !== undefined && profile !== null && (typeof profile !== "object" || Array.isArray(profile))) {
    return fail("INVALID_PROFILE", "Profile must be an object with optional title, description, and category.");
  }
  const normalizedProfile = {};
  for (const key of ["title", "description", "category"]) {
    const value = profile?.[key] ?? agentData?.[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string") {
      return fail("INVALID_PROFILE", `Profile ${key} must be a string when provided.`);
    }
    const trimmed = value.trim();
    if (trimmed !== "") normalizedProfile[key] = trimmed;
  }

  const existing = db.prepare("SELECT agent_id FROM agents WHERE agent_id = ?").get(agentId);
  if (existing) {
    return fail("DUPLICATE_AGENT_ID", `Agent ID "${agentId}" is already registered.`);
  }

  const hexSeal = computeHexSeal(agentId, publicKey, normalizedDid);
  const createdAt = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO agents
        (agent_id, public_key, capability, floor_price, webhook_url, status, hex_seal, did, title, description, category, created_at)
       VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?)`
    ).run(agentId, publicKey, capability, floorPrice, webhookUrl, hexSeal, normalizedDid, normalizedProfile.title ?? null, normalizedProfile.description ?? null, normalizedProfile.category ?? null, createdAt);
  } catch (err) {
    if (err?.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || err?.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return fail("DUPLICATE_AGENT_ID", `Agent ID "${agentId}" is already registered.`);
    }
    throw err;
  }

  return {
    success: true,
    agent: {
      agentId,
      publicKey,
      capability,
      floorPrice,
      webhookUrl,
      status: "ACTIVE",
      hexSeal,
      ...(normalizedDid ? { did: normalizedDid } : {}),
      ...(normalizedProfile.title ? { title: normalizedProfile.title } : {}),
      ...(normalizedProfile.description ? { description: normalizedProfile.description } : {}),
      ...(normalizedProfile.category ? { category: normalizedProfile.category } : {}),
    },
  };
}
