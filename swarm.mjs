// BAZAAR PROTOCOL — Live Economic Loop (Swarm).
// Drives continuous buyer→seller trades against the FROZEN backend to feed
// the SSE Ant Farm UI. Demonstrates honest settlements + scammer rejections.
// Usage:
//   node server.mjs &
//   node swarm.mjs [--trades N] [--infinite]
// Env: SWARM_BASE_URL (default http://localhost:3000), SWARM_TRADES, SWARM_SLEEP_MS
// Rules: native fetch only, fresh Idempotency-Key per call, no src/ edits.

import crypto from "node:crypto";

// Loopback fetch must never go through a proxy (sandboxed/proxied envs).
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");
process.env.no_proxy = [process.env.no_proxy, "127.0.0.1,localhost"].filter(Boolean).join(",");

const BASE =
  process.env.SWARM_BASE_URL ??
  process.env.DEMO_BASE_URL ??
  "http://localhost:3000";
const DEFAULT_TRADES = Number(process.env.SWARM_TRADES ?? 10);
const SLEEP_MS = Number(process.env.SWARM_SLEEP_MS ?? 2000);
const BUDGET = 100;

// Sellers to ensure exist. image_gen so delivery hits Meta Vision
// (text_gen/doc_gen auto-settle and would defeat the honest/scam twist).
const SELLERS = [
  {
    agentId: "seller-alpha",
    publicKey: "pk-swarm-alpha",
    capability: "image_gen",
    floorPrice: 50,
    webhookUrl: "https://swarm.ai/webhook/alpha",
    profile: {
      title: "Alpha Vision Bot",
      description: "High-end generative art, verified on delivery.",
      category: "premium-image",
    },
  },
  {
    agentId: "seller-beta",
    publicKey: "pk-swarm-beta",
    capability: "image_gen",
    floorPrice: 30,
    webhookUrl: "https://swarm.ai/webhook/beta",
    profile: {
      title: "Beta Pixel Forge",
      description: "Fast budget renders for rapid prototyping.",
      category: "budget-image",
    },
  },
];

const IMAGES = {
  // A valid 1x1 pixel image for "Honest" (passes Meta Vision)
  good: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  // An invalid string for "Scammer" (fails Meta Vision)
  bad: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="
};

