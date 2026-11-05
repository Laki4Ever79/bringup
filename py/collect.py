"""Records the data-collection firmware's stream (templates/fw/src/collect.cpp) into a dataset for one sensor path.

    .venv/bin/python py/collect.py --port /dev/ttyACM0 --label hey_bringup --windows 50 --out data/wake [--contract out/run/contract.json]

Each window becomes <out>/<label>/<n>.wav (16-bit PCM; n counts up across sessions, so a second session never
overwrites the first). <out>/manifest.json records the sensor path hash, the contract revision, the stream's format
and every clip. A dataset belongs to one sensor path and one window length: a board whose path hash or window differs
from the manifest's is refused, because that is a different dataset. With --contract, the stream must also match the
path the design has now: the contract's model.data.pathHash, else the collect.json `bringup collect-firmware` wrote
beside it. Data is never recorded on an outdated board.

Frames whose bytes don't line up (a dropped chunk) are dropped, not saved; gaps in the firmware's window numbers
are counted. Windows the firmware flagged as silent (a dead or unwired microphone) are kept, marked silent.

--input FILE reads a captured stream instead of a serial port (tests, replays).
"""

import argparse
import json
import re
import struct
import sys
import time
import wave
from pathlib import Path

MAGIC = b"BRW1"
LINE = b"BRINGUP-COLLECT"
HEADER = re.compile(rb"BRINGUP-COLLECT rev=(\d+) path=([0-9a-f]{12}) sensor=(\w+) rate=(\d+) channels=(\d+) bits=(\d+) samples=(\d+)\r?\n")
SILENT = re.compile(rb"BRINGUP-COLLECT WARN silent seq=(\d+) peak-to-peak=(-?\d+)\r?\n")
FAIL = re.compile(rb"BRINGUP-COLLECT FAIL ([^\r\n]*)\r?\n")


class StreamError(Exception):
    pass


def frames(read):
    """Yields ("header", dict), ("silent", seq), ("window", seq, pcm) and ("dropped", reason) from read(n) -> bytes
    (b"" at the end of the stream)."""
    buf = b""
    header = None
    ended = False

    def fill(n):
        nonlocal buf, ended
        while len(buf) < n and not ended:
            chunk = read(max(n - len(buf), 4096))
            if not chunk:
                ended = True
                break
            buf += chunk
        return len(buf) >= n

    while True:
        # The next record starts at the earliest BRW1 or BRINGUP-COLLECT; anything before it (boot log) is skipped.
        fill(len(LINE))
        cands = [i for i in (buf.find(MAGIC), buf.find(LINE)) if i >= 0]
        if not cands:
            if ended:
                return
            buf = buf[-(len(LINE) - 1):]
            fill(len(buf) + 4096)
            continue
        buf = buf[min(cands):]
        if buf.startswith(LINE):
            # A text line: wait for its end, then parse it.
            while b"\n" not in buf and fill(len(buf) + 1):
                pass
            if b"\n" not in buf:
                return
            line, buf = buf[: buf.index(b"\n") + 1], buf[buf.index(b"\n") + 1:]
            if m := HEADER.match(line):
                rev, path, sensor, rate, channels, bits, samples = m.groups()
                header = {"revision": int(rev), "pathHash": path.decode(), "sensor": sensor.decode(), "rateHz": int(rate), "channels": int(channels), "bits": int(bits), "samples": int(samples)}
                yield ("header", header)
            elif m := SILENT.match(line):
                yield ("silent", int(m.group(1)))
            elif m := FAIL.match(line):
                raise StreamError(f"the firmware reports: {m.group(1).decode(errors='replace')}")
            continue
        # A frame: magic, seq, samples, then the samples.
        if not fill(12):
            return
        seq, n = struct.unpack_from("<II", buf, 4)
        if header is None or n != header["samples"]:
            # Before any header it can't be attributed to a sensor path; a wrong length is a stray magic in audio
            # bytes. Either way, skip past this magic and look for the next record.
            if header is not None:
                yield ("dropped", f"a frame header claiming {n} samples (the stream sends {header['samples']})")
            buf = buf[4:]
            continue
        end = 12 + 2 * n
        if not fill(end):
            return
        # The bytes after a whole frame must start the next record; if not, bytes were lost inside this one.
        fill(end + 4)
        nxt = buf[end:end + 4]
        if len(nxt) == 4 and nxt not in (MAGIC, LINE[:4]):
            yield ("dropped", f"window {seq}: its bytes don't line up with the next record (data lost in transit)")
            buf = buf[4:]
            continue
        pcm = buf[12:end]
        buf = buf[end:]
        yield ("window", seq, pcm)


