"""py/collect.py on synthetic streams of the data-collection firmware. Run: .venv/bin/python -B -m unittest discover -s py/tests"""

import json
import os
import struct
import sys
import tempfile
import unittest
import wave

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from collect import StreamError, expected_hash, record  # noqa: E402

SAMPLES = 160


def header(rev=12, path="80722b24d856", samples=SAMPLES):
    return f"BRINGUP-COLLECT rev={rev} path={path} sensor=microphone rate=16000 channels=1 bits=16 samples={samples}\n".encode()


def frame(seq, value, samples=SAMPLES):
    return b"BRW1" + struct.pack("<II", seq, samples) + struct.pack(f"<{samples}h", *([value] * samples))


def reader(data, chunk):
    """read(n) over data, at most chunk bytes a call, like a serial port."""
    pos = [0]

    def read(n):
        out = data[pos[0]:pos[0] + min(n, chunk)]
        pos[0] += len(out)
        return out

    return read


def run(out, data, label="hey", windows=10, chunk=64, **kw):
    return record(reader(b"".join(data), chunk), out, label, windows, log=lambda m: None, **kw)


def first_sample(path):
    with wave.open(path) as w:
        return struct.unpack("<h", w.readframes(1))[0]


class Collect(unittest.TestCase):
    def setUp(self):
        self.out = tempfile.mkdtemp()

    def test_windows_become_wav_clips_and_the_manifest_names_the_sensor_path(self):
        # 7-byte reads split the header line and every frame.
        manifest, saved, report = run(self.out, [b"ESP-ROM:esp32c3 boot noise\r\n", header(), frame(0, 100), frame(1, -100), frame(2, 7)], windows=3, chunk=7)
        self.assertEqual(saved, 3)
        self.assertEqual(report, {"dropped": 0, "gaps": 0, "silent": 0})
        self.assertEqual((manifest["pathHash"], manifest["revision"], manifest["rateHz"], manifest["samplesPerClip"]), ("80722b24d856", 12, 16000, SAMPLES))
        self.assertEqual([c["file"] for c in manifest["clips"]], ["hey/000000.wav", "hey/000001.wav", "hey/000002.wav"])
        with wave.open(os.path.join(self.out, "hey/000001.wav")) as w:
            self.assertEqual((w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()), (16000, 1, 2, SAMPLES))
        self.assertEqual(first_sample(os.path.join(self.out, "hey/000001.wav")), -100)
        with open(os.path.join(self.out, "manifest.json")) as f:
            self.assertEqual(len(json.load(f)["clips"]), 3)

    def test_a_second_session_after_a_board_reset_never_overwrites_the_first(self):
        # Same revision, same label, and the board's window numbers start at 0 again (a reset when the port opens).
        run(self.out, [header(), frame(0, 1), frame(1, 2)], windows=2)
        manifest, _, _ = run(self.out, [header(), frame(0, 3), frame(1, 4)], windows=2)
        files = [c["file"] for c in manifest["clips"]]
        self.assertEqual(files, ["hey/000000.wav", "hey/000001.wav", "hey/000002.wav", "hey/000003.wav"])
        self.assertEqual([first_sample(os.path.join(self.out, f)) for f in files], [1, 2, 3, 4], "the first session's audio is still there")

    def test_lost_bytes_drop_that_window_instead_of_saving_a_corrupt_clip(self):
        broken = frame(0, 5)[:-10]  # 10 bytes lost in transit
        manifest, saved, report = run(self.out, [header(), broken, frame(1, 6), frame(2, 7)], windows=5)
        self.assertEqual(report["dropped"], 1)
        self.assertEqual([c["seq"] for c in manifest["clips"]], [1, 2])
        self.assertEqual([first_sample(os.path.join(self.out, c["file"])) for c in manifest["clips"]], [6, 7])

    def test_a_stray_magic_with_a_wrong_length_is_skipped_not_fatal(self):
        stray = b"BRW1" + struct.pack("<II", 9, 999)
        _, saved, report = run(self.out, [header(), stray, frame(0, 1), frame(1, 2)], windows=5)
        self.assertEqual(saved, 2)
        self.assertEqual(report["dropped"], 1)

    def test_gaps_in_the_firmware_window_numbers_are_counted(self):
        _, _, report = run(self.out, [header(), frame(0, 1), frame(3, 1)], windows=5)
        self.assertEqual(report["gaps"], 2)

    def test_windows_the_firmware_flagged_silent_are_kept_and_marked(self):
        manifest, _, report = run(self.out, [header(), b"BRINGUP-COLLECT WARN silent seq=0 peak-to-peak=0\n", frame(0, 0), frame(1, 9)], windows=5)
        self.assertEqual(report["silent"], 1)
        self.assertEqual([c.get("silent", False) for c in manifest["clips"]], [True, False])

    def test_a_firmware_failure_line_stops_with_its_reason(self):
        with self.assertRaisesRegex(StreamError, "i2s begin"):
            run(self.out, [b"BRINGUP-COLLECT FAIL i2s begin\n"])

    def test_a_board_on_another_sensor_path_is_refused_for_this_dataset(self):
        run(self.out, [header(), frame(0, 1)], windows=1)
        with self.assertRaisesRegex(StreamError, "80722b24d856.*6c2b55e5c2ab.*new folder"):
            run(self.out, [header(rev=14, path="6c2b55e5c2ab"), frame(0, 1)], windows=1)

    def test_a_different_window_length_is_a_different_dataset(self):
        run(self.out, [header(), frame(0, 1)], windows=1)
        with self.assertRaisesRegex(StreamError, "160-sample clips.*sends 80"):
            run(self.out, [header(samples=80), frame(0, 1, samples=80)], windows=1)

    def test_a_board_flashed_from_an_older_design_is_refused_against_the_contract(self):
        with self.assertRaisesRegex(StreamError, "streams sensor path 80722b24d856.*design is at 6c2b55e5c2ab"):
            run(self.out, [header(), frame(0, 1)], windows=1, want_hash="6c2b55e5c2ab")

    def test_no_header_means_no_collection_firmware(self):
        with self.assertRaisesRegex(StreamError, "no BRINGUP-COLLECT header"):
            run(self.out, [b"bringup rev 12\nSENSOR OK\n", frame(0, 1)], windows=1)


class ExpectedHash(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.contract = os.path.join(self.dir, "contract.json")

    def write(self, model):
        with open(self.contract, "w") as f:
            json.dump({"revision": 9, "values": {"model": model}}, f)

    def test_the_contracts_model_data_names_the_path(self):
        self.write({"task": "wake word", "data": {"status": "needed", "revision": 9, "pathHash": "6c2b55e5c2ab", "path": {}}})
        self.assertEqual(expected_hash(self.contract), "6c2b55e5c2ab")

    def test_before_any_data_the_collect_firmware_build_names_it(self):
        # The first collection: the model has no data yet; `bringup collect-firmware` wrote collect.json.
        self.write({"task": "wake word"})
        with open(os.path.join(self.dir, "collect.json"), "w") as f:
            json.dump({"revision": 9, "pathHash": "80722b24d856", "ok": True}, f)
        self.assertEqual(expected_hash(self.contract), "80722b24d856")

    def test_with_neither_the_check_refuses_instead_of_passing_silently(self):
        self.write({"task": "wake word"})
        with self.assertRaisesRegex(StreamError, "collect-firmware"):
            expected_hash(self.contract)


if __name__ == "__main__":
    unittest.main()
