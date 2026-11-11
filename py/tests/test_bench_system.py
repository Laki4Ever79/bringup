"""The system bench checker (py/bench_system.py), judged on saved USB output: no hardware."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import bench_system  # noqa: E402

PLAN = {
    "system": "logger and beacon",
    "boards": [{"name": "logger", "firmwareDir": "fw/logger", "testKit": False}, {"name": "beacon", "firmwareDir": "fw/beacon", "testKit": False}],
    "steps": [],
    "expect": [{"board": "beacon", "link": "L1", "message": "reading", "from": "logger", "prefix": "LINK L1 reading from logger:", "fields": {"tempCx100": 2150, "rhx100": 4025}}],
    "minLines": 3,
    "seconds": 15,
}
GOOD = "boot\n" + "LINK L1 reading from logger: tempCx100=2150 rhx100=4025\n" * 3


class Judge(unittest.TestCase):
    def test_every_message_arriving_enough_times_with_the_known_values_passes(self):
        results = bench_system.judge(PLAN, {"logger": "boot\n", "beacon": GOOD})
        self.assertEqual([(r["check"], r["status"]) for r in results], [("beacon: L1 reading from logger", "pass")])
        self.assertTrue(bench_system.passed(results))

    def test_a_wrong_value_fails_and_names_the_field(self):
        log = GOOD.replace("rhx100=4025", "rhx100=4000")
        [r] = bench_system.judge(PLAN, {"logger": "", "beacon": log})
        self.assertEqual(r["status"], "FAIL")
        self.assertIn("rhx100", r["detail"])

    def test_too_few_lines_fail(self):
        [r] = bench_system.judge(PLAN, {"logger": "", "beacon": "LINK L1 reading from logger: tempCx100=2150 rhx100=4025\n"})
        self.assertEqual(r["status"], "FAIL")
        self.assertIn("1 of 3", r["detail"])

    def test_a_frame_from_another_definition_fails_the_board(self):
        log = GOOD + "LINK L1: a frame with an unknown definition (hash 1234abcd), dropped\n"
        results = bench_system.judge(PLAN, {"logger": "", "beacon": log})
        self.assertFalse(bench_system.passed(results))
        self.assertTrue(any("unknown definition" in r["detail"] and r["status"] == "FAIL" for r in results))

    def test_a_board_nobody_listened_to_is_not_a_pass(self):
        [r] = bench_system.judge(PLAN, {"logger": GOOD})
        self.assertEqual(r["status"], "not listened")
        self.assertFalse(bench_system.passed([r]))


class Cli(unittest.TestCase):
    def test_saved_logs_give_a_table_and_the_exit_code(self):
        with tempfile.TemporaryDirectory() as d:
            plan = os.path.join(d, "bench-plan.json")
            with open(plan, "w") as f:
                json.dump(PLAN, f)
            good, bad = os.path.join(d, "good.txt"), os.path.join(d, "bad.txt")
            with open(good, "w") as f:
                f.write(GOOD)
            with open(bad, "w") as f:
                f.write("nothing\n")
            script = os.path.join(os.path.dirname(__file__), "..", "bench_system.py")
            ok = subprocess.run([sys.executable, script, plan, "--log", f"beacon={good}"], capture_output=True, text=True)
            self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)
            self.assertIn("| beacon: L1 reading from logger | pass |", ok.stdout)
            fail = subprocess.run([sys.executable, script, plan, "--log", f"beacon={bad}"], capture_output=True, text=True)
            self.assertEqual(fail.returncode, 1)
            self.assertIn("FAIL", fail.stdout)


if __name__ == "__main__":
    unittest.main()
