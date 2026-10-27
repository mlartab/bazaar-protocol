"""Market: runs a full deal from brief to settlement.

brief -> negotiate (OFFER/ACCEPT/WALK) -> escrow lock -> deliver -> inspect
-> one retry at most -> settle or refund -> re-rank sellers.

Every state-changing step goes through the referee first, and every ledger
step re-checks balances + locks == reserve. Plain code; the agents it calls
live in src/agents/.
"""
from __future__ import annotations

import base64

from .agents.base import ModelClient
from .agents.buyer import BuyerAgent
from .agents.images import ImageAgent
from .agents.seller import SELLER_PROFILES, SellerAgent
from .agents.vision import VisionAgent
from .brief import Brief
from .events import EventBus
from .inspector import Inspector
from .ledger import Ledger
from .negotiation import Negotiation
from .referee import Move, Referee

BUYER = "buyer"


class Market:
    def __init__(self, ledger: Ledger, reputation, bus: EventBus | None = None,
                 client: ModelClient | None = None,
                 vision=None, images: ImageAgent | None = None,
                 seed: int = 0) -> None:
        self.ledger = ledger
        self.reputation = reputation
        self.bus = bus or EventBus()
        client = client or ModelClient()
        self.buyer = BuyerAgent(client)
        self.sellers = {sid: SellerAgent(sid, client) for sid in SELLER_PROFILES}
        self.images = images or ImageAgent(client)
        self.inspector = Inspector(vision or VisionAgent(client))
        self.seed = seed
        self.deals_run = 0

    def run_deal(self, brief: Brief) -> dict:
        self.deals_run += 1
        deal_id = f"deal-{self.deals_run}"
        self.bus.emit("deal_opened", {"deal_id": deal_id, "brief": brief.to_dict()})

        referee = Referee(brief)
        tokens = {BUYER: referee.register(BUYER),
                  "inspector": referee.register("inspector"),
                  "system": referee.register("system")}
        # Sellers enter in reputation order (best first), at most three.
        ranked = [r["seller"] for r in self.reputation.ranking()]
        seller_ids = [s for s in ranked if s in self.sellers][:3]
        for sid in seller_ids:
            tokens[sid] = referee.register(sid)
        self.bus.emit("sellers_ranked",
                      {"deal_id": deal_id, "ranking": self.reputation.ranking()})

        neg = Negotiation(brief_id=brief.brief_id, budget=brief.budget)
        outcome = self._negotiate(referee, tokens, neg, brief, seller_ids, deal_id)
        if outcome is None or outcome.get("walked"):
            reason = (outcome or {}).get("reason", "no agreement")
            self.bus.emit("deal_walked", {"deal_id": deal_id, "reason": reason})
            ranking = self.reputation.record_deal(seller_ids, None, None, False)
            self.bus.emit("reputation", {"deal_id": deal_id, "ranking": ranking})
            return {"deal_id": deal_id, "walked": True, "reason": reason}

        seller_id = outcome["seller"]
        price = outcome["price"]

        # Escrow: lock the buyer's credits. Nothing moves until inspection passes.
        referee.advance("ESCROWED")
        lock_id = self.ledger.lock(BUYER, price, ref=deal_id)
        self.bus.emit("escrow_locked",
                      {"deal_id": deal_id, "lock_id": lock_id, "amount": price,
                       "ledger": self.ledger.snapshot()})

        # Deliver + inspect, with exactly one retry after a rejection.
        fix_note = ""
        result = None
        image_bytes = b""
        provenance: dict = {}
        for attempt in (1, 2):
            prompt = self.sellers[seller_id].creative_prompt(
                brief.product, brief.market, list(brief.required_objects),
                fix_note=fix_note)
            image_bytes, provenance = self.images.generate(
                prompt, brief.product, list(brief.required_objects),
                seed=self.seed + self.deals_run * 10 + attempt)
            move = self._play(referee, tokens, Move(
                seller_id, tokens[seller_id], "DELIVER",
                {"size": len(image_bytes), "attempt": attempt}))
            assert move.ok, move.reason
            referee.advance("DELIVERED")
            self.bus.emit("deliverable",
                          {"deal_id": deal_id, "attempt": attempt,
                           "size": len(image_bytes),
                           "image": ("data:image/png;base64,"
                                     + base64.b64encode(image_bytes).decode("ascii")),
                           "provenance": provenance.get("source"),
                           "simulated": bool(provenance.get("simulated"))})
            inspect_move = self._play(referee, tokens, Move(
                "inspector", tokens["inspector"], "INSPECT", {}))
            assert inspect_move.ok, inspect_move.reason
            result = self.inspector.inspect(image_bytes, brief, provenance)
            referee.advance("INSPECTED")
            self.bus.emit("inspection",
                          {"deal_id": deal_id, "attempt": attempt,
                           "verdict": result.to_dict()})
            if result.passed:
                break
            if attempt == 1:
                retry = self._play(referee, tokens, Move(
                    "system", tokens["system"], "RETRY", {}))
                assert retry.ok, retry.reason
                fix_note = "; ".join(c.reason for c in result.checks
                                     if not c.passed)
                self.bus.emit("retry",
                              {"deal_id": deal_id, "feedback": fix_note})
                referee.advance("ESCROWED")

        assert result is not None
        if result.passed:
            settle = self._play(referee, tokens, Move(
                "system", tokens["system"], "SETTLE", {}))
            assert settle.ok, settle.reason
            self.ledger.settle(lock_id, seller_id)
            referee.advance("SETTLED")
            self.bus.emit("settled",
                          {"deal_id": deal_id, "seller": seller_id,
                           "price": price, "ledger": self.ledger.snapshot()})
            ranking = self.reputation.record_deal(seller_ids, seller_id, price, True)
            self.bus.emit("reputation", {"deal_id": deal_id, "ranking": ranking})
            return {"deal_id": deal_id, "walked": False, "seller": seller_id,
                    "price": price, "passed": True}
        refund = self._play(referee, tokens, Move(
            "system", tokens["system"], "REFUND", {}))
        assert refund.ok, refund.reason
        self.ledger.refund(lock_id)
        referee.advance("REFUNDED")
        self.bus.emit("refunded",
                      {"deal_id": deal_id, "reason": "inspection failed twice",
                       "ledger": self.ledger.snapshot()})
        ranking = self.reputation.record_deal(seller_ids, seller_id, price, False)
        self.bus.emit("reputation", {"deal_id": deal_id, "ranking": ranking})
        return {"deal_id": deal_id, "walked": False, "seller": seller_id,
                "price": price, "passed": False}

    # -- negotiation -----------------------------------------------------
    def _negotiate(self, referee, tokens, neg, brief, seller_ids,
                   deal_id) -> dict | None:
        for round_no in (1, 2):
            walked = {w["actor"] for w in neg.walks}
            for sid in seller_ids:
                if neg.closed:
                    break
                if sid in walked:
                    continue
                offer = self.sellers[sid].offer(
                    brief.product, brief.market,
                    list(brief.required_objects), brief.budget, round=round_no)
                verdict = self._play(referee, tokens, Move(
                    sid, tokens[sid], "OFFER",
                    {"price": offer["price"], "reason": offer["reason"]}))
                if not verdict.ok:
                    continue
                neg.record_offer(sid, offer["price"], offer["reason"], round_no)
                self.bus.emit("offer",
                              {"deal_id": deal_id, "round": round_no,
                               "seller": sid, "price": offer["price"],
                               "reason": offer["reason"],
                               "simulated": bool(offer.get("simulated"))})
            best = neg.best_affordable()
            if best is not None:
                return self._accept_best(referee, tokens, neg, brief, best,
                                         seller_ids, deal_id)
            if round_no == 1:
                countered = self._counter_cheapest(referee, tokens, neg, brief,
                                                   deal_id)
                if countered is not None:
                    return countered
        reason = self.buyer.walk_reason(
            brief.product, "all sellers", None,
            "no seller met the budget after two rounds").get("reason", "")
        self._play(referee, tokens, Move(
            BUYER, tokens[BUYER], "WALK", {"reason": reason}))
        return neg.walk_away(reason)

    def _accept_best(self, referee, tokens, neg, brief, best,
                     seller_ids, deal_id) -> dict:
        accept = self.buyer.accept_reason(brief.product, best.seller, best.price)
        verdict = self._play(referee, tokens, Move(
            BUYER, tokens[BUYER], "ACCEPT",
            {"price": best.price, "reason": accept["reason"]}))
        assert verdict.ok, verdict.reason
        self.bus.emit("accept",
                      {"deal_id": deal_id, "seller": best.seller,
                       "price": best.price, "reason": accept["reason"],
                       "simulated": bool(accept.get("simulated"))})
        for sid in seller_ids:
            if sid == best.seller:
                continue
            walk = self.buyer.walk_reason(
                brief.product, sid, None,
                f"accepted {best.seller} at {best.price}")
            self._play(referee, tokens, Move(
                BUYER, tokens[BUYER], "WALK", {"reason": walk["reason"]}))
            neg.record_walk(BUYER, walk["reason"])
            self.bus.emit("walk", {"deal_id": deal_id, "actor": BUYER,
                                   "seller": sid, "reason": walk["reason"],
                                   "simulated": bool(walk.get("simulated"))})
        return neg.accept(best.seller, best.price, accept["reason"])

    def _counter_cheapest(self, referee, tokens, neg, brief,
                          deal_id) -> dict | None:
        cheapest = neg.cheapest()
        if cheapest is None:
            return None
        counter = self.buyer.counter_offer(brief.product, brief.budget,
                                           cheapest.seller, cheapest.price)
        price = counter.get("price")
        if not isinstance(price, int) or isinstance(price, bool):
            price = brief.budget
        counter["price"] = max(1, min(brief.budget, price))
        verdict = self._play(referee, tokens, Move(
            BUYER, tokens[BUYER], "OFFER",
            {"price": counter["price"], "reason": counter["reason"]}))
        if not verdict.ok:
            return None
        self.bus.emit("counter",
                      {"deal_id": deal_id, "seller": cheapest.seller,
                       "price": counter["price"], "reason": counter["reason"],
                       "simulated": bool(counter.get("simulated"))})
        resp = self.sellers[cheapest.seller].respond_to_counter(
            brief.product, counter["price"])
        if resp.get("accept"):
            verdict = self._play(referee, tokens, Move(
                cheapest.seller, tokens[cheapest.seller], "ACCEPT",
                {"price": counter["price"], "reason": resp["reason"]}))
            if not verdict.ok:
                return None
            self.bus.emit("accept",
                          {"deal_id": deal_id, "seller": cheapest.seller,
                           "price": counter["price"], "reason": resp["reason"],
                           "simulated": bool(resp.get("simulated"))})
            return neg.accept(cheapest.seller, counter["price"], resp["reason"])
        self._play(referee, tokens, Move(
            cheapest.seller, tokens[cheapest.seller], "WALK",
            {"reason": resp["reason"]}))
        neg.record_walk(cheapest.seller, resp["reason"])
        self.bus.emit("walk", {"deal_id": deal_id, "actor": cheapest.seller,
                               "reason": resp["reason"],
                               "simulated": bool(resp.get("simulated"))})
        return None

    @staticmethod
    def _play(referee: Referee, tokens: dict, move: Move):
        verdict = referee.validate(move)
        if not verdict.ok:
            raise RuntimeError(f"referee rejected {move.kind} "
                               f"from {move.actor}: {verdict.reason}")
        return verdict
