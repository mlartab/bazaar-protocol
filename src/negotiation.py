"""Negotiation: OFFER / ACCEPT / WALK with a model-written reason each.

This module keeps the negotiation record. The reasons themselves are written
by the agents in src/agents/ (buyer.py, seller.py); the referee checks that
every move carries one. Plain code, no model calls.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Offer:
    seller: str
    price: int
    reason: str
    round: int


@dataclass
class Negotiation:
    brief_id: str
    budget: int
    offers: list[Offer] = field(default_factory=list)
    walks: list[dict] = field(default_factory=list)
    outcome: dict | None = None  # {"seller", "price", "reason"} or {"walked": True, ...}

    def record_offer(self, seller: str, price: int, reason: str, round: int) -> None:
        if self.outcome is not None:
            raise ValueError("negotiation already closed")
        self.offers.append(Offer(seller=seller, price=price, reason=reason, round=round))

    def record_walk(self, actor: str, reason: str) -> None:
        self.walks.append({"actor": actor, "reason": reason})

    def best_affordable(self) -> Offer | None:
        affordable = [o for o in self.offers if o.price <= self.budget]
        if not affordable:
            return None
        return min(affordable, key=lambda o: (o.price, o.round))

    def cheapest(self) -> Offer | None:
        if not self.offers:
            return None
        return min(self.offers, key=lambda o: (o.price, o.round))

    def accept(self, seller: str, price: int, reason: str) -> dict:
        if self.outcome is not None:
            raise ValueError("negotiation already closed")
        self.outcome = {"seller": seller, "price": price, "reason": reason}
        return self.outcome

    def walk_away(self, reason: str) -> dict:
        if self.outcome is not None:
            raise ValueError("negotiation already closed")
        self.outcome = {"walked": True, "reason": reason}
        return self.outcome

    @property
    def closed(self) -> bool:
        return self.outcome is not None

    def to_dict(self) -> dict:
        return {
            "brief_id": self.brief_id,
            "budget": self.budget,
            "offers": [o.__dict__ for o in self.offers],
            "walks": list(self.walks),
            "outcome": self.outcome,
        }
