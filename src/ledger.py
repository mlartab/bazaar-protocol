"""Ledger: integer simulated credits with escrow lock and settlement.

Invariant: sum(balances) + sum(locks) == reserve, always.
Plain code, no model calls.
"""
from __future__ import annotations

from dataclasses import dataclass


class LedgerError(ValueError):
    pass


def _require_credits(value: int, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise LedgerError(f"{what} must be an integer number of credits")
    if value <= 0:
        raise LedgerError(f"{what} must be positive")
    return value


@dataclass
class Lock:
    lock_id: str
    owner: str
    amount: int
    ref: str


class Ledger:
    def __init__(self, balances: dict[str, int]) -> None:
        if not balances:
            raise LedgerError("ledger needs at least one account")
        for name, bal in balances.items():
            if isinstance(bal, bool) or not isinstance(bal, int):
                raise LedgerError(f"balance of {name!r} must be integer credits")
            if bal < 0:
                raise LedgerError(f"balance of {name!r} must not be negative")
        self._balances = dict(balances)
        self._locks: dict[str, Lock] = {}
        self._reserve = sum(self._balances.values())
        self._counter = 0

    @property
    def reserve(self) -> int:
        return self._reserve

    @property
    def balances(self) -> dict[str, int]:
        return dict(self._balances)

    @property
    def locks(self) -> dict[str, Lock]:
        return dict(self._locks)

    def locked_total(self) -> int:
        return sum(lock.amount for lock in self._locks.values())

    def check_invariant(self) -> bool:
        return sum(self._balances.values()) + self.locked_total() == self._reserve

    def _assert_invariant(self) -> None:
        if not self.check_invariant():
            raise LedgerError("reserve invariant violated: balances + locks != reserve")

    def lock(self, owner: str, amount: int, ref: str) -> str:
        """Escrow: move credits from owner's balance into a lock. No money moves
        to any seller until the Inspector confirms the creative."""
        _require_credits(amount, "lock amount")
        if owner not in self._balances:
            raise LedgerError(f"unknown account {owner!r}")
        if self._balances[owner] < amount:
            raise LedgerError(f"insufficient balance for {owner!r}")
        self._counter += 1
        lock_id = f"lock-{self._counter}"
        self._balances[owner] -= amount
        self._locks[lock_id] = Lock(lock_id=lock_id, owner=owner, amount=amount, ref=ref)
        self._assert_invariant()
        return lock_id

    def settle(self, lock_id: str, to_account: str) -> int:
        """Release escrow to the seller after the Inspector passes the creative."""
        if lock_id not in self._locks:
            raise LedgerError(f"unknown lock {lock_id!r}")
        if to_account not in self._balances:
            raise LedgerError(f"unknown account {to_account!r}")
        lock = self._locks.pop(lock_id)
        self._balances[to_account] += lock.amount
        self._assert_invariant()
        return lock.amount

    def refund(self, lock_id: str) -> int:
        """Release escrow back to the owner (inspection failed twice, walk, expiry)."""
        if lock_id not in self._locks:
            raise LedgerError(f"unknown lock {lock_id!r}")
        lock = self._locks.pop(lock_id)
        self._balances[lock.owner] += lock.amount
        self._assert_invariant()
        return lock.amount

    def snapshot(self) -> dict:
        return {
            "reserve": self._reserve,
            "balances": dict(self._balances),
            "locks": {k: {"owner": v.owner, "amount": v.amount, "ref": v.ref}
                      for k, v in self._locks.items()},
            "invariant_holds": self.check_invariant(),
        }
