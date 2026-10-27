"""Referee: validates every move before it touches the market.

Four checks on each move, in order: token, menu, limits, schema.
Plain code, no model calls.
"""
from __future__ import annotations

import secrets
import time
from dataclasses import dataclass, field

MAX_SELLERS = 3
MAX_DELIVERABLE_BYTES = 5 * 1024 * 1024
MIN_REASON_CHARS = 8

# Legal moves per deal phase.
MENU = {
    "NEGOTIATION": frozenset({"OFFER", "ACCEPT", "WALK"}),
    "ESCROWED": frozenset({"DELIVER"}),
    "DELIVERED": frozenset({"INSPECT"}),
    "INSPECTED": frozenset({"SETTLE", "RETRY", "REFUND"}),
    "SETTLED": frozenset(),
    "REFUNDED": frozenset(),
}

# Who may play each move.
ACTORS = {
    "OFFER": frozenset({"buyer", "seller"}),
    "ACCEPT": frozenset({"buyer", "seller"}),
    "WALK": frozenset({"buyer", "seller"}),
    "DELIVER": frozenset({"seller"}),
    "INSPECT": frozenset({"inspector"}),
    "SETTLE": frozenset({"system"}),
    "RETRY": frozenset({"system"}),
    "REFUND": frozenset({"system"}),
}


@dataclass(frozen=True)
class Move:
    actor: str       # "buyer", "seller:<id>", "inspector", "system"
    token: str
    kind: str        # OFFER / ACCEPT / WALK / ...
    payload: dict = field(default_factory=dict)


@dataclass(frozen=True)
class Verdict:
    ok: bool
    reason: str


class Referee:
    def __init__(self, brief) -> None:
        from .brief import Brief  # local import: keep module import-light
        assert isinstance(brief, Brief)
        self.brief = brief
        self.phase = "NEGOTIATION"
        self._tokens: dict[str, str] = {}
        self._sellers: list[str] = []
        self._log: list[dict] = []

    # -- setup -----------------------------------------------------------
    def register(self, actor: str) -> str:
        """Issue a token for an actor. At most three sellers, ever."""
        role = actor.split(":", 1)[0]
        if role == "seller":
            if actor not in self._sellers:
                if len(self._sellers) >= MAX_SELLERS:
                    raise ValueError(f"at most {MAX_SELLERS} sellers allowed")
                self._sellers.append(actor)
        token = secrets.token_hex(16)
        self._tokens[actor] = token
        return token

    @property
    def sellers(self) -> list[str]:
        return list(self._sellers)

    # -- validation ------------------------------------------------------
    def validate(self, move: Move, now: float | None = None) -> Verdict:
        now = time.time() if now is None else now

        # 1. token: the move must carry the actor's current token.
        expected = self._tokens.get(move.actor)
        if expected is None:
            return self._reject(move, f"unknown actor {move.actor!r}")
        if not move.token or not secrets.compare_digest(move.token, expected):
            return self._reject(move, "bad token")

        # 2. menu: the move must be legal in the current phase, for this role.
        role = move.actor.split(":", 1)[0]
        if move.kind not in MENU[self.phase]:
            return self._reject(move, f"{move.kind} is not on the menu in {self.phase}")
        if role not in ACTORS.get(move.kind, frozenset()):
            return self._reject(move, f"{role} may not play {move.kind}")

        # 3. limits: budget, deadline, seller count, deliverable size.
        if now > self.brief.deadline:
            return self._reject(move, "brief deadline has passed")
        if move.kind in ("OFFER", "ACCEPT"):
            price = move.payload.get("price")
            if isinstance(price, bool) or not isinstance(price, int):
                return self._reject(move, "price must be integer credits")
            if price <= 0:
                return self._reject(move, "price must be positive")
            if move.kind == "ACCEPT" and price > self.brief.budget:
                return self._reject(move, "accepted price exceeds budget")
        if move.kind == "DELIVER":
            size = move.payload.get("size")
            if not isinstance(size, int) or size <= 0:
                return self._reject(move, "deliverable size must be a positive int")
            if size > MAX_DELIVERABLE_BYTES:
                return self._reject(move, "deliverable exceeds size limit")

        # 4. schema: negotiation moves carry a model-written reason.
        if move.kind in ("OFFER", "ACCEPT", "WALK"):
            reason = move.payload.get("reason")
            if not isinstance(reason, str) or len(reason.strip()) < MIN_REASON_CHARS:
                return self._reject(move, "negotiation moves need a written reason")
            if move.kind == "OFFER" and "price" not in move.payload:
                return self._reject(move, "OFFER needs a price")
            if move.kind == "ACCEPT" and "price" not in move.payload:
                return self._reject(move, "ACCEPT needs a price")
        if move.kind == "DELIVER" and "attempt" not in move.payload:
            return self._reject(move, "DELIVER needs an attempt number")

        return self._accept(move)

    def advance(self, phase: str) -> None:
        if phase not in MENU:
            raise ValueError(f"unknown phase {phase!r}")
        self.phase = phase

    def _accept(self, move: Move) -> Verdict:
        self._log.append({"move": move.kind, "actor": move.actor, "ok": True})
        return Verdict(True, "valid move")

    def _reject(self, move: Move, reason: str) -> Verdict:
        self._log.append({"move": move.kind, "actor": move.actor, "ok": False,
                          "reason": reason})
        return Verdict(False, reason)

    @property
    def log(self) -> list[dict]:
        return list(self._log)
