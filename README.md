# Bazaar

A sandboxed marketplace where AI buyer and seller agents negotiate, verify delivery, and settle inside rules the sandbox enforces.

Bazaar is a trust layer for creative procurement in ad automation: an
ad-automation buyer agent buys creatives from seller agents, and no money
moves until an Inspector confirms the creative matches the brief.

## Run it

Stdlib-only Python 3.12 — no installs, no virtualenv needed.

```sh
# Live market + viewer (tries live models, falls back to honest standbys)
python3 -m src.server --port 8000
# open http://127.0.0.1:8000 in a browser

# Fully offline run (deterministic standbys, labelled "standby" in the UI)
python3 -m src.server --port 8000 --offline

# Terminal demo: run deals and print the transcript
python3 -m src.demo --deals 2 --offline

# Tests
python3 -m unittest discover -s tests
```

## How a deal works

1. **Brief** — product, market, 1080x1080 format, required objects, integer
   budget, deadline (`src/brief.py`).
2. **Negotiation** — up to three sellers make `OFFER`s; the buyer `ACCEPT`s,
   counters, or `WALK`s. Every move carries a model-written reason, checked
   by the referee (`src/negotiation.py`, `src/agents/buyer.py`,
   `src/agents/seller.py`).
3. **Escrow** — the price locks in integer simulated credits. The ledger
   invariant `balances + locks = reserve` is re-checked on every move and
   shown live in the UI (`src/ledger.py`).
4. **Deliverable** — the winning seller produces Muse Image output
   (`src/agents/images.py`).
5. **Inspection** — format and hash run as plain code; object presence runs
   through SAM 3.1; compliance runs through Muse Spark vision as yes/no with
   a reason. Artistic quality is never judged (`src/inspector.py`,
   `src/agents/vision.py`).
6. **One retry** — a rejected creative gets exactly one regeneration with
   the inspection feedback, then the escrow refunds.
7. **Settlement + reputation** — passed deals settle to the seller; sellers
   re-rank after every deal (`src/reputation.py`).
8. **Live viewer** — `public/viewer.html` reads the `GET /events`
   server-sent event stream only. No fetch, no polling (enforced by test).

The **referee** (`src/referee.py`) validates every move on four checks in
order: token, menu (legal moves for the phase), limits (budget, deadline,
three-seller cap, deliverable size), schema (negotiation moves need a
written reason).

## Model calls live only in `src/agents/`

`tests/test_agents_isolation.py` fails the build if any file outside
`src/agents/` touches the network or model credentials. Everything else is
plain code.

Live calls go to `META_BASE_URL` (`.env`: `MODEL_API_KEY`, `META_MODEL`).
When the API is unreachable, each adapter falls back to a deterministic
standby and labels its output `simulated` end to end, so the UI always says
which path produced a reason, image, or verdict. `BAZAAR_OFFLINE=1` forces
standby mode. A circuit breaker keeps live mode fast after the first
failed call.

SAM 3.1: `src/agents/vision.py::sam_segment_count` uses the `sam3` package
when installed and reports its mask count as inspection evidence;
otherwise the standby label is shown.

## Out of scope

Real money, crypto, on-chain settlement · Meta Ads Manager integration ·
judging artistic quality · more than three sellers.
