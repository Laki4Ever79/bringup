"""The enclosure print check's mesh test on hand-made STLs. Run: .venv/bin/python -B -m unittest discover -s py/tests"""

import os
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from enclosure import stl_manifold_issues  # noqa: E402

# A tetrahedron, outward-facing triangles.
V = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1)]
FACES = [(0, 2, 1), (0, 1, 3), (0, 3, 2), (1, 2, 3)]


def stl(faces):
    path = os.path.join(tempfile.mkdtemp(), "m.stl")
    with open(path, "wb") as f:
        f.write(b"\0" * 80 + struct.pack("<I", len(faces)))
        for a, b, c in faces:
            f.write(struct.pack("<12fH", 0, 0, 0, *V[a], *V[b], *V[c], 0))
    return path


class Manifold(unittest.TestCase):
    def test_a_closed_mesh_passes(self):
        self.assertEqual(stl_manifold_issues(stl(FACES), "t"), [])

    def test_a_missing_face_is_an_open_mesh(self):
        issues = stl_manifold_issues(stl(FACES[:3]), "t")
        self.assertEqual(len(issues), 1)
        self.assertIn("not watertight (3 open", issues[0])

    def test_a_flipped_face_is_caught(self):
        a, b, c = FACES[3]
        self.assertNotEqual(stl_manifold_issues(stl(FACES[:3] + [(a, c, b)]), "t"), [])


if __name__ == "__main__":
    unittest.main()
