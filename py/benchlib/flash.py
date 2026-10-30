"""Builds and uploads the bench firmware with PlatformIO, reporting progress and recovering a sleeping board once."""

from __future__ import annotations

import os
import re
import subprocess
import threading
import time
from typing import Callable

BUILD_TIMEOUT_S = 600
UPLOAD_TIMEOUT_S = 60
TAIL_LINES = 40
# The app image starts at 0x10000; bootloader and partition table writes before it are too short to show.
APP_OFFSET = 0x10000

WRITING = re.compile(r"Writing at 0x([0-9a-fA-F]+)\.*\s*\(\s*(\d+)\s*%\)")  # esptool 4: "(37 %)"
# esptool 5 draws a bar, and its address is where the write ends, so only bars after the app's header count.
BAR = re.compile(r"Writing at 0x[0-9a-fA-F]+ .*?(\d+(?:\.\d+)?)%")
APP_HEADER = re.compile(r"Writing '[^']+' at 0x([0-9a-fA-F]+)")
CONNECT_MARKERS = ("Uploading", "Connecting", "Serial port ")
DIALOUT_FIX = "run `sudo usermod -aG dialout $USER` and log in again (or install hw_agent's udev/99-bench.rules)"


class FlashProgress:
    """Turns pio/esptool output into {stage, pct} events: build, connect, then the app write in >=10 % steps."""

    def __init__(self) -> None:
        self.stage: str | None = None
        self.pct = -1
        self.app = False  # esptool 5: the app image's header has been seen

    def feed(self, line: str) -> list[dict]:
        out = []
        if self.stage is None:
            self.stage = "build"
            out.append({"stage": "build", "pct": 0})
        if self.stage == "build" and line.startswith(CONNECT_MARKERS):
            self.stage = "connect"
            out.append({"stage": "connect", "pct": 0})
        header = APP_HEADER.search(line)
        if header:
            self.app = int(header.group(1), 16) >= APP_OFFSET
        m, bar = WRITING.search(line), BAR.search(line)
        pct = None
        if m and int(m.group(1), 16) >= APP_OFFSET:
            pct = int(m.group(2))
        elif bar and not m and self.app:
            pct = int(float(bar.group(1)))
        if pct is not None:
            if self.stage != "write" or pct - self.pct >= 10 or (pct == 100 and self.pct != 100):
                self.stage, self.pct = "write", pct
                out.append({"stage": "write", "pct": pct})
        return out

    def failure_stage(self, output: str) -> str:
        if "Permission denied" in output:
            return "permission"
        if self.stage in ("connect", "write"):
            return self.stage
        return "build"


def read_firmware_info(fw_dir: str) -> dict:
    """The revision and LED behaviour a firmware dir was generated with (include/pins.h, include/behavior.h)."""
    with open(os.path.join(fw_dir, "include/pins.h")) as f:
        m = re.search(r"^#define BRINGUP_REVISION (\d+)", f.read(), re.M)
    info = {"rev": int(m.group(1)) if m else None, "blinkMs": 1000, "tiltBlinkMs": 1000, "tiltDeg": 90}
    path = os.path.join(fw_dir, "include/behavior.h")
    if os.path.exists(path):
        with open(path) as f:
            defines = dict(re.findall(r"^#define BEHAVIOR_(\w+) (\d+)", f.read(), re.M))
        for key, macro in (("blinkMs", "BLINK_MS"), ("tiltBlinkMs", "TILT_BLINK_MS"), ("tiltDeg", "TILT_DEG")):
            if macro in defines:
                info[key] = int(defines[macro])
    return info


# GPIOs the contract may not use on the bench's ESP32-S3 (YD-ESP32-S3 N16R8), and why.
BENCH_RESERVED = {
    0: "BOOT (driven by the fixture)",
    4: "BENCH_MODE (fixture GP12)",
    17: "telemetry TX (UART1 → CP2102)",
    19: "native USB D−",
    20: "native USB D+",
    35: "octal PSRAM",
    36: "octal PSRAM",
    37: "octal PSRAM",
    48: "the onboard RGB LED (the bench's status light)",
}
S3_GPIOS = set(range(0, 22)) | set(range(26, 49))


