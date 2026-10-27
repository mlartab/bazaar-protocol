"""Model client. All HTTP calls to models live in src/agents/ only.

Speaks to an OpenAI-compatible chat-completions endpoint (Meta Muse Spark via
META_BASE_URL). Short timeouts; any failure raises ModelUnavailable and the
caller falls back to a deterministic offline stand-in that is always labelled
simulated so the demo stays honest.
"""
from __future__ import annotations

import base64
import json
import os
import time
import urllib.request

CIRCUIT_BREAKER_SECONDS = 120.0


class ModelUnavailable(RuntimeError):
    pass


def _env(name: str, default: str = "") -> str:
    value = os.environ.get(name, default)
    # Lightweight .env support: read the project .env once if needed.
    if not value and name in ("MODEL_API_KEY", "META_BASE_URL", "META_MODEL",
                              "META_IMAGE_MODEL"):
        try:
            here = os.path.dirname(os.path.abspath(__file__))
            with open(os.path.join(here, "..", "..", ".env"), encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if line.startswith(name + "="):
                        value = line.split("=", 1)[1].strip()
                        break
        except OSError:
            pass
    return value


def load_config() -> dict:
    return {
        "api_key": _env("MODEL_API_KEY"),
        "base_url": _env("META_BASE_URL", "https://api.meta.ai/v1").rstrip("/"),
        "model": _env("META_MODEL", "muse-spark-1.3"),
        "image_model": _env("META_IMAGE_MODEL", "muse-image"),
    }


class ModelClient:
    def __init__(self, timeout: float = 8.0) -> None:
        cfg = load_config()
        self.api_key = cfg["api_key"]
        self.base_url = cfg["base_url"]
        self.model = cfg["model"]
        self.image_model = cfg["image_model"]
        self.timeout = timeout
        self._offline_until = 0.0

    @property
    def online(self) -> bool:
        if os.environ.get("BAZAAR_OFFLINE") == "1":
            return False
        if not (self.api_key and self.base_url):
            return False
        return time.time() >= self._offline_until

    def _post(self, path: str, body: dict) -> dict:
        if not self.online:
            raise ModelUnavailable("offline (no key, forced offline, or breaker open)")
        req = urllib.request.Request(
            self.base_url + path,
            data=json.dumps(body).encode("utf-8"),
            headers={"Authorization": f"Bearer {self.api_key}",
                     "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as exc:  # network, auth, schema: all mean "offline"
            self._offline_until = time.time() + CIRCUIT_BREAKER_SECONDS
            raise ModelUnavailable(str(exc)) from exc

    def complete_json(self, system: str, user: str,
                      max_tokens: int = 300) -> dict:
        """Chat completion parsed as a JSON object."""
        data = self._post("/chat/completions", {
            "model": self.model,
            "response_format": {"type": "json_object"},
            "max_tokens": max_tokens,
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": user}],
        })
        try:
            content = data["choices"][0]["message"]["content"]
            return json.loads(content)
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise ModelUnavailable(f"bad model response: {exc}") from exc

    def complete_vision_json(self, system: str, user_text: str,
                             image: bytes, max_tokens: int = 400) -> dict:
        """Chat completion with one attached image, parsed as a JSON object."""
        b64 = base64.b64encode(image).decode("ascii")
        data = self._post("/chat/completions", {
            "model": self.model,
            "response_format": {"type": "json_object"},
            "max_tokens": max_tokens,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": [
                    {"type": "text", "text": user_text},
                    {"type": "image_url",
                     "image_url": {"url": f"data:image/png;base64,{b64}"}},
                ]},
            ],
        })
        try:
            content = data["choices"][0]["message"]["content"]
            return json.loads(content)
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise ModelUnavailable(f"bad model response: {exc}") from exc

    def generate_image(self, prompt: str, size: str = "1024x1024") -> bytes:
        """Muse Image generation. Returns raw image bytes (PNG/JPEG)."""
        data = self._post("/images/generations", {
            "model": self.image_model,
            "prompt": prompt,
            "size": size,
            "response_format": "b64_json",
        })
        try:
            b64 = data["data"][0]["b64_json"]
            return base64.b64decode(b64)
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise ModelUnavailable(f"bad image response: {exc}") from exc
