"""Media helpers: dimension sniffing and a stdlib-only creative renderer.

- image_dimensions(): read PNG/JPEG dimensions without any dependency.
- render_creative(): draw a deterministic 1080x1080 PNG for a brief. This is
  the offline fallback behind the Muse Image call in src/agents/images.py; it
  also returns a manifest of what was drawn so the offline vision fallback can
  stay honest about what it verified. Plain code, no model calls.
"""
from __future__ import annotations

import hashlib
import struct
import zlib

SIZE = (1080, 1080)

# Tiny 3x5 bitmap font for A-Z, 0-9, space and a few marks.
_FONT: dict[str, tuple[str, ...]] = {
    "A": ("010", "101", "111", "101", "101"), "B": ("110", "101", "110", "101", "110"),
    "C": ("011", "100", "100", "100", "011"), "D": ("110", "101", "101", "101", "110"),
    "E": ("111", "100", "110", "100", "111"), "F": ("111", "100", "110", "100", "100"),
    "G": ("011", "100", "101", "101", "011"), "H": ("101", "101", "111", "101", "101"),
    "I": ("111", "010", "010", "010", "111"), "J": ("001", "001", "001", "101", "010"),
    "K": ("101", "101", "110", "101", "101"), "L": ("100", "100", "100", "100", "111"),
    "M": ("101", "111", "111", "101", "101"), "N": ("110", "101", "101", "101", "101"),
    "O": ("010", "101", "101", "101", "010"), "P": ("110", "101", "110", "100", "100"),
    "Q": ("010", "101", "101", "110", "011"), "R": ("110", "101", "110", "101", "101"),
    "S": ("011", "100", "010", "001", "110"), "T": ("111", "010", "010", "010", "010"),
    "U": ("101", "101", "101", "101", "111"), "V": ("101", "101", "101", "101", "010"),
    "W": ("101", "101", "111", "111", "101"), "X": ("101", "101", "010", "101", "101"),
    "Y": ("101", "101", "010", "010", "010"), "Z": ("111", "001", "010", "100", "111"),
    "0": ("111", "101", "101", "101", "111"), "1": ("010", "110", "010", "010", "111"),
    "2": ("111", "001", "111", "100", "111"), "3": ("111", "001", "111", "001", "111"),
    "4": ("101", "101", "111", "001", "001"), "5": ("111", "100", "111", "001", "111"),
    "6": ("111", "100", "111", "101", "111"), "7": ("111", "001", "001", "010", "010"),
    "8": ("111", "101", "111", "101", "111"), "9": ("111", "101", "111", "001", "111"),
    " ": ("000", "000", "000", "000", "000"), "-": ("000", "000", "111", "000", "000"),
    ".": ("000", "000", "000", "000", "010"), "&": ("010", "101", "010", "101", "011"),
}

_PALETTE = [
    (31, 119, 180), (255, 127, 14), (44, 160, 44), (214, 39, 40),
    (148, 103, 189), (140, 86, 75), (227, 119, 194), (23, 190, 207),
]


