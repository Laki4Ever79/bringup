"""Bench bridge: Node's single process for the hardware bench (docs/design/bench.md §3b).

    .venv/bin/python py/bench.py --source real|fake|replay [--replay FILE] [--out DIR] [--fake-speed X]

Commands arrive as JSON lines on stdin; events and acks leave as JSON lines on stdout; stderr is free text.
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from benchlib.bridge import Bridge, Out  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", choices=["real", "fake", "replay"], default="real")
    ap.add_argument("--replay", help="a bench.jsonl recording (with --source replay)")
    ap.add_argument("--out", help="directory for bench.jsonl, power.csv and the S3 build dir (fw-s3/)")
    ap.add_argument("--no-meter", action="store_true", help="with --source fake: a tier-1 bench, no fixture or INA226")
    ap.add_argument("--no-imu", action="store_true", help="with --source fake: no MPU-6050 (tilt 0, an imu error each second)")
    ap.add_argument("--fake-factory", action="store_true", help="with --source fake: the S3 still runs its shipped demo, so the first flash needs BOOT+RST")
    ap.add_argument("--fake-speed", type=float, default=1.0, help="divides the fake flash timings (tests)")
    ap.add_argument("--pio", default=os.environ.get("BENCH_PIO", os.path.join(ROOT, ".venv/bin/pio")))
    args = ap.parse_args(argv)
    if args.source == "replay" and not args.replay:
        ap.error("--source replay needs --replay FILE")

    work_dir = os.path.join(args.out, "fw-s3") if args.out else None
    bridge = Bridge(args.source, Out(sys.stdout, args.out), args.pio, fake_speed=args.fake_speed, replay=args.replay, work_dir=work_dir, no_meter=args.no_meter, no_imu=args.no_imu, fake_factory=args.fake_factory)
    try:
        bridge.start()
    except Exception as e:
        print(f"bench: could not start the {args.source} bench: {e}", file=sys.stderr)
        return 1
    bridge.serve(sys.stdin)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
