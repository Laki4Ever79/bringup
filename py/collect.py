"""Records the data-collection firmware's stream (templates/fw/src/collect.cpp) into a dataset for one sensor path.

    .venv/bin/python py/collect.py --port /dev/ttyACM0 --label hey_bringup --windows 50 --out data/wake [--contract out/contract.json]

Each window becomes <out>/<label>/<seq>.wav (16-bit PCM). <out>/manifest.json records the sensor path hash, the
contract revision and the stream's format, and every clip. A dataset belongs to one sensor path: recording a board
whose path hash differs from the manifest's is refused, because training data from two different sensor paths is two
different datasets. With --contract, the stream must also match the path the design has now (model.data.pathHash, or
the hash the firmware build stamped), so data is never recorded on an outdated board.

--input FILE reads a captured stream instead of a serial port (tests, replays).
"""

import argparse
import json
import re
import struct
import sys
import wave
from pathlib import Path

MAGIC = b"BRW1"
HEADER = re.compile(rb"BRINGUP-COLLECT rev=(\d+) path=([0-9a-f]{12}) sensor=(\w+) rate=(\d+) channels=(\d+) bits=(\d+) samples=(\d+)\r?\n")


class StreamError(Exception):
    pass


def frames(read):
    """Yields ("header", dict) and ("window", seq, pcm bytes) from a byte source read(n) -> bytes ('' at the end)."""
    buf = b""
    header = None

    def fill(n):
        nonlocal buf
        while len(buf) < n:
            chunk = read(max(n - len(buf), 4096))
            if not chunk:
                return False
            buf += chunk
        return True

    while True:
        # The next thing is either a header line or a frame; text before either (boot log) is skipped.
        if not fill(4):
            return
        h = HEADER.search(buf)
        m = buf.find(MAGIC)
        # The pattern ends at the line's newline, so a header split across two reads isn't parsed half-read.
        if h and (m < 0 or h.start() < m):
            rev, path, sensor, rate, channels, bits, samples = h.groups()
            header = {"revision": int(rev), "pathHash": path.decode(), "sensor": sensor.decode(), "rateHz": int(rate), "channels": int(channels), "bits": int(bits), "samples": int(samples)}
            buf = buf[h.end():]
            yield ("header", header)
            continue
        if m < 0:
            # Keep a tail that may hold the start of a magic or a header line split across reads.
            keep = buf[-200:]
            buf = keep
            if not fill(len(keep) + 1):
                return
            continue
        buf = buf[m:]
        if not fill(12):
            return
        seq, n = struct.unpack_from("<II", buf, 4)
        if header is None:
            # A frame before any header can't be attributed to a sensor path: skip it.
            buf = buf[4:]
            continue
        if n != header["samples"]:
            raise StreamError(f"frame {seq} has {n} samples, the header said {header['samples']}")
        if not fill(12 + 2 * n):
            return
        pcm = buf[12:12 + 2 * n]
        buf = buf[12 + 2 * n:]
        yield ("window", seq, pcm)


def expected_hash(contract_path):
    """The sensor path hash the design has now: model.data.pathHash, else the firmware build's stamp."""
    c = json.loads(Path(contract_path).read_text())
    values = c.get("values", c)
    data = (values.get("model") or {}).get("data")
    if data:
        return data["pathHash"]
    return None


def record(read, out, label, windows, want_hash=None):
    out = Path(out)
    manifest_path = out / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else None
    header = None
    saved = 0
    for item in frames(read):
        if item[0] == "header":
            h = item[1]
            if want_hash and h["pathHash"] != want_hash:
                raise StreamError(f"the board streams sensor path {h['pathHash']} (rev {h['revision']}), the design is at {want_hash}: flash the data-collection firmware built from the current design")
            if manifest and manifest["pathHash"] != h["pathHash"]:
                raise StreamError(f"{out} holds data from sensor path {manifest['pathHash']} (rev {manifest['revision']}); this board streams {h['pathHash']} (rev {h['revision']}): record into a new folder, it is a different dataset")
            if manifest is None:
                manifest = {"pathHash": h["pathHash"], "revision": h["revision"], "sensor": h["sensor"], "rateHz": h["rateHz"], "channels": h["channels"], "bits": h["bits"], "samplesPerClip": h["samples"], "clips": []}
            header = h
            continue
        _, seq, pcm = item
        clip = out / label / f"{header['revision']}-{seq:06d}.wav"
        clip.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(clip), "wb") as w:
            w.setnchannels(header["channels"])
            w.setsampwidth(header["bits"] // 8)
            w.setframerate(header["rateHz"])
            w.writeframes(pcm)
        manifest["clips"].append({"file": str(clip.relative_to(out)), "label": label, "revision": header["revision"], "seq": seq})
        saved += 1
        out.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
        if saved >= windows:
            break
    if header is None:
        raise StreamError("no BRINGUP-COLLECT header in the stream: is the data-collection firmware flashed?")
    return manifest, saved


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--port")
    src.add_argument("--input")
    ap.add_argument("--baud", type=int, default=921600)
    ap.add_argument("--label", required=True)
    ap.add_argument("--windows", type=int, default=10)
    ap.add_argument("--out", required=True)
    ap.add_argument("--contract")
    a = ap.parse_args()
    want = expected_hash(a.contract) if a.contract else None
    if a.port:
        import serial  # pyserial, installed with PlatformIO

        port = serial.Serial(a.port, a.baud, timeout=5)
        read = port.read
    else:
        f = open(a.input, "rb")
        read = f.read
    try:
        manifest, saved = record(read, a.out, a.label, a.windows, want)
    except StreamError as e:
        print(f"collect: {e}", file=sys.stderr)
        sys.exit(1)
    print(f"collect: {saved} clip(s) of '{a.label}' on sensor path {manifest['pathHash']} (rev {manifest['revision']}), {len(manifest['clips'])} in {a.out}")


if __name__ == "__main__":
    main()
