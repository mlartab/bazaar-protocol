"""Reputation: re-ranks sellers after each deal. Plain code."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class SellerRecord:
    seller_id: str
    score: float = 0.0
    deals: int = 0
    wins: int = 0
    passes: int = 0
    total_price: int = 0

    @property
    def avg_price(self) -> float | None:
        return self.total_price / self.wins if self.wins else None

    def to_dict(self) -> dict:
        return {"seller": self.seller_id, "score": round(self.score, 2),
                "deals": self.deals, "wins": self.wins, "passes": self.passes,
                "avg_price": self.avg_price}


class Reputation:
    """Win a deal and pass inspection: +2. Win then fail: -2. Lose: 0.
    Ranking is by score, ties broken by lower average winning price."""

    def __init__(self, seller_ids: list[str]) -> None:
        self._records: dict[str, SellerRecord] = {
            s: SellerRecord(s) for s in seller_ids}

    def record_deal(self, seller_ids: list[str], winner: str | None,
                    price: int | None, passed: bool) -> list[dict]:
        for sid in seller_ids:
            rec = self._records.setdefault(sid, SellerRecord(sid))
            rec.deals += 1
        if winner is not None and price is not None:
            rec = self._records[winner]
            rec.wins += 1
            rec.total_price += price
            if passed:
                rec.passes += 1
                rec.score += 2.0
            else:
                rec.score -= 2.0
        return self.ranking()

    def ranking(self) -> list[dict]:
        recs = sorted(self._records.values(),
                      key=lambda r: (-r.score, r.avg_price
                                     if r.avg_price is not None else float("inf"),
                                     r.seller_id))
        return [r.to_dict() for r in recs]
