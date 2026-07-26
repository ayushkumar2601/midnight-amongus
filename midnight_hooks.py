# [MIDNIGHT] Bridge client. Python 3.11. Dependency: requests.
#
# Fire-and-forget client for the midnight-bridge (Shadow Protocol spec 10.2).
# All gameplay hooks are non-blocking: a single daemon worker thread drains a
# queue.Queue; HTTP timeout 5 s; failures log a console warning and NEVER raise
# into the pygame loop.
#
# The one exception is deal(): the match must not start unanchored, so the deal
# blocks its caller.  Because this repo has no lobby screen (clients join a
# live world), game.py calls deal_async() instead, which runs deal() on a
# background thread and applies the role via callback once the seed +
# commitments are confirmed on-chain.  Until then nobody is the saboteur, so
# the match is effectively "not started" -- same guarantee, no frozen frames.

from __future__ import annotations
import os
import queue
import threading
import logging
from typing import Optional, List, Tuple, Dict, Any, Union

import requests

log = logging.getLogger("midnight")
logging.basicConfig(level=logging.INFO, format="[midnight] %(levelname)s %(message)s")

BRIDGE = os.environ.get("MN_BRIDGE_URL", "http://127.0.0.1:8088")

# How many connected players trigger the on-chain deal. 5 = spec-locked match
# size (1 Saboteur + 4 Agents). Set SHADOW_PLAYERS=2/3 for dev testing with
# fewer windows (the bridge must be started with the same MN_REQUIRED_PLAYERS).
PLAYERS_PER_MATCH = int(os.environ.get("SHADOW_PLAYERS", "5"))


class MidnightHooks:
    """Fire-and-forget client for the midnight-bridge. Never raises into gameplay."""

    def __init__(self, base_url: str = BRIDGE):
        self.base = base_url
        self.q: "queue.Queue[tuple[str, dict]]" = queue.Queue()
        self.round = 0
        self.enabled = os.environ.get("SHADOW_DISABLE", "") != "1"
        self.deal_result: Optional[dict] = None
        self.token_balance: int = 100
        self._deal_started = False
        self._lock = threading.Lock()
        t = threading.Thread(target=self._worker, daemon=True, name="midnight-hooks")
        t.start()

    # ---------- blocking, lobby-time only ----------
    def deal(self, player_ids: list[int]) -> dict:
        """Anchors the match. RAISES on failure -- caller must abort match start.
        Returns DealResult; caller uses ONLY seatMap + saboteurPlayerId."""
        r = requests.post(f"{self.base}/deal",
                          json={"playerIds": sorted(player_ids)}, timeout=120)
        r.raise_for_status()
        d = r.json()
        log.info("match anchored: matchId=%s contract=%s tx=%s",
                 d["matchId"], d["contractAddress"], d["txId"])
        return d  # NOTE: never log d["saboteurPlayerId"]

    def commit(self, player_ids: list[int]) -> dict:
        """Explicit role & seat commitment check (/deal, /commit, /vote)."""
        try:
            r = requests.post(f"{self.base}/commit",
                              json={"playerIds": sorted(player_ids)}, timeout=10)
            if r.status_code == 200:
                return r.json()
        except Exception as e:
            log.warning("bridge /commit unreachable or timed out: %s", e.__class__.__name__)
        return {}

    def deal_async(self, player_ids: list[int], on_result) -> None:
        """Runs deal() on a background thread (this repo has no blocking lobby).
        Retries until the bridge answers; the game stays roleless (= unstarted)
        until the deal is anchored on-chain.  on_result(deal_dict) is called
        from the worker thread; game.py applies it on the next frame."""
        with self._lock:
            if self._deal_started or not self.enabled:
                return
            self._deal_started = True

        def _run():
            attempt = 0
            while True:
                try:
                    d = self.deal(player_ids)
                    self.deal_result = d
                    on_result(d)
                    return
                except Exception as e:
                    attempt += 1
                    log.warning(
                        "fairness layer unreachable -- match not started "
                        "(deal retry %d: %s)", attempt, e.__class__.__name__)
                    threading.Event().wait(min(2 ** attempt, 15))

        threading.Thread(target=_run, daemon=True, name="midnight-deal").start()

    # ---------- Night Coin Tokens ----------
    def get_token_balance(self) -> int:
        if not self.enabled:
            return self.token_balance
        try:
            r = requests.get(f"{self.base}/token/balance", timeout=3)
            if r.status_code == 200:
                self.token_balance = r.json().get("balance", self.token_balance)
        except Exception as e:
            log.debug("token balance query failed: %s", e)
        return self.token_balance

    def stake_tokens(self, amount: int) -> int:
        if not self.enabled:
            self.token_balance = max(0, self.token_balance - amount)
            return self.token_balance
        try:
            r = requests.post(f"{self.base}/token/stake", json={"amount": amount}, timeout=3)
            if r.status_code == 200:
                self.token_balance = r.json().get("balance", self.token_balance)
        except Exception as e:
            log.warning("token stake failed: %s", e)
            self.token_balance = max(0, self.token_balance - amount)
        return self.token_balance

    def reward_tokens(self, amount: int) -> int:
        if not self.enabled:
            self.token_balance += amount
            return self.token_balance
        try:
            r = requests.post(f"{self.base}/token/reward", json={"amount": amount}, timeout=3)
            if r.status_code == 200:
                self.token_balance = r.json().get("balance", self.token_balance)
        except Exception as e:
            log.warning("token reward failed: %s", e)
            self.token_balance += amount
        return self.token_balance

    # ---------- non-blocking gameplay events ----------
    def kill(self, killer_id: int, victim_id: int) -> None:
        self._enqueue("/kill", {"killerId": killer_id, "victimId": victim_id})

    def vote(self, voter_id: int, target_id: Optional[int]) -> None:
        self._enqueue("/vote", {"voterId": voter_id, "targetId": target_id})

    def eject(self, ejected_id: Optional[int]) -> None:
        self._enqueue("/eject", {"round": self.round, "ejectedId": ejected_id})
        self.round += 1

    def gameover(self, winner: int, reason: str) -> None:
        self._enqueue("/gameover", {"winner": winner, "reason": reason})

    # ---------- internals ----------
    def _enqueue(self, path: str, body: dict) -> None:
        if self.enabled:
            self.q.put((path, body))

    def _worker(self) -> None:
        while True:
            path, body = self.q.get()
            for attempt in range(30):                      # ~2.5 min of retries
                try:
                    r = requests.post(self.base + path, json=body, timeout=5)
                    if r.status_code < 500:
                        if r.status_code >= 400:
                            log.warning("bridge rejected %s: %s %s",
                                        path, r.status_code, r.text[:200])
                        break                              # 2xx ok; 4xx = drop (handled/dup)
                except requests.RequestException as e:
                    log.warning("bridge unreachable (%s), retry %d",
                                e.__class__.__name__, attempt)
                threading.Event().wait(min(2 ** attempt, 15))   # capped backoff
            self.q.task_done()


hooks = MidnightHooks()   # module singleton: `from midnight_hooks import hooks`
