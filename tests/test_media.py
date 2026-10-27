import struct
import unittest

from src.media import image_dimensions, render_creative


class MediaTest(unittest.TestCase):
    def test_render_is_1080_png(self):
        png, manifest = render_creative("Test Tonic", ["bottle", "cap"], seed=3)
        kind, w, h = image_dimensions(png)
        self.assertEqual((kind, w, h), ("PNG", 1080, 1080))
        self.assertEqual(manifest["objects_drawn"], ["bottle", "cap"])

    def test_render_is_deterministic(self):
        a, _ = render_creative("X", ["y"], seed=1)
        b, _ = render_creative("X", ["y"], seed=1)
        c, _ = render_creative("X", ["y"], seed=2)
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)

    def test_jpeg_sniffing(self):
        data = (b"\xff\xd8" + b"\xff\xe0\x00\x10" + b"J" * 14
                + b"\xff\xc0\x00\x0b\x08" + struct.pack(">HH", 1080, 1080)
                + b"\x01\x01\x11\x00")
        self.assertEqual(image_dimensions(data), ("JPEG", 1080, 1080))

    def test_garbage_rejected(self):
        with self.assertRaises(ValueError):
            image_dimensions(b"not an image at all")


if __name__ == "__main__":
    unittest.main()
