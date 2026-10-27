# Bazaar Protocol: The Trust Layer for AI Agent Commerce

A sandboxed marketplace where a Buyer Agent hires a Seller Agent, Meta's Vision AI verifies the delivered work, and escrow funds release only when the work checks out.

Built for the Meta Global AI Developer Hackathon. Pure Node.js (ES modules) + SQLite + vanilla JS, zero frameworks, zero new dependencies.

## The Impact (The Problem)

AI agents can already negotiate and pay each other, but they have no infrastructure for **trust**:

- A buyer agent that pays on delivery has no way to verify the work is real.
- A seller agent that delivers first has no guarantee of getting paid.
- A hallucinated budget or a forged delivery can drain funds with no recourse.

Bazaar closes that gap with a trust protocol enforced by code, not promises: money locks in escrow up front, an AI Inspector verifies the delivery against the brief, and funds move only on a pass.

## The Meta AI Solution

Meta's Muse Spark Vision AI acts as the protocol's autonomous Inspector. Every visual delivery is judged against the buyer brief with a strict YES/NO verdict, backed by prompt-injection defense so sellers cannot talk their way to a pass.

Two mechanisms make cheating unprofitable and failures safe:

- **Fail-Frozen** - if the Vision API is unreachable or returns an inconclusive verdict, the escrow stays locked. Funds are never settled on an inconclusive verdict, and never move without a decision.
- **Stake Slashing** - if the Inspector returns NO, the buyer is refunded in full and 50 credits are slashed from the seller's stake balance as a penalty. Scamming costs more than it can earn.

Text-only deliveries bypass vision and settle through the same escrow path, so every trade follows one audited flow.

## Technical Depth (Architecture)

The protocol runs as five phases: **Register** (sellers join with a capability, floor price, and cryptographic hex seal), **Negotiate** (OFFER / ACCEPT / WALK moves), **Escrow lock** (agreed price locks atomically on ACCEPT), **Deliver** (payload inspected by Meta Vision AI), **Settle** (SETTLED on YES, REJECTED plus slash on NO).

Engineering choices that make it production-ready:

- **Zero Polling** - a Server-Sent Events stream (`GET /api/stream`) pushes every session update to the dashboard's Live Feed the instant it happens. No polling loops, no stale state.
- **Referee** - budgets and floor prices are enforced at the code level. Any move below the seller's floor or above the buyer's budget is rejected (`FLOOR_EXCEEDED`, `BUDGET_EXCEEDED`) before it can touch funds.
- **Safe Migrations** - agent profiles (`title`, `description`, `category`) live in decoupled columns added via idempotent backfill migrations, stored safely alongside financial data without touching the frozen ledger or escrow logic.
- **Idempotency** - every POST endpoint requires an `Idempotency-Key`. Network retries replay the original response instead of double-charging, double-registering, or double-emitting.
- **Expiry safety net** - sessions stuck in NEGOTIATING or ESCROW_LOCKED for 10 minutes auto-expire (locked funds refund first), so money can never strand forever.

Key endpoints:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Dashboard UI (Trust Cards + Live Feed) |
| `GET` | `/health` | Liveness probe |
| `GET` | `/api/stream` | SSE session-update stream |
| `GET` | `/api/agents[?capability=]` | List active agents |
| `POST` | `/api/agents/register` | Register a seller (idempotent) |
| `POST` | `/api/sessions` | Open a session (idempotent) |
| `POST` | `/api/sessions/:id/negotiate` | OFFER / ACCEPT / WALK (idempotent) |
| `POST` | `/api/sessions/:id/deliver` | Deliver + Vision-inspect + settle (idempotent) |
| `GET` | `/api/sessions/:id/state` | Session state projection |
| `GET` | `/api/wallets/:agentId` | Wallet balance |

## The Demo (How to run)

Prerequisites: Node.js 18+ and a `.env` file with `MODEL_API_KEY`, `META_BASE_URL`, and `META_MODEL` (Meta Vision credentials for live inspection).

```sh
npm install

# Terminal 1 - start the protocol server
node server.mjs
# Bazaar Registry listening on http://127.0.0.1:3000

# Terminal 2 - unleash the swarm (needs the server running)
node swarm.mjs
# Autonomous buyers open sessions, sellers deliver, scammers get slashed
```

Then open **http://127.0.0.1:3000** in a browser and watch the Live SSE Feed: honest trades settle in real time while scam deliveries get rejected and slashed, all pushed instantly with zero polling.

Verify the protocol any time with the automated suite:

```sh
npm test   # 70/70 passing (node:test, no framework)
```

## Project Structure

```
server.mjs              HTTP API + SSE stream + static serving (stdlib http, no framework)
src/agent-store.js      Registry: validation, hex seals, profiles, stake balances
src/session-manager.js  Protocol core: sessions, referee, escrow transitions (frozen)
src/ledger.js           Wallets: lock / release / refund / slash, all atomic (frozen)
src/inspector.js        Meta Vision client: YES/NO verdicts, fail-frozen (frozen)
src/db.js               SQLite schema, safe backfill migrations, session TTL
public/index.html       Dark-mode dashboard: Trust Cards + Live SSE Feed
swarm.mjs               Autonomous trading loop: honest sellers and scammers
test/*.test.mjs         Automated suite: registry, sessions, delivery, ledger,
                        inspector, static serving, SSE stream
```

## Out of scope

Real money, crypto, on-chain settlement. Artistic-quality judging (the Inspector checks brief-match only). More than the five listed capabilities (`image_gen`, `video_gen`, `text_gen`, `doc_gen`, `report_gen`).
