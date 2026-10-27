import time
import unittest

from src.brief import Brief
from src.inspector import Inspector
from src.media import render_creative


class StubVision:
    def __init__(self, objects_ok=True, compliance_ok=True):
        self.objects_ok = objects_ok
        self.compliance_ok = compliance_ok

    def check_objects(self, image, required_objects, provenance):
        return {"passed": self.objects_ok, "reason": "stub objects",
                "simulated": True}

    def check_compliance(self, image, brief_dict, provenance):
        return {"passed": self.compliance_ok, "reason": "stub compliance",
                "simulated": True}


def make_brief():
    return Brief(product="Test Tonic", market="US",
                 required_objects=("bottle",), budget=100,
                 deadline=time.time() + 600)


class InspectorTest(unittest.TestCase):
    def test_full_pass(self):
        insp = Inspector(StubVision())
        png, _ = render_creative("Test Tonic", ["bottle"], seed=0)
        result = insp.inspect(png, make_brief(), {})
        self.assertTrue(result.passed)
        self.assertEqual([c.name for c in result.checks],
                         ["format", "hash", "objects", "compliance"])

    def test_duplicate_hash_rejected(self):
        insp = Inspector(StubVision())
        png, _ = render_creative("Test Tonic", ["bottle"], seed=0)
        first = insp.inspect(png, make_brief(), {})
        self.assertTrue(first.passed)
        second = insp.inspect(png, make_brief(), {})
        self.assertFalse(second.passed)
        by_name = {c.name: c for c in second.checks}
        self.assertFalse(by_name["hash"].passed)

    def test_wrong_format_rejected(self):
        insp = Inspector(StubVision())
        png, _ = render_creative("Test Tonic", ["bottle"], seed=0, size=(100, 100))
        result = insp.inspect(png, make_brief(), {})
        self.assertFalse(result.passed)
        by_name = {c.name: c for c in result.checks}
        self.assertFalse(by_name["format"].passed)

    def test_garbage_bytes_rejected(self):
        insp = Inspector(StubVision())
        result = insp.inspect(b"nope", make_brief(), {})
        self.assertFalse(result.passed)

    def test_failed_vision_check_fails_overall(self):
        for stub in (StubVision(objects_ok=False),
                     StubVision(compliance_ok=False)):
            insp = Inspector(stub)
            png, _ = render_creative("Test Tonic", ["bottle"], seed=0)
            result = insp.inspect(png, make_brief(), {})
            self.assertFalse(result.passed)


if __name__ == "__main__":
    unittest.main()
