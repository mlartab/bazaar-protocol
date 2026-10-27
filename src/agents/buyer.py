"""Buyer agent: negotiates on the brief's behalf.

Every negotiation move carries a model-written reason. Offline, reasons come
from deterministic stand-ins labelled simulated.
"""
from __future__ import annotations

from .base import ModelClient, ModelUnavailable

_SYSTEM = (
    "You are a buyer agent procuring an ad creative inside a sandboxed "
    "marketplace. Reply with a JSON object only. Keep every reason to one or "
    "two sentences, concrete and professional."
)


class BuyerAgent:
    def __init__(self, client: ModelClient | None = None) -> None:
        self.client = client or ModelClient()

    def _ask(self, user: str, fallback: dict) -> dict:
        try:
            out = self.client.complete_json(_SYSTEM, user)
            if isinstance(out, dict):
                out["simulated"] = False
                return out
        except ModelUnavailable:
            pass
        return fallback

    def counter_offer(self, product: str, budget: int, seller: str,
                      ask: int) -> dict:
        """Price over budget: propose a counter price with a reason."""
        target = min(budget, max(1, int(ask * 0.8)))
        user = (f"Brief: {product}. Budget: {budget} credits. Seller {seller} "
                f"asks {ask} credits. Propose a counter price at or under "
                f"budget. Reply {{\"price\": <int>, \"reason\": <str>}}.")
        return self._ask(user, {
            "price": target,
            "reason": (f"{seller}'s ask of {ask} exceeds my {budget}-credit "
                       f"budget; I counter {target} to keep the deal inside "
                       f"the brief."),
            "simulated": True,
        })

    def accept_reason(self, product: str, seller: str, price: int) -> dict:
        user = (f"Brief: {product}. You accept seller {seller}'s price of "
                f"{price} credits. Reply {{\"reason\": <str>}} giving the "
                f"reason in one sentence.")
        return self._ask(user, {
            "reason": (f"{seller} offers the best value inside budget at "
                       f"{price} credits for {product}."),
            "simulated": True,
        })

    def walk_reason(self, product: str, seller: str, price: int | None,
                    why: str) -> dict:
        user = (f"Brief: {product}. You walk away from seller {seller} "
                f"(price: {price}). Context: {why}. Reply {{\"reason\": "
                f"<str>}} with a courteous one-sentence reason.")
        suffix = f" ({price} credits)" if price is not None else ""
        return self._ask(user, {
            "reason": f"Walking away from {seller}: {why}{suffix}.",
            "simulated": True,
        })
