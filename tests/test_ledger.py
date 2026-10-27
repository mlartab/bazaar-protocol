import unittest

from src.ledger import Ledger, LedgerError


class LedgerTest(unittest.TestCase):
    def setUp(self):
        self.ledger = Ledger({"buyer": 1000, "seller:a": 0})

    def test_lock_settle_keeps_reserve(self):
        lock = self.ledger.lock("buyer", 120, ref="deal-1")
        self.assertEqual(self.ledger.balances["buyer"], 880)
        self.ledger.settle(lock, "seller:a")
        self.assertEqual(self.ledger.balances["seller:a"], 120)
        self.assertTrue(self.ledger.check_invariant())

    def test_refund_restores_owner(self):
        lock = self.ledger.lock("buyer", 50, ref="deal-1")
        self.ledger.refund(lock)
        self.assertEqual(self.ledger.balances["buyer"], 1000)
        self.assertEqual(self.ledger.locks, {})
        self.assertTrue(self.ledger.check_invariant())

    def test_rejects_non_integer_credits(self):
        for bad in (10.5, True, False, "10", None):
            with self.assertRaises(LedgerError, msg=repr(bad)):
                self.ledger.lock("buyer", bad, ref="x")

    def test_rejects_non_positive(self):
        for bad in (0, -5):
            with self.assertRaises(LedgerError, msg=repr(bad)):
                self.ledger.lock("buyer", bad, ref="x")

    def test_rejects_overdraw(self):
        with self.assertRaises(LedgerError):
            self.ledger.lock("buyer", 1001, ref="x")

    def test_rejects_unknown_accounts_and_locks(self):
        with self.assertRaises(LedgerError):
            self.ledger.lock("ghost", 10, ref="x")
        lock = self.ledger.lock("buyer", 10, ref="x")
        with self.assertRaises(LedgerError):
            self.ledger.settle(lock, "ghost")
        with self.assertRaises(LedgerError):
            self.ledger.settle("lock-999", "seller:a")
        with self.assertRaises(LedgerError):
            self.ledger.refund("lock-999")
        self.ledger.settle(lock, "seller:a")
        with self.assertRaises(LedgerError):  # no double spend
            self.ledger.settle(lock, "seller:a")

    def test_constructor_validates(self):
        with self.assertRaises(LedgerError):
            Ledger({})
        with self.assertRaises(LedgerError):
            Ledger({"a": 1.5})
        with self.assertRaises(LedgerError):
            Ledger({"a": True})
        with self.assertRaises(LedgerError):
            Ledger({"a": -1})


if __name__ == "__main__":
    unittest.main()
