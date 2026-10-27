"""Bazaar server: serves the viewer and a server-sent event stream.

- GET /         -> the live viewer (static HTML; it reads /events only)
- GET /events   -> text/event-stream of every market move
- GET /health   -> {"ok": true} for smoke checks (the viewer never calls it)

A background thread runs deals forever; the UI is a read-only projection of
the event stream. Stdlib only. Plain code, no model calls.
"""
from __future__ import annotations

import argparse
import itertools
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .agents.seller import SELLER_PROFILES
from .brief import sample_briefs
from .events import EventBus
from .ledger import Ledger
from .market import BUYER, Market
from .reputation import Reputation

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VIEWER_PATH = os.path.join(ROOT, "public", "viewer.html")

bus = EventBus()
market = Market(Ledger({BUYER: 1000, **{s: 0 for s in SELLER_PROFILES}}),
                Reputation(list(SELLER_PROFILES)), bus)


def market_loop(pause: float = 6.0) -> None:
    for brief in itertools.cycle(sample_briefs()):
        try:
            market.run_deal(brief)
        except Exception as exc:  # a deal must never kill the stream
            bus.emit("deal_error", {"error": str(exc)})
        time.sleep(pause)


class Handler(BaseHTTPRequestHandler):
    server_version = "Bazaar/1.0"

    def log_message(self, *args) -> None:  # keep the console for deals
        pass

    def do_GET(self) -> None:  # noqa: N802 (http.server naming)
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            self._send_viewer()
        elif path == "/events":
            self._send_events()
        elif path == "/health":
            body = b'{"ok": true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_error(404, "not found")

    def _send_viewer(self) -> None:
        try:
            with open(VIEWER_PATH, "rb") as fh:
                body = fh.read()
        except OSError:
            self.send_error(500, "viewer.html missing")
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_events(self) -> None:
        try:
            after = int(self.headers.get("Last-Event-ID", "0") or 0)
        except ValueError:
            after = 0
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        try:
            while True:
                events = bus.wait_for(after, timeout=15.0)
                if not events:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                    continue
                for event in events:
                    after = event["seq"]
                    frame = (f"id: {event['seq']}\n"
                             f"event: {event['type']}\n"
                             f"data: {json.dumps(event['payload'])}\n\n")
                    self.wfile.write(frame.encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Bazaar live market server")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--offline", action="store_true",
                        help="skip live model calls, use standby adapters")
    args = parser.parse_args()
    if args.offline:
        os.environ["BAZAAR_OFFLINE"] = "1"

    threading.Thread(target=market_loop, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Bazaar live at http://127.0.0.1:{args.port} "
          f"({'offline standby' if args.offline else 'live models with standby fallback'})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
