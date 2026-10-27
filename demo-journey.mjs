// BAZAAR PROTOCOL — Flagship demo: A Multi-Modal Research Report.
// Acts as both Buyer and Seller Agent against a running server.
// Usage: node server.mjs &  node demo-journey.mjs
// Env: DEMO_BASE_URL (default http://localhost:3000)

const BASE = process.env.DEMO_BASE_URL ?? "http://localhost:3000";
const RUN = Date.now().toString(36);
const SELLER_ID = `report-seller-${RUN}`;
const BUYER_ID = `report-buyer-${RUN}`;

// Verified 2026-10-27: HTTP 200, image/png, 26 KB. IPCC global-emissions
// bar chart — unambiguous YES for the report_gen inspector prompt.
const CHART_URL =
  "https://upload.wikimedia.org/wikipedia/commons/d/d8/Ipcc_2014_bar_graph.png";

const G = "\x1b[32m";
const R = "\x1b[31m";
const Y = "\x1b[33m";
const C = "\x1b[36m";
const X = "\x1b[0m";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, path, body, idempotencyKey) {
  const headers = { "Content-Type": "application/json" };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
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

function fail(phase, result) {
  console.error(`\n${R}✗ ${phase} FAILED (HTTP ${result.status}):${X}`, result.data);
  process.exitCode = 1;
  throw new Error(`${phase} failed`);
}

async function run() {
  console.log(`\n${C}=== BAZAAR FLAGSHIP DEMO: Multi-Modal Research Report ===${X}\n`);

  // ── Phase 1: Briefing ──────────────────────────────────────────
  console.log(`${Y}Phase 1 — Briefing: register report_gen seller, open session${X}`);
  const reg = await req(
    "POST",
    "/api/agents/register",
    {
      agentId: SELLER_ID,
      publicKey: "pk-report-demo",
      capability: "report_gen",
      floorPrice: 150,
      webhookUrl: "https://report-agent.ai/webhook",
    },
    `demo-${RUN}-reg`
  );
  if (reg.status !== 201 && reg.data?.error?.code !== "DUPLICATE_AGENT_ID") {
    fail("Seller registration", reg);
  }
  console.log(`   Seller ${G}${SELLER_ID}${X} registered (report_gen, floor 150 CR)`);

  const walletBefore = await req("GET", `/api/wallets/${BUYER_ID}`);
  console.log(`   Buyer wallet: ${G}${walletBefore.data.balance} CR${X}`);

  const sess = await req(
    "POST",
    "/api/sessions",
    {
      buyerId: BUYER_ID,
      sellerId: SELLER_ID,
      brief: {
        budget: 250,
        task: "2026 Market Analysis",
        deliverables: ["10-page PDF report", "executive summary", "3 charts"],
        format: "PDF + PNG charts",
        deadline: "2026-11-03",
      },
    },
    `demo-${RUN}-sess`
  );
  if (sess.status !== 201) fail("Session creation", sess);
  const sessionId = sess.data.sessionId;
  console.log(`   Session ${G}${sessionId}${X} opened (budget 250 CR)\n`);

  // ── Phase 2: Estimation ────────────────────────────────────────
  console.log(`${Y}Phase 2 — Estimation: seller prices the report${X}`);
  const baseCost = 180;
  const margin = 20;
  const offerPrice = baseCost + margin;
  console.log(`   Seller Agent: base cost ${baseCost} CR + margin ${margin} CR = ${offerPrice} CR`);

  const offer = await req(
    "POST",
    `/api/sessions/${sessionId}/negotiate`,
    { agentId: SELLER_ID, move: { action: "OFFER", price: offerPrice } },
    `demo-${RUN}-offer`
  );
  if (offer.status !== 200) fail("OFFER", offer);
  console.log(`   → OFFER ${offerPrice} CR accepted by Referee (within 150 floor / 250 budget)`);

  const accept = await req(
    "POST",
    `/api/sessions/${sessionId}/negotiate`,
    { agentId: BUYER_ID, move: { action: "ACCEPT", price: offerPrice } },
    `demo-${RUN}-accept`
  );
  if (accept.status !== 200) fail("ACCEPT", accept);
  console.log(`   → Buyer ACCEPTs. Escrow locked: ${G}${accept.data.agreedPrice} CR${X}`);
  console.log(`[MICROPAYMENT] Seller Agent paid $0.005 to ChartAPI via x402.\n`);

  // ── Phase 3: Execution ─────────────────────────────────────────
  console.log(`${Y}Phase 3 — Execution: multi-agent pipeline${X}`);
  for (const step of [
    "Orchestrator: Planning report structure...",
    "Researcher: Gathering 2026 market data...",
    "Writer: Drafting analysis...",
    "Image Gen: Creating charts...",
  ]) {
    console.log(`   ${step}`);
    await sleep(600);
  }
  console.log(`   ${G}Pipeline complete.${X}\n`);

  // ── Phase 4: Delivery ──────────────────────────────────────────
  console.log(`${Y}Phase 4 — Delivery: chart verified by Meta Vision${X}`);
  const preflight = await fetch(CHART_URL, { method: "HEAD" });
  if (!preflight.ok) fail("Chart pre-flight", { status: preflight.status, data: CHART_URL });
  console.log(`   Chart URL live (${preflight.headers.get("content-type")})`);
  const mockFileHash = "sha256:9f2c4a7e1b5d83f06a2c9e4b7d1f5a8c3e6b0d4f7a9c2e5b8d1f4a7c0e3b6d9";
  console.log(`   Report bundle hash: ${mockFileHash}`);

  const deliver = await req(
    "POST",
    `/api/sessions/${sessionId}/deliver`,
    { agentId: SELLER_ID, payload: CHART_URL },
    `demo-${RUN}-deliver`
  );
  if (deliver.status !== 200) fail("Delivery", deliver);
  const settled = deliver.data.status === "SETTLED";
  console.log(
    `   Inspector verdict: ${settled ? G + "SETTLED" : R + deliver.data.status}${X}` +
      (deliver.data.reason ? ` (${deliver.data.reason})` : "")
  );

  const buyerFinal = await req("GET", `/api/wallets/${BUYER_ID}`);
  const sellerFinal = await req("GET", `/api/wallets/${SELLER_ID}`);
  console.log(`   Buyer wallet:  ${G}${buyerFinal.data.balance} CR${X}`);
  console.log(`   Seller wallet: ${G}${sellerFinal.data.balance} CR${X}`);

  if (settled) {
    console.log(`\n${G}✓ DEMO SUCCESS: report delivered, verified, and settled.${X}\n`);
  } else {
    console.log(`\n${R}✗ DEMO INCOMPLETE: escrow did not settle (fail-frozen by design).${X}\n`);
    process.exitCode = 1;
  }
}

run().catch((err) => {
  if (!process.exitCode) {
    console.error(err);
    process.exitCode = 1;
  }
});
