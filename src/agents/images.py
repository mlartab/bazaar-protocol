"""Seller deliverable: Muse Image output.

Tries the image model first; when unreachable, renders the deterministic
standby creative from src/media.py. Either way the Inspector judges the bytes
afterwards — the fallback never bypasses inspection. Provenance always says
which path produced the image.
"""
from __future__ import annotations

from ..media import render_creative
from .base import ModelClient, ModelUnavailable


class ImageAgent:
    def __init__(self, client: ModelClient | None = None) -> None:
        self.client = client or ModelClient(timeout=30.0)

    def generate(self, prompt: str, product: str,
                 required_objects: list[str], seed: int = 0) -> tuple[bytes, dict]:
        """Return (image_bytes, provenance)."""
        try:
            data = self.client.generate_image(prompt)
            if data[:8] == b"\x89PNG\r\n\x1a\n" or data[:2] == b"\xff\xd8":
                return data, {"source": "muse-image", "simulated": False,
                              "prompt": prompt}
        except ModelUnavailable:
            pass
        png, manifest = render_creative(product, required_objects, seed=seed)
        provenance = {"source": "bazaar-standby-renderer", "simulated": True,
                      "prompt": prompt, "manifest": manifest}
        return png, provenance
