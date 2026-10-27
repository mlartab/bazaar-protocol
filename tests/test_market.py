import os
import time
import unittest

os.environ["BAZAAR_OFFLINE"] = "1"  # deterministic: no network in tests

from src.agents.seller import SELLER_PROFILES  # noqa: E402
from src.brief import Brief  # noqa: E402
from src.events import EventBus  # noqa: E402
from src.ledger import Ledger  # noqa: E402
from src.market import BUYER, Market  # noqa: E402
from src.reputation import Reputation  # noqa: E402


def make_brief(**kw):
    args = {"product": "Test Tonic", "market": "US",
            "required_objects": ("bottle", "cap"), "budget": 200,
            "deadline": time.time() + 600}
    args.update(kw)
    return Brief(**args)


def make_market(vision=None):
    bus = EventBus()
    ledger = Ledger({BUYER: 1000, **{s: 0 for s in SELLER_PROFILES}})
    market = Market(ledger, Reputation(list(SELLER_PROFILES)), bus,
                    vision=vision)
    return market, bus, ledger


class ScriptedVision:
    """Fail the object check `fail_times` times, then pass."""

    def __init__(self, fail_times=0):
        self.fail_times = fail_times
        self.calls = 0

    def check_objects(self, image, required_objects, provenance):
        self.calls += 1
        if self.calls <= self.fail_times:
            return {"passed": False, "reason": "scripted: cap missing",
                    "simulated": True}
        return {"passed": True, "reason": "scripted: all visible",
                "simulated": True}

    def check_compliance(self, image, brief_dict, provenance):
        return {"passed": True, "reason": "scripted: compliant",
                "simulated": True}


def kinds(bus):
    return [e["type"] for e in bus.history()]


class MarketTest(unittest.TestCase):
    def test_deal_settles_offline(self):
        market, bus, ledger = make_market()
        result = market.run_deal(make_brief())
        self.assertFalse(result["walked"])
        self.assertTrue(result["passed"])
        self.assertLessEqual(result["price"], 200)
        self.assertTrue(ledger.check_invariant())
        self.assertEqual(ledger.balances[result["seller"]], result["price"])
        for expected in ("deal_opened", "offer", "accept", "escrow_locked",
                         "deliverable", "inspection", "settled", "reputation"):
            self.assertIn(expected, kinds(bus))

    def test_every_negotiation_move_has_a_reason(self):
        _, bus, _ = make_market()
        market = Market(Ledger({BUYER: 1000,
                                **{s: 0 for s in SELLER_PROFILES}}),
                        Reputation(list(SELLER_PROFILES)), bus)
        market.run_deal(make_brief())
        for event in bus.history():
            if event["type"] in ("offer", "counter", "accept", "walk"):
                reason = event["payload"].get("reason", "")
                self.assertGreaterEqual(len(reason.strip()), 8,
                                        f"{event['type']} lacks a reason")

    def test_one_retry_then_settle(self):
        market, bus, ledger = make_market(vision=ScriptedVision(fail_times=1))
        result = market.run_deal(make_brief())
        self.assertTrue(result["passed"])
        self.assertEqual(kinds(bus).count("deliverable"), 2)
        self.assertEqual(kinds(bus).count("retry"), 1)
        self.assertIn("settled", kinds(bus))
        self.assertTrue(ledger.check_invariant())

    def test_two_failures_refund(self):
        market, bus, ledger = make_market(vision=ScriptedVision(fail_times=9))
        result = market.run_deal(make_brief())
        self.assertFalse(result["passed"])
        self.assertEqual(kinds(bus).count("deliverable"), 2)  # exactly 1 retry
        self.assertEqual(kinds(bus).count("retry"), 1)
        self.assertIn("refunded", kinds(bus))
        self.assertNotIn("settled", kinds(bus))
        self.assertEqual(ledger.balances[BUYER], 1000)  # money back
        self.assertEqual(ledger.locks, {})
        self.assertTrue(ledger.check_invariant())

    def test_impossible_budget_walks_away(self):
        market, bus, ledger = make_market()
        result = market.run_deal(make_brief(budget=1))
        self.assertTrue(result["walked"])
        self.assertEqual(ledger.balances[BUYER], 1000)
        self.assertTrue(ledger.check_invariant())

    def test_reputation_reranks_after_deal(self):
        market, bus, _ = make_market()
        before = [r["seller"] for r in market.reputation.ranking()]
        result = market.run_deal(make_brief())
        after = market.reputation.ranking()
        self.assertEqual(after[0]["seller"], result["seller"])
        self.assertGreater(after[0]["score"], 0)
        self.assertEqual(len(after), len(before))


if __name__ == "__main__":
    unittest.main()