def bench_pin_conflicts(fw_dir: str) -> list[str]:
    """Contract pins the bench can't give the design: ones it wires itself, or ones the S3 module reserves."""
    with open(os.path.join(fw_dir, "include/pins.h")) as f:
        pins = re.findall(r"^#define PIN_(\w+) (-?\d+)", f.read(), re.M)
    out = []
    for name, gpio in pins:
        g = int(gpio)
        if g in BENCH_RESERVED:
            out.append(f"{name} uses GPIO{g}, which is {BENCH_RESERVED[g]} on the bench")
        elif g not in S3_GPIOS:
            out.append(f"{name} uses GPIO{g}, which the ESP32-S3 does not have")
    return out


def stage_build_dir(src: str, work: str) -> None:
    """Copies a firmware dir into one persistent work dir, writing only files whose content changed. The work
    dir keeps .pio, so a behavior change recompiles one file (~10 s) instead of the whole core (~30 s)."""
    for dirpath, dirnames, filenames in os.walk(src):
        dirnames[:] = [d for d in dirnames if d != ".pio"]
        rel = os.path.relpath(dirpath, src)
        os.makedirs(os.path.join(work, rel), exist_ok=True)
        for name in filenames:
            with open(os.path.join(dirpath, name), "rb") as f:
                data = f.read()
            dest = os.path.join(work, rel, name)
            if os.path.exists(dest):
                with open(dest, "rb") as f:
                    if f.read() == data:
                        continue
            with open(dest, "wb") as f:
                f.write(data)


def run_pio(cmd: list[str], on_line: Callable[[str], None], too_long: Callable[[], bool]) -> int | None:
    """Runs pio, feeding each output line to on_line. Returns the exit code, or None if too_long() killed it."""
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace")
    killed = threading.Event()

    def watchdog() -> None:
        while proc.poll() is None:
            if too_long():
                killed.set()
                proc.kill()
                return
            time.sleep(0.5)

    threading.Thread(target=watchdog, daemon=True).start()
    assert proc.stdout is not None
    for line in proc.stdout:
        on_line(line.rstrip("\n"))
    code = proc.wait()
    return None if killed.is_set() else code


def flash(
    fw_dir: str,
    env: str,
    port: Callable[[], str | None],
    recover: Callable[[], bool],
    on_progress: Callable[[dict], None],
    pio: str,
    run: Callable[[list[str], Callable[[str], None]], int | None] | None = None,
) -> dict:
    """Uploads fw_dir's env to the DUT. A failed connect (often a board in deep sleep, whose USB is off) gets one
    BOOT+EN recovery and one retry. Returns {ok, ms} or {ok: False, stage, error}."""
    start = time.monotonic()
    p = port()
    if p is None and not (recover() and (p := port())):
        return {"ok": False, "stage": "connect", "error": "no ESP32-S3 USB port (303a:1001) found, even after BOOT+EN recovery", "ms": _ms(start)}

    for attempt in (1, 2):
        progress = FlashProgress()
        tail: list[str] = []
        connect_at: list[float] = []

        def on_line(line: str) -> None:
            tail.append(line)
            del tail[:-TAIL_LINES]
            for e in progress.feed(line):
                if e["stage"] == "connect":
                    connect_at.append(time.monotonic())
                on_progress(e)

        def too_long() -> bool:
            now = time.monotonic()
            return now - start > BUILD_TIMEOUT_S or bool(connect_at and now - connect_at[0] > UPLOAD_TIMEOUT_S)

        cmd = [pio, "run", "-d", fw_dir, "-e", env, "-t", "upload", "--upload-port", p]
        code = run(cmd, on_line) if run else run_pio(cmd, on_line, too_long)
        if code == 0:
            return {"ok": True, "ms": _ms(start), "port": p}
        text = "\n".join(tail)
        stage = "timeout" if code is None else progress.failure_stage(text)
        if stage == "connect" and attempt == 1 and recover():
            p = port() or p
            continue
        if stage == "permission":
            error = f"permission denied on {p}: {DIALOUT_FIX}"
        elif stage == "timeout":
            error = f"pio did not finish within {UPLOAD_TIMEOUT_S} s of connecting (or {BUILD_TIMEOUT_S} s in all)"
        else:
            error = "\n".join(tail[-15:])
        return {"ok": False, "stage": stage, "error": error, "ms": _ms(start)}
    raise AssertionError("unreachable")


def _ms(start: float) -> int:
    return int((time.monotonic() - start) * 1000)
