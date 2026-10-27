import os
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Functional fingerprints of a model call. Only files under src/agents/ may
# contain them; everything else must be plain code.
MODEL_FINGERPRINTS = (
    "urllib",
    "urlopen",
    "http.client",
    "MODEL_API_KEY",
    "META_BASE_URL",
    "chat/completions",
    "images/generations",
)


class AgentsIsolationTest(unittest.TestCase):
    def test_model_calls_live_only_in_agents(self):
        offenders = []
        for dirpath, _, filenames in os.walk(os.path.join(ROOT, "src")):
            rel = os.path.relpath(dirpath, os.path.join(ROOT, "src"))
            if rel.startswith("agents"):
                continue
            for name in filenames:
                if not name.endswith(".py"):
                    continue
                path = os.path.join(dirpath, name)
                with open(path, encoding="utf-8") as fh:
                    body = fh.read()
                for token in MODEL_FINGERPRINTS:
                    if token in body:
                        offenders.append(f"{path}: {token}")
        self.assertEqual(offenders, [])

    def test_agents_package_actually_holds_the_client(self):
        base = os.path.join(ROOT, "src", "agents", "base.py")
        with open(base, encoding="utf-8") as fh:
            body = fh.read()
        for token in ("chat/completions", "images/generations", "urlopen"):
            self.assertIn(token, body)

    def test_viewer_reads_sse_only(self):
        viewer = os.path.join(ROOT, "public", "viewer.html")
        with open(viewer, encoding="utf-8") as fh:
            body = fh.read()
        self.assertIn("new EventSource", body)
        self.assertNotIn("fetch(", body)
        self.assertNotIn("XMLHttpRequest", body)


if __name__ == "__main__":
    unittest.main()
