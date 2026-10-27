"""Vision checks for the Inspector.

- Object presence: SAM 3.1 segmentation evidence, confirmed per object.
- Compliance: Muse Spark vision, yes/no with a reason. Artistic quality is
  explicitly out of scope and never judged.

Offline fallbacks are deterministic and always labelled simulated. The
fallback object check verifies the standby renderer's manifest (what was
actually drawn) instead of pretending to see pixels.
"""
from __future__ import annotations

from .base import ModelClient, ModelUnavailable

_COMPLIANCE_SYSTEM = (
    "You are an ad-compliance checker. Reply with a JSON object only, shaped "
    "{\"pass\": <bool>, \"reason\": <str>}. Pass unless the image shows "
    "something unsafe, deceptive, or plainly off-brief (wrong product vibe, "
    "missing market language cues). Do NOT judge artistic quality, taste, or "
    "beauty — those are out of scope."
)

_OBJECTS_SYSTEM = (
    "You are an object-presence checker. Reply with a JSON object only. For "
    "each required object answer whether it is clearly visible. Shape: "
    "{\"present\": {\"<object>\": <bool>}, \"reason\": <str>}."
)


def sam_segment_count(image: bytes) -> tuple[int, str]:
    """SAM 3.1 integration point. Returns (mask_count, backend_label).

    Uses the `sam3` package when installed (``pip install sam3`` with a
    SAM 3.1 checkpoint); otherwise reports 0 masks with the standby label.
    The Inspector treats the label as evidence metadata, not as a verdict.
    """
    try:
        import sam3  # type: ignore
        segment = getattr(sam3, "automatic_masks", None)
        if segment is None:
            return 0, "sam3 package present but no automatic_masks entrypoint"
        masks = segment(image)
        return len(masks), "sam-3.1"
    except ImportError:
        return 0, "sam-3.1 unavailable (standby)"
    except Exception as exc:  # corrupt input, missing checkpoint, etc.
        return 0, f"sam-3.1 error, standby used ({exc})"


class VisionAgent:
    def __init__(self, client: ModelClient | None = None) -> None:
        self.client = client or ModelClient()

    def check_objects(self, image: bytes, required_objects: list[str],
                      provenance: dict) -> dict:
        mask_count, backend = sam_segment_count(image)
        detail = {"sam_backend": backend, "sam_masks": mask_count}
        # Online path: SAM evidence + per-object vision confirmation.
        try:
            out = self.client.complete_vision_json(
                _OBJECTS_SYSTEM,
                f"Required objects: {', '.join(required_objects)}. "
                f"Segmentation found {mask_count} regions ({backend}). "
                "Which required objects are clearly visible?",
                image)
        except ModelUnavailable:
            out = None
        if out is not None:
            present = out.get("present", {})
            missing = [o for o in required_objects if not present.get(o)]
            detail["simulated"] = False
            detail["present"] = {o: bool(present.get(o))
                                 for o in required_objects}
            if not missing:
                return {"passed": True,
                        "reason": f"all required objects visible "
                                  f"({out.get('reason', '')})".strip(),
                        **detail}
            return {"passed": False,
                    "reason": f"missing: {', '.join(missing)} "
                              f"({out.get('reason', '')})".strip(),
                    **detail}
        # Offline fallback: verify the standby manifest of drawn objects.
        manifest = provenance.get("manifest", {}) if provenance else {}
        drawn = manifest.get("objects_drawn", []) if manifest else []
        missing = [o for o in required_objects if o not in drawn]
        detail["simulated"] = True
        detail["present"] = {o: o in drawn for o in required_objects}
        if not missing:
            return {"passed": True,
                    "reason": ("offline standby: renderer manifest confirms "
                               f"{', '.join(drawn)} were drawn; vision model "
                               "unreachable"),
                    **detail}
        return {"passed": False,
                "reason": ("offline standby: manifest shows "
                           f"{', '.join(drawn) or 'nothing drawn'}; missing "
                           f"{', '.join(missing)}"),
                **detail}

    def check_compliance(self, image: bytes, brief_dict: dict,
                         provenance: dict) -> dict:
        try:
            out = self.client.complete_vision_json(
                _COMPLIANCE_SYSTEM,
                f"Product: {brief_dict['product']}. Market: "
                f"{brief_dict['market']}. Brief format "
                f"{brief_dict['format']}. Is this ad creative compliant?",
                image)
            ok = bool(out.get("pass"))
            return {"passed": ok,
                    "reason": str(out.get("reason", "")),
                    "simulated": False}
        except ModelUnavailable:
            pass
        return {"passed": True,
                "reason": ("offline standby: vision model unreachable; "
                           "standby renderer draws only brief-safe shapes, "
                           "no text claims, no people"),
                "simulated": True}
