"""The creative brief. Plain data, no model calls."""
from __future__ import annotations

import time
from dataclasses import dataclass, field

REQUIRED_FORMAT = (1080, 1080)


@dataclass(frozen=True)
class Brief:
    """What the buyer wants: product, market, format, objects, budget, deadline."""

    product: str
    market: str
    required_objects: tuple[str, ...]
    budget: int  # integer simulated credits
    deadline: float  # unix timestamp; moves after this are rejected
    brief_id: str = "brief-1"
    width: int = REQUIRED_FORMAT[0]
    height: int = REQUIRED_FORMAT[1]

    def __post_init__(self) -> None:
        if not self.product or not isinstance(self.product, str):
            raise ValueError("brief needs a non-empty product name")
        if not self.market or not isinstance(self.market, str):
            raise ValueError("brief needs a non-empty market")
        if not self.required_objects:
            raise ValueError("brief needs at least one required object")
        if any(not o or not isinstance(o, str) for o in self.required_objects):
            raise ValueError("required objects must be non-empty strings")
        if isinstance(self.budget, bool) or not isinstance(self.budget, int):
            raise ValueError("budget must be an integer number of credits")
        if self.budget <= 0:
            raise ValueError("budget must be positive")
        if (self.width, self.height) != REQUIRED_FORMAT:
            raise ValueError(f"format must be {REQUIRED_FORMAT[0]}x{REQUIRED_FORMAT[1]}")
        if self.deadline <= time.time():
            raise ValueError("deadline must be in the future")

    def expired(self, now: float | None = None) -> bool:
        return (time.time() if now is None else now) > self.deadline

    def to_dict(self) -> dict:
        return {
            "brief_id": self.brief_id,
            "product": self.product,
            "market": self.market,
            "format": f"{self.width}x{self.height}",
            "required_objects": list(self.required_objects),
            "budget": self.budget,
            "deadline": self.deadline,
        }


def sample_briefs(now: float | None = None) -> list[Brief]:
    """Demo briefs. Deadlines are 30 minutes from creation."""
    base = (time.time() if now is None else now) + 30 * 60
    return [
        Brief(
            brief_id="brief-aurora",
            product="Aurora Cold Brew",
            market="US",
            required_objects=("coffee cup", "coffee beans"),
            budget=120,
            deadline=base,
        ),
        Brief(
            brief_id="brief-stride",
            product="Stride Running Shoes",
            market="UK",
            required_objects=("running shoe",),
            budget=90,
            deadline=base,
        ),
        Brief(
            brief_id="brief-lumen",
            product="Lumen Desk Lamp",
            market="DE",
            required_objects=("desk lamp", "book"),
            budget=100,
            deadline=base,
        ),
    ]
