"""Bazaar demo: run deals in the terminal and print the transcript."""
from __future__ import annotations

import argparse
import os

from .agents.seller import SELLER_PROFILES
from .brief import sample_briefs
from .events import EventBus
from .ledger import Ledger
from .market import BUYER, Market
from .reputation import Reputation


def main() -> None:
    parser = argparse.ArgumentParser(description="Run Bazaar deals in the terminal")
    parser.add_argument("--deals", type=int, default=2)
    parser.add_argument("--offline", action="store_true",
                        help="skip live model calls, use standby adapters")
    args = parser.parse_args()
    if args.offline:
        os.environ["BAZAAR_OFFLINE"] = "1"

    bus = EventBus()
    ledger = Ledger({BUYER: 1000, **{s: 0 for s in SELLER_PROFILES}})
    market = Market(ledger, Reputation(list(SELLER_PROFILES)), bus)
    briefs = sample_briefs()
    for i in range(max(1, args.deals)):
        result = market.run_deal(briefs[i % len(briefs)])
        print(f"--- {result['deal_id']}: {result}")

    print("\nLedger:", ledger.snapshot())
    print("Ranking:", market.reputation.ranking())
    print(f"\nTranscript ({bus.count} events):")
    for event in bus.history():
        kind = event["type"]
        payload = {k: v for k, v in event["payload"].items() if k != "image"}
        if "image" in event["payload"]:
            payload["image"] = f"<{len(event['payload']['image'])} chars of data URL>"
        print(f"  #{event['seq']} {kind}: {payload}")


if __name__ == "__main__":
    main()