def image_dimensions(data: bytes) -> tuple[str, int, int]:
    """Return (kind, width, height) for PNG or JPEG bytes. Raises ValueError."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        if len(data) < 33:
            raise ValueError("truncated PNG")
        w, h = struct.unpack(">II", data[16:24])
        return ("PNG", w, h)
    if data[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xC0, 0xC1, 0xC2, 0xC3):  # SOF: height, width
                h, w = struct.unpack(">HH", data[i + 5:i + 9])
                return ("JPEG", w, h)
            if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            (seg_len,) = struct.unpack(">H", data[i + 2:i + 4])
            if seg_len < 2:
                raise ValueError("corrupt JPEG segment")
            i += 2 + seg_len
        raise ValueError("no JPEG size marker found")
    raise ValueError("not a PNG or JPEG image")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class _Canvas:
    def __init__(self, w: int, h: int, bg: tuple[int, int, int]) -> None:
        self.w, self.h = w, h
        self.px = bytearray(w * h * 3)
        for i in range(0, len(self.px), 3):
            self.px[i:i + 3] = bytes(bg)

    def rect(self, x0: int, y0: int, x1: int, y1: int, color: tuple[int, int, int]) -> None:
        x0, y0 = max(0, x0), max(0, y0)
        x1, y1 = min(self.w, x1), min(self.h, y1)
        row = bytes(color) * (x1 - x0)
        for y in range(y0, y1):
            off = (y * self.w + x0) * 3
            self.px[off:off + len(row)] = row

    def disc(self, cx: int, cy: int, r: int, color: tuple[int, int, int]) -> None:
        for y in range(max(0, cy - r), min(self.h, cy + r + 1)):
            dx = int((r * r - (y - cy) ** 2) ** 0.5)
            off = (y * self.w + max(0, cx - dx)) * 3
            n = min(self.w, cx + dx + 1) - max(0, cx - dx)
            self.px[off:off + n * 3] = bytes(color) * n

    def text(self, x: int, y: int, s: str, scale: int, color: tuple[int, int, int]) -> None:
        s = "".join(c if c in _FONT else " " for c in s.upper())[:24]
        for ci, ch in enumerate(s):
            glyph = _FONT[ch]
            for gy, row in enumerate(glyph):
                for gx, bit in enumerate(row):
                    if bit == "1":
                        self.rect(x + (ci * 4 + gx) * scale, y + gy * scale,
                                  x + (ci * 4 + gx) * scale + scale,
                                  y + gy * scale + scale, color)

    def to_png(self) -> bytes:
        raw = bytearray()
        stride = self.w * 3
        for y in range(self.h):
            raw.append(0)
            raw += self.px[y * stride:(y + 1) * stride]
        body = zlib.compress(bytes(raw), 6)

        def chunk(ctype: bytes, payload: bytes) -> bytes:
            return (struct.pack(">I", len(payload)) + ctype + payload
                    + struct.pack(">I", zlib.crc32(ctype + payload) & 0xFFFFFFFF))

        return (b"\x89PNG\r\n\x1a\n"
                + chunk(b"IHDR", struct.pack(">IIBBBBB", self.w, self.h, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", body)
                + chunk(b"IEND", b""))


def render_creative(product: str, required_objects: list[str], seed: int = 0,
                    size: tuple[int, int] = SIZE) -> tuple[bytes, dict]:
    """Draw a deterministic 1080x1080 standby creative. Returns PNG bytes plus
    a manifest of what was drawn (used only by the offline vision fallback)."""
    w, h = size
    bg = (245, 240, 232) if seed % 2 == 0 else (232, 240, 245)
    canvas = _Canvas(w, h, bg)
    # Banner with the product name.
    canvas.rect(60, 60, w - 60, 220, (24, 32, 40))
    canvas.text(110, 105, product, 12, (250, 248, 244))
    # One shape per required object, laid out on a calm grid.
    manifest_objects: list[str] = []
    n = max(1, len(required_objects))
    for i, obj in enumerate(required_objects):
        color = _PALETTE[(i + seed) % len(_PALETTE)]
        cx = int(w * (i + 1) / (n + 1))
        cy = 620
        if (i + seed) % 2 == 0:
            canvas.disc(cx, cy, 150, color)
            canvas.disc(cx, cy, 110, (255, 255, 255))
            canvas.disc(cx, cy, 70, color)
        else:
            canvas.rect(cx - 150, cy - 150, cx + 150, cy + 150, color)
            canvas.rect(cx - 105, cy - 105, cx + 105, cy + 105, (255, 255, 255))
            canvas.rect(cx - 65, cy - 65, cx + 65, cy + 65, color)
        canvas.text(cx - 12 * len(obj[:12]), cy + 190, obj[:12], 6, (24, 32, 40))
        manifest_objects.append(obj)
    # Footer strip.
    canvas.rect(60, h - 140, w - 60, h - 60, (24, 32, 40))
    canvas.text(110, h - 115, "AD CREATIVE 1080X1080", 6, (250, 248, 244))
    png = canvas.to_png()
    manifest = {"renderer": "bazaar-standby", "seed": seed,
                "objects_drawn": manifest_objects, "product": product}
    return png, manifest