def expected_hash(contract_path):
    """The sensor path hash the design has now: the contract's model.data.pathHash, else collect.json beside it."""
    c = json.loads(Path(contract_path).read_text())
    values = c.get("values", c)
    data = (values.get("model") or {}).get("data")
    if data:
        return data["pathHash"]
    beside = Path(contract_path).parent / "collect.json"
    if beside.exists():
        return json.loads(beside.read_text())["pathHash"]
    raise StreamError(f"{contract_path} gives no sensor path to check the board against: run `npm run bringup -- collect-firmware {Path(contract_path).parent}` first")


def next_index(folder):
    nums = [int(p.stem) for p in folder.glob("*.wav") if p.stem.isdigit()] if folder.exists() else []
    return max(nums, default=-1) + 1


def record(read, out, label, windows, want_hash=None, log=lambda msg: print(msg, file=sys.stderr)):
    """Records up to `windows` clips. Returns (manifest, saved, report) where report counts dropped frames, gaps in
    the firmware's window numbers and silent windows."""
    out = Path(out)
    manifest_path = out / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else None
    header = None
    saved = 0
    report = {"dropped": 0, "gaps": 0, "silent": 0}
    last_seq = None
    silent = set()
    session = time.strftime("%Y%m%dT%H%M%S")
    for item in frames(read):
        kind = item[0]
        if kind == "header":
            h = item[1]
            if want_hash and h["pathHash"] != want_hash:
                raise StreamError(f"the board streams sensor path {h['pathHash']} (rev {h['revision']}), the design is at {want_hash}: flash the data-collection firmware built from the current design")
            if manifest and manifest["pathHash"] != h["pathHash"]:
                raise StreamError(f"{out} holds data from sensor path {manifest['pathHash']} (rev {manifest['revision']}); this board streams {h['pathHash']} (rev {h['revision']}): record into a new folder, it is a different dataset")
            if manifest and (manifest["samplesPerClip"], manifest["rateHz"], manifest["channels"], manifest["bits"]) != (h["samples"], h["rateHz"], h["channels"], h["bits"]):
                raise StreamError(f"{out} holds {manifest['samplesPerClip']}-sample clips at {manifest['rateHz']} Hz; this board sends {h['samples']} at {h['rateHz']} Hz: record into a new folder, it is a different dataset")
            if manifest is None:
                manifest = {"pathHash": h["pathHash"], "revision": h["revision"], "sensor": h["sensor"], "rateHz": h["rateHz"], "channels": h["channels"], "bits": h["bits"], "samplesPerClip": h["samples"], "clips": []}
            header = h
        elif kind == "silent":
            silent.add(item[1])
        elif kind == "dropped":
            report["dropped"] += 1
            log(f"collect: dropped {item[1]}")
        elif kind == "window" and header is not None:
            _, seq, pcm = item
            if last_seq is not None and seq > last_seq + 1:
                report["gaps"] += seq - last_seq - 1
            last_seq = seq
            folder = out / label
            folder.mkdir(parents=True, exist_ok=True)
            clip = folder / f"{next_index(folder):06d}.wav"
            with wave.open(str(clip), "wb") as w:
                w.setnchannels(header["channels"])
                w.setsampwidth(header["bits"] // 8)
                w.setframerate(header["rateHz"])
                w.writeframes(pcm)
            entry = {"file": str(clip.relative_to(out)), "label": label, "revision": header["revision"], "session": session, "seq": seq}
            if seq in silent:
                entry["silent"] = True
                report["silent"] += 1
            manifest["clips"].append(entry)
            saved += 1
            manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
            if saved >= windows:
                break
    if header is None:
        raise StreamError("no BRINGUP-COLLECT header in the stream: is the data-collection firmware flashed?")
    return manifest, saved, report


def serial_reader(port, idle_s):
    """read(n) on a serial port that waits through quiet spells (boot, re-enumeration) and ends after idle_s of no data."""
    last = time.monotonic()

    def read(n):
        nonlocal last
        while True:
            chunk = port.read(n)
            if chunk:
                last = time.monotonic()
                return chunk
            if time.monotonic() - last > idle_s:
                return b""

    return read


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
    ap.add_argument("--idle-timeout", type=float, default=30.0, help="seconds without data before giving up (serial)")
    a = ap.parse_args()
    try:
        want = expected_hash(a.contract) if a.contract else None
        if a.port:
            import serial  # pyserial, installed with PlatformIO

            read = serial_reader(serial.Serial(a.port, a.baud, timeout=1), a.idle_timeout)
        else:
            read = open(a.input, "rb").read
        manifest, saved, report = record(read, a.out, a.label, a.windows, want)
    except StreamError as e:
        print(f"collect: {e}", file=sys.stderr)
        sys.exit(1)
    extra = ", ".join(f"{v} {k}" for k, v in report.items() if v)
    print(f"collect: {saved} clip(s) of '{a.label}' on sensor path {manifest['pathHash']} (rev {manifest['revision']}), {len(manifest['clips'])} in {a.out}{f'; {extra}' if extra else ''}")
    if saved < a.windows:
        print(f"collect: asked for {a.windows} windows, the stream ended after {saved}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
