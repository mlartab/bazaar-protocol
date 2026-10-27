"""Inspector: confirms the creative matches the brief before money moves.

- Format and hash run here, in plain code.
- Object presence (SAM 3.1) and compliance (Muse Spark vision) run behind the
  vision port implemented in src/agents/vision.py. This module never calls a
  model directly. No money moves until every check passes.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from .brief import REQUIRED_FORMAT
from .media import image_dimensions, sha256_hex


class VisionPort(Protocol):
    def check_objects(self, image: bytes, required_objects: list[str],
                      provenance: dict) -> dict: ...
    def check_compliance(self, image: bytes, brief_dict: dict,
                         provenance: dict) -> dict: ...


@dataclass
class CheckResult:
    name: str
    passed: bool
    reason: str
    detail: dict = field(default_factory=dict)


@dataclass
class InspectionResult:
    passed: bool
    checks: list[CheckResult]
    image_hash: str

    def to_dict(self) -> dict:
        return {
            "passed": self.passed,
            "image_hash": self.image_hash,
            "checks": [{"name": c.name, "passed": c.passed, "reason": c.reason,
                        "detail": c.detail} for c in self.checks],
        }


class Inspector:
    def __init__(self, vision: VisionPort) -> None:
        self.vision = vision
        self.seen_hashes: set[str] = set()

    def inspect(self, image: bytes, brief, provenance: dict) -> InspectionResult:
        checks: list[CheckResult] = []

        # 1. Format (code): must be a 1080x1080 PNG or JPEG.
        try:
            kind, width, height = image_dimensions(image)
        except ValueError as exc:
            kind, width, height = "?", 0, 0
            checks.append(CheckResult("format", False, f"unreadable image: {exc}"))
        else:
            want_w, want_h = REQUIRED_FORMAT
            if (width, height) == (want_w, want_h):
                checks.append(CheckResult(
                    "format", True,
                    f"{kind} {width}x{height} matches the brief",
                    {"kind": kind, "width": width, "height": height}))
            else:
                checks.append(CheckResult(
                    "format", False,
                    f"{kind} {width}x{height}; brief requires {want_w}x{want_h}",
                    {"kind": kind, "width": width, "height": height}))

        # 2. Hash (code): sha256 recorded; duplicates rejected.
        digest = sha256_hex(image)
        if digest in self.seen_hashes:
            checks.append(CheckResult("hash", False,
                                      "duplicate deliverable: hash already seen",
                                      {"sha256": digest}))
        else:
            checks.append(CheckResult("hash", True,
                                      f"sha256 {digest[:12]}… recorded, first seen",
                                      {"sha256": digest}))

        # 3. Object presence (SAM 3.1, via the vision port).
        obj = self.vision.check_objects(image, list(brief.required_objects), provenance)
        checks.append(CheckResult("objects", bool(obj.get("passed")),
                                  str(obj.get("reason", "")),
                                  {k: v for k, v in obj.items()
                                   if k not in ("passed", "reason")}))

        # 4. Compliance (Muse Spark vision, via the vision port).
        comp = self.vision.check_compliance(image, brief.to_dict(), provenance)
        checks.append(CheckResult("compliance", bool(comp.get("passed")),
                                  str(comp.get("reason", "")),
                                  {k: v for k, v in comp.items()
                                   if k not in ("passed", "reason")}))

        passed = all(c.passed for c in checks)
        if passed:
            self.seen_hashes.add(digest)
        return InspectionResult(passed=passed, checks=checks, image_hash=digest)
