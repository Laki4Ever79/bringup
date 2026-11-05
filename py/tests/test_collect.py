"""py/collect.py on synthetic streams of the data-collection firmware. Run: .venv/bin/python -B -m unittest discover -s py/tests"""

import json
import os
import struct
import sys
import tempfile
import unittest
import wave

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from collect import StreamError, record  # noqa: E402

SAMPLES = 160


def header(rev=12, path="80722b24d856"):
    return f"BRINGUP-COLLECT rev={rev} path={path} sensor=microphone rate=16000 channels=1 bits=16 samples={SAMPLES}\n".encode()


def frame(seq, value):
    return b"BRW1" + struct.pack("<II", seq, SAMPLES) + struct.pack(f"<{SAMPLES}h", *([value] * SAMPLES))


def reader(data, chunk):
    """read(n) over data, at most chunk bytes a call, like a serial port."""
    pos = [0]

    def read(n):
        out = data[pos[0]:pos[0] + min(n, chunk)]
        pos[0] += len(out)
        return out

    return read


def stream(*parts):
    return b"".join(parts)


class Collect(unittest.TestCase):
    def setUp(self):
        self.out = tempfile.mkdtemp()

    def test_windows_become_wav_clips_and_the_manifest_names_the_sensor_path(self):
        data = stream(b"ESP-ROM:esp32c3 boot noise\r\n", header(), frame(0, 100), frame(1, -100), frame(2, 7))
        # 7-byte reads split the header line and every frame.
        manifest, saved = record(reader(data, 7), self.out, "hey", 3)
        self.assertEqual(saved, 3)
        self.assertEqual((manifest["pathHash"], manifest["revision"], manifest["rateHz"]), ("80722b24d856", 12, 16000))
        self.assertEqual([c["file"] for c in manifest["clips"]], ["hey/12-000000.wav", "hey/12-000001.wav", "hey/12-000002.wav"])
        with wave.open(os.path.join(self.out, "hey/12-000001.wav")) as w:
            self.assertEqual((w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()), (16000, 1, 2, SAMPLES))
            self.assertEqual(struct.unpack("<h", w.readframes(1))[0], -100)
        with open(os.path.join(self.out, "manifest.json")) as f:
            self.assertEqual(len(json.load(f)["clips"]), 3)

    def test_a_second_session_on_the_same_path_adds_to_the_dataset(self):
        record(reader(stream(header(), frame(0, 1)), 64), self.out, "hey", 1)
        manifest, _ = record(reader(stream(header(rev=13), frame(0, 2)), 64), self.out, "noise", 1)
        self.assertEqual([c["label"] for c in manifest["clips"]], ["hey", "noise"])

    def test_a_board_on_another_sensor_path_is_refused_for_this_dataset(self):
        record(reader(stream(header(), frame(0, 1)), 64), self.out, "hey", 1)
        with self.assertRaisesRegex(StreamError, "80722b24d856.*6c2b55e5c2ab.*new folder"):
            record(reader(stream(header(rev=14, path="6c2b55e5c2ab"), frame(0, 1)), 64), self.out, "hey", 1)

    def test_a_board_flashed_from_an_older_design_is_refused_against_the_contract(self):
        with self.assertRaisesRegex(StreamError, "streams sensor path 80722b24d856.*design is at 6c2b55e5c2ab"):
            record(reader(stream(header(), frame(0, 1)), 64), self.out, "hey", 1, want_hash="6c2b55e5c2ab")

    def test_no_header_means_no_collection_firmware(self):
        with self.assertRaisesRegex(StreamError, "no BRINGUP-COLLECT header"):
            record(reader(b"bringup rev 12\nSENSOR OK\n" + frame(0, 1), 64), self.out, "hey", 1)

    def test_a_frame_whose_length_disagrees_with_the_header_is_an_error(self):
        bad = b"BRW1" + struct.pack("<II", 0, SAMPLES + 1)
        with self.assertRaisesRegex(StreamError, "161 samples"):
            record(reader(stream(header(), bad), 64), self.out, "hey", 1)


if __name__ == "__main__":
    unittest.main()