// ANSI colors (no dependencies).
const X = "\x1b[0m";
const B = "\x1b[1m";
const D = "\x1b[2m";
const R = "\x1b[31m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const BL = "\x1b[34m";
const M = "\x1b[35m";
const C = "\x1b[36m";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Every API call carries a fresh Idempotency-Key (POSTs require it; harmless on GETs).
async function req(method, path, body) {
  const headers = {
    "Content-Type": "application/json",
    "Idempotency-Key": crypto.randomUUID(),
  };
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

function logBuyer(msg) {
  console.log(`${C}[BUYER]${X} ${msg}`);
}

function logSeller(msg) {
  console.log(`${M}[SELLER]${X} ${msg}`);
}

function logReferee(msg, color = Y) {
  console.log(`${color}[REFEREE]${X} ${msg}`);
}

async function ensureSellers() {
  console.log(`\n${B}${BL}=== BAZAAR SWARM: Live Economic Loop ===${X}`);
  console.log(`${D}Base: ${BASE}${X}\n`);

  let existing = new Set();
  try {
    const list = await req("GET", "/api/agents");
    if (list.status === 200 && Array.isArray(list.data?.agents)) {
      existing = new Set(list.data.agents.map((a) => a.agentId));
    }
  } catch {
    // Fall through to register attempts; health check below will fail fast.
  }

  for (const seller of SELLERS) {
    if (existing.has(seller.agentId)) {
      console.log(
        `  Seller ${G}${seller.agentId}${X} already registered (floor ${seller.floorPrice})`
      );
      continue;
    }
    const res = await req("POST", "/api/agents/register", seller);
    if (res.status === 201) {
      console.log(
        `  Seller ${G}${seller.agentId}${X} registered (floor ${seller.floorPrice})`
      );
    } else if (res.data?.error?.code === "DUPLICATE_AGENT_ID") {
      console.log(
        `  Seller ${G}${seller.agentId}${X} already registered (floor ${seller.floorPrice})`
      );
    } else {
      console.error(
        `  ${R}Failed to register ${seller.agentId} (HTTP ${res.status}):${X}`,
        res.data
      );
      throw new Error(`seller registration failed: ${seller.agentId}`);
    }
  }
  console.log("");
}

async function runTrade(n) {
  const seller = pick(SELLERS);
  const buyerId = `buyer-${rand(100, 999)}`;
  const isHonest = Math.random() < 0.5;

  // Brief matches the honest image, mismatches the scam image.
  const brief = isHonest
    ? {
        budget: BUDGET,
        task: "IPCC bar graph of global emissions",
        format: "PNG chart",
      }
    : {
        budget: BUDGET,
        task: "cyberpunk ad campaign hero image",
        format: "PNG",
      };

  console.log(`${B}━━━ Trade #${n} ━━━${X}`);
  logBuyer(
    `Initiating session with ${B}${seller.agentId}${X} (Budget: ${BUDGET})...`
  );

  // 1. Open session.
  const sess = await req("POST", "/api/sessions", {
    buyerId,
    sellerId: seller.agentId,
    brief,
  });
  if (sess.status !== 201) {
    logReferee(`Session rejected (HTTP ${sess.status}): ${sess.data?.error?.code ?? "unknown"}`, R);
    return { outcome: "session-failed" };
  }
  const sessionId = sess.data.sessionId;
  console.log(`  ${D}Session ${sessionId} opened | ${buyerId} → ${seller.agentId}${X}`);
  await sleep(400);

  // 2. Negotiation (max 2 successful moves): buyer lowballs, then counters.
  const lowball = Math.max(1, seller.floorPrice - rand(5, 15));
  logBuyer(`Lowball OFFER ${B}${lowball} CR${X} (floor is ${seller.floorPrice})...`);
  const low = await req("POST", `/api/sessions/${sessionId}/negotiate`, {
    agentId: buyerId,
    move: { action: "OFFER", price: lowball },
  });

  let agreedPrice = lowball;
  if (low.status === 422 && low.data?.error?.code === "FLOOR_EXCEEDED") {
    logReferee(`Blocked! Price ${lowball} below floor ${seller.floorPrice}.`, Y);
    // Buyer counters with a fair price inside [floor, budget].
    agreedPrice = Math.min(BUDGET, seller.floorPrice + rand(5, 25));
    logBuyer(`Counter OFFER ${B}${agreedPrice} CR${X}...`);
    const counter = await req("POST", `/api/sessions/${sessionId}/negotiate`, {
      agentId: buyerId,
      move: { action: "OFFER", price: agreedPrice },
    });
    if (counter.status !== 200) {
      logReferee(`Counter rejected: ${counter.data?.error?.code ?? counter.status}`, R);
      return { outcome: "negotiation-failed" };
    }
  } else if (low.status !== 200) {
    logReferee(`Lowball error: ${low.data?.error?.code ?? low.status}`, R);
    return { outcome: "negotiation-failed" };
  } else {
    logReferee(`Lowball ${lowball} is above floor — seller takes it!`, G);
  }

  // Seller accepts (locks escrow).
  logSeller(`Reviewing ${agreedPrice} CR vs floor ${seller.floorPrice}...`);
  const accept = await req("POST", `/api/sessions/${sessionId}/negotiate`, {
    agentId: seller.agentId,
    move: { action: "ACCEPT", price: agreedPrice },
  });
  if (accept.status !== 200) {
    logReferee(`ACCEPT failed: ${accept.data?.error?.code ?? accept.status}`, R);
    return { outcome: "negotiation-failed" };
  }
  console.log(`  ${BL}Escrow locked: ${B}${accept.data.agreedPrice} CR${X}`);
  await sleep(400);

  // 3. Delivery twist: honest valid image vs scammer garbage.
  const payload = isHonest ? HONEST_IMAGE_URL : SCAM_IMAGE_URL;
  logSeller(
    `Delivering payload... (Status: ${isHonest ? `${G}HONEST` : `${R}SCAMMER`}${X})`
  );
  const deliver = await req("POST", `/api/sessions/${sessionId}/deliver`, {
    agentId: seller.agentId,
    payload,
  });

  if (deliver.data?.status === "SETTLED") {
    logReferee(`Settled! Seller paid ${agreedPrice} CR. Vision verdict: YES.`, G);
    return { outcome: "settled" };
  }
  if (deliver.data?.status === "REJECTED") {
    logReferee(
      `Blocked scammer! Stake slashed. Buyer refunded + 50 bonus. (${deliver.data.reason ?? "VISUAL_MISMATCH"})`,
      R
    );
    return { outcome: "rejected" };
  }
  if (deliver.data?.error?.code === "INSPECTOR_UNAVAILABLE") {
    logReferee(`Inspector unavailable — escrow fail-frozen (no funds moved).`, Y);
    return { outcome: "frozen" };
  }
  logReferee(`Delivery error (HTTP ${deliver.status}): ${deliver.data?.error?.code ?? "unknown"}`, R);
  return { outcome: "delivery-failed" };
}

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: node swarm.mjs [--trades N] [--infinite]");
    console.log("  --trades N   Run N trades (default 10, or $SWARM_TRADES)");
    console.log("  --infinite   Run forever until Ctrl+C");
    process.exit(0);
  }
  const infinite =
    args.includes("--infinite") || process.env.SWARM_INFINITE === "1";
  const flagIdx = args.indexOf("--trades");
  const trades =
    flagIdx !== -1 && args[flagIdx + 1] ? Number(args[flagIdx + 1]) : DEFAULT_TRADES;
  return { infinite, trades: Number.isFinite(trades) && trades > 0 ? trades : 10 };
}

async function main() {
  const { infinite, trades } = parseArgs();

  // Fail fast if the server is down.
  try {
    const health = await req("GET", "/health");
    if (health.status !== 200) throw new Error(`HTTP ${health.status}`);
  } catch (err) {
    console.error(`${R}Cannot reach Bazaar server at ${BASE}.${X}`);
    console.error(`Start it first: ${B}node server.mjs${X}`);
    process.exitCode = 1;
    return;
  }

  await ensureSellers();

  const stats = { settled: 0, rejected: 0, other: 0 };
  let n = 0;
  const shouldRun = () => infinite || n < trades;

  while (shouldRun()) {
    n += 1;
    try {
      const { outcome } = await runTrade(n);
      if (outcome === "settled") stats.settled += 1;
      else if (outcome === "rejected") stats.rejected += 1;
      else stats.other += 1;
    } catch (err) {
      logReferee(`Trade #${n} crashed: ${err?.message ?? err}`, R);
      stats.other += 1;
    }
    console.log(
      `  ${D}Tally → ${G}settled ${stats.settled}${X} ${D}|${X} ${R}rejected ${stats.rejected}${X} ${D}|${X} other ${stats.other}${X}\n`
    );
    if (shouldRun()) await sleep(SLEEP_MS);
  }

  console.log(
    `${B}Swarm complete: ${n} trades → ${G}${stats.settled} settled${X}, ${R}${stats.rejected} rejected${X}, ${stats.other} other.${X}\n`
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
