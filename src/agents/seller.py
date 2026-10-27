"""Seller agents: price creatives and write the image prompt.

At most three sellers per deal (enforced by the referee). Each seller has a
style and a floor price; offers always carry a model-written reason.
"""
from __future__ import annotations

from .base import ModelClient, ModelUnavailable

_SYSTEM = (
    "You are a seller agent in a sandboxed ad-creative marketplace. Reply "
    "with a JSON object only. Keep every reason to one or two sentences."
)

SELLER_PROFILES = {
    "seller:atelier": {"style": "bold studio product shot, dramatic light",
                       "floor": 60},
    "seller:bazaar-works": {"style": "clean minimal catalog layout",
                            "floor": 45},
    "seller:kiln": {"style": "warm lifestyle scene, natural light",
                    "floor": 70},
}


class SellerAgent:
    def __init__(self, seller_id: str, client: ModelClient | None = None) -> None:
        if seller_id not in SELLER_PROFILES:
            raise ValueError(f"unknown seller {seller_id!r}")
        self.seller_id = seller_id
        self.profile = SELLER_PROFILES[seller_id]
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

    def offer(self, product: str, market: str, required_objects: list[str],
              budget: int, round: int) -> dict:
        floor = self.profile["floor"]
        style = self.profile["style"]
        if round == 1:
            ask = min(budget + 20, floor + 45)
        else:  # round 2: sharpen the price to stay in the running
            ask = min(budget, floor + 25)
        user = (f"Brief: {product} for {market}; must show "
                f"{', '.join(required_objects)}; buyer budget {budget}. Your "
                f"style: {style}. Your floor price is {floor}. Make an offer "
                f"for round {round}. Reply {{\"price\": <int>, "
                f"\"reason\": <str>}}.")
        out = self._ask(user, {
            "price": ask,
            "reason": (f"Offering {product} in my {style} style for {ask} "
                       f"credits, covering the required objects."),
            "simulated": True,
        })
        price = out.get("price")
        if not isinstance(price, int) or isinstance(price, bool) or price < floor:
            out["price"] = max(floor, ask if isinstance(ask, int) else floor)
        return out

    def respond_to_counter(self, product: str, counter_price: int) -> dict:
        floor = self.profile["floor"]
        accept = counter_price >= floor
        user = (f"Brief: {product}. The buyer counters {counter_price}; your "
                f"floor is {floor}. Reply {{\"accept\": <bool>, "
                f"\"reason\": <str>}}.")
        fallback = {
            "accept": accept,
            "reason": (f"Accepting {counter_price} for {product}: it clears "
                       f"my floor."
                       if accept else
                       f"Declining {counter_price} for {product}: below my "
                       f"{floor}-credit floor, so I walk."),
            "simulated": True,
        }
        out = self._ask(user, fallback)
        if not isinstance(out.get("accept"), bool):
            out["accept"] = accept
        return out

    def creative_prompt(self, product: str, market: str,
                        required_objects: list[str], fix_note: str = "") -> str:
        style = self.profile["style"]
        prompt = (f"Square 1080x1080 ad creative for {product}, {market} "
                  f"market, {style}, clearly showing "
                  f"{', '.join(required_objects)}.")
        if fix_note:
            prompt += f" Fix from inspection feedback: {fix_note}"
        return prompt

    def walk_reason(self, product: str, why: str) -> dict:
        user = (f"Brief: {product}. You walk away. Context: {why}. Reply "
                f"{{\"reason\": <str>}} with a courteous one-sentence reason.")
        return self._ask(user, {
            "reason": f"Walking away from {product}: {why}.",
            "simulated": True,
        })
