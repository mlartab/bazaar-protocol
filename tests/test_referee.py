import time
import unittest

from src.brief import Brief
from src.referee import MAX_DELIVERABLE_BYTES, Move, Referee


def make_brief(**kw):
    args = {"product": "Test Tonic", "market": "US",
            "required_objects": ("bottle",), "budget": 100,
            "deadline": time.time() + 600}
    args.update(kw)
    return Brief(**args)


class RefereeTest(unittest.TestCase):
    def setUp(self):
        self.ref = Referee(make_brief())
        self.buyer = self.ref.register("buyer")
        self.s1 = self.ref.register("seller:one")
        self.sys = self.ref.register("system")
        self.insp = self.ref.register("inspector")

    def test_valid_offer_accepted(self):
        v = self.ref.validate(Move("seller:one", self.s1, "OFFER",
                                   {"price": 80, "reason": "a fair price"}))
        self.assertTrue(v.ok, v.reason)

    def test_bad_token_rejected(self):
        v = self.ref.validate(Move("seller:one", "wrong", "OFFER",
                                   {"price": 80, "reason": "a fair price"}))
        self.assertFalse(v.ok)

    def test_unknown_actor_rejected(self):
        v = self.ref.validate(Move("seller:ghost", "x", "OFFER",
                                   {"price": 80, "reason": "a fair price"}))
        self.assertFalse(v.ok)

    def test_menu_rejects_wrong_phase(self):
        self.ref.advance("ESCROWED")
        v = self.ref.validate(Move("seller:one", self.s1, "OFFER",
                                   {"price": 80, "reason": "too late now"}))
        self.assertFalse(v.ok)
        v = self.ref.validate(Move("buyer", self.buyer, "DELIVER",
                                   {"size": 10, "attempt": 1}))
        self.assertFalse(v.ok)  # buyer may not deliver

    def test_menu_rejects_unknown_phase_move(self):
        v = self.ref.validate(Move("buyer", self.buyer, "SETTLE", {}))
        self.assertFalse(v.ok)

    def test_accept_over_budget_rejected(self):
        v = self.ref.validate(Move("buyer", self.buyer, "ACCEPT",
                                   {"price": 101, "reason": "over budget!"}))
        self.assertFalse(v.ok)

    def test_accept_within_budget_accepted(self):
        v = self.ref.validate(Move("buyer", self.buyer, "ACCEPT",
                                   {"price": 100, "reason": "deal agreed"}))
        self.assertTrue(v.ok, v.reason)

    def test_price_must_be_integer(self):
        for bad in (10.5, True, "80", None):
            v = self.ref.validate(Move("seller:one", self.s1, "OFFER",
                                       {"price": bad, "reason": "reason here"}))
            self.assertFalse(v.ok, repr(bad))
        v = self.ref.validate(Move("seller:one", self.s1, "OFFER",
                                   {"price": 0, "reason": "free stuff?"}))
        self.assertFalse(v.ok)

    def test_reason_required(self):
        v = self.ref.validate(Move("seller:one", self.s1, "OFFER",
                                   {"price": 80}))
        self.assertFalse(v.ok)
        v = self.ref.validate(Move("seller:one", self.s1, "OFFER",
                                   {"price": 80, "reason": "short"}))
        self.assertFalse(v.ok)
        v = self.ref.validate(Move("buyer", self.buyer, "WALK", {}))
        self.assertFalse(v.ok)

    def test_deadline_enforced(self):
        late = self.ref.brief.deadline + 1
        v = self.ref.validate(Move("seller:one", self.s1, "OFFER",
                                   {"price": 80, "reason": "too late!!"}),
                              now=late)
        self.assertFalse(v.ok)

    def test_deliverable_size_limit(self):
        self.ref.advance("ESCROWED")
        v = self.ref.validate(Move("seller:one", self.s1, "DELIVER",
                                   {"size": MAX_DELIVERABLE_BYTES + 1,
                                    "attempt": 1}))
        self.assertFalse(v.ok)
        v = self.ref.validate(Move("seller:one", self.s1, "DELIVER",
                                   {"size": 1024, "attempt": 1}))
        self.assertTrue(v.ok, v.reason)

    def test_at_most_three_sellers(self):
        self.ref.register("seller:two")
        self.ref.register("seller:three")
        with self.assertRaises(ValueError):
            self.ref.register("seller:four")

    def test_terminal_phases_have_empty_menu(self):
        self.ref.advance("SETTLED")
        v = self.ref.validate(Move("buyer", self.buyer, "WALK",
                                   {"reason": "nothing left"}))
        self.assertFalse(v.ok)


if __name__ == "__main__":
    unittest.main()
