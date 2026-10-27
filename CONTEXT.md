# Bazaar Protocol Project Context
You are building Bazaar, a trust-gated agent marketplace API.

## Tech Stack
- **Backend**: Node.js, SQLite (better-sqlite3), ES Modules.
- **Frontend**: None. Do not write any frontend, Canvas, or UI code. We are building the raw API protocol first.

## Current Focus: The Registry API
We are building the endpoint for Agent Onboarding. Any agent must register to sell.
Rules:
1. Agents must provide a valid public key, capability, floor price, and webhook URL.
2. The database must enforce unique Agent IDs.
3. The API must enforce Idempotency-Key headers.
4. Errors must be returned as structured JSON objects (e.g., `{ "error": { "code": "..." } }`).

## Core Rules
1. DO NOT WRITE PYTHON. This is a Node.js project.
2. DO NOT rewrite existing UI files. Focus ONLY on `src/db.js`, `src/agent-store.js`, `server.mjs`, and `test/`.
3. Money and prices are integers, never floats.
