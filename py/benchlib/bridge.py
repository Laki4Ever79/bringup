"""The bench bridge: owns every bench port and speaks JSON lines to Node (docs/design/bench.md §3b)."""

from __future__ import annotations

import json
import os
import queue
import tempfile
import threading
import time
from typing import Any, Callable, TextIO

from benchlib import ports as port_scan
from benchlib.fakedut import FakeDut
from benchlib.flash import bench_pin_conflicts, flash, read_firmware_info, stage_build_dir
from benchlib.transport import FakeHal, LineTransport, MockTransport, SerialTransport

EN_PIN, BOOT_PIN, MODE_PIN = 10, 11, 12  # fixture GP10/GP11/GP12 → DUT EN / GPIO0 / GPIO4
STREAM_HZ = 60  # faster than the INA226's 17.6 ms conversions, so every one is read
RECOVER_WAIT_S = 3.0
TELEMETRY_BAUD = 115200


def now_ms() -> int:
    return int(time.time() * 1000)


class Out:
    """stdout plus the --out recording. Thread-safe; every line gets `at`."""

    def __init__(self, stream: TextIO, out_dir: str | None):
        self.stream = stream
        self.lock = threading.Lock()
        self.jsonl = self.csv = None
        self.closed = False
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
            self.jsonl = open(os.path.join(out_dir, "bench.jsonl"), "a", buffering=1)
            self.csv = open(os.path.join(out_dir, "power.csv"), "a", buffering=1)
            if self.csv.tell() == 0:
                self.csv.write("at,mA\n")

    def emit(self, obj: dict[str, Any]) -> None:
        obj.setdefault("at", now_ms())
        line = json.dumps(obj, separators=(",", ":"))
        with self.lock:
            if self.closed:
                return  # after bye: stray lines from the stream threads are dropped
            try:
                self.stream.write(line + "\n")
                self.stream.flush()
            except (BrokenPipeError, ValueError):
                os._exit(0)  # Node went away
            if self.jsonl and obj["k"] != "ack":
                self.jsonl.write(line + "\n")
            if self.csv and obj["k"] == "i":
                self.csv.write(f"{obj['at']},{obj['mA']}\n")

    def close(self) -> None:
        with self.lock:
            self.closed = True
            for f in (self.jsonl, self.csv):
                if f:
                    f.close()


def dut_line(text: str) -> dict[str, Any]:
    """A DUT serial line as a protocol line: JSON objects with k pass through, anything else is text."""
    text = text.strip()
    if text.startswith("{"):
        try:
            obj = json.loads(text)
            if isinstance(obj, dict) and isinstance(obj.get("k"), str) and obj["k"] not in ("hello", "ack", "bye", "i", "flashing", "error"):
                return obj
        except json.JSONDecodeError:
            pass
    return {"k": "text", "text": text}


class FixtureLink:
    """One thread owns the fixture transport: it writes requests, matches replies by id and turns stream samples
    into meter lines. (hw_agent's FixtureClient reads replies inline, which can't share a port with a stream.)"""

    def __init__(self, transport: LineTransport, on_sample: Callable[[dict], None], on_error: Callable[[str], None]):
        self.t = transport
        self.on_sample = on_sample
        self.on_error = on_error
        self.requests: queue.Queue = queue.Queue()
        self.waiting: dict[int, queue.Queue] = {}
        self.ids = 0
        self.stopped = False
        threading.Thread(target=self._run, daemon=True).start()

    def request(self, cmd: str, timeout: float = 1.0, **params: Any) -> dict[str, Any]:
        self.ids += 1
        rid = self.ids
        box: queue.Queue = queue.Queue()
        self.waiting[rid] = box
        self.requests.put(json.dumps({"id": rid, "cmd": cmd, **params}))
        try:
            reply = box.get(timeout=timeout)
        except queue.Empty:
            raise TimeoutError(f"fixture did not answer {cmd!r} within {timeout}s") from None
        finally:
            self.waiting.pop(rid, None)
        if not reply.get("ok"):
            raise RuntimeError(f"fixture {cmd}: {reply.get('err', reply)}")
        return reply

    def gpio(self, pin: int, value: int, mode: str = "od") -> None:
        self.request("gpio.set", pin=pin, value=value, mode=mode)

    def stop(self) -> None:
        self.stopped = True

    def _run(self) -> None:
        while not self.stopped:
            try:
                while not self.requests.empty():
                    self.t.write_line(self.requests.get_nowait())
                line = self.t.read_line(0.01)
            except Exception as e:  # the port vanished
                self.on_error(str(e))
                return
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue  # REPL noise, boot banners
            if msg.get("event") == "sample":
                self.on_sample(msg)
            elif msg.get("event") == "fault":
                self.on_error(f"fixture fault: {msg}")
            elif msg.get("id") in self.waiting:
                self.waiting[msg["id"]].put(msg)


class FakeBenchHal(FakeHal):
    """The fixture's view of the fake bench: its GPIOs reach the fake DUT, and the INA226 reads the DUT's current."""

    def __init__(self, dut_box: dict, lock: threading.Lock):
        super().__init__(psu_v=5.25)
        self.dut_box = dut_box
        self.lock = lock

    def set_pin(self, pin: int, value: int, mode: str) -> None:
        released = pin == EN_PIN and value == 1 and self.pins.get(EN_PIN, 1) == 0
        super().set_pin(pin, value, mode)
        if released:
            with self.lock:
                self.dut_box["dut"].reset(int(time.monotonic() * 1000))

    def ina226_read(self) -> dict:
        with self.lock:
            i = self.dut_box["dut"].current_ma(int(time.monotonic() * 1000)) / 1000
        return {"bus_v": self.psu_v, "shunt_mv": round(i * 100, 4), "current_a": round(i, 6), "power_w": round(self.psu_v * i, 5)}


class Bridge:
    def __init__(self, source: str, out: Out, pio: str, fake_speed: float = 1.0, replay: str | None = None, work_dir: str | None = None):
        self.source = source
        # One persistent build dir for every flash, so pio rebuilds incrementally (bench.md §7).
        self.work_dir = work_dir or tempfile.mkdtemp(prefix="bench-fw-")
        self.out = out
        self.pio = pio
        self.fake_speed = fake_speed
        self.replay_path = replay
        self.fixture: FixtureLink | None = None
        self.meter = False
        self.ports: dict[str, str | None] = {"dut": None, "fixture": None, "telemetry": None}
        self.stopped = threading.Event()
        self.clock_offset: int | None = None
        self.lock = threading.Lock()
        self.dut_box: dict = {}
        self.threads: list[tuple[Callable, tuple]] = []

    # ---- start -------------------------------------------------------------------
    def start(self) -> None:
        if self.source == "real":
            self._start_real()
        elif self.source == "fake":
            self._start_fake()
        else:
            self._start_replay()
        # hello is always the first line: nothing streams until it is out.
        self.out.emit({"k": "hello", "source": self.source, "ports": dict(self.ports), "meter": self.meter})
        if self.fixture and self.meter:
            self.fixture.request("stream", what=["ina226"], hz=STREAM_HZ)
        for target, args in self.threads:
            threading.Thread(target=target, args=args, daemon=True).start()

    def _start_real(self) -> None:
        self.ports = port_scan.scan()
        if self.ports["fixture"]:
            try:
                self._attach_fixture(SerialTransport(self.ports["fixture"]))
            except Exception as e:
                self.out.emit({"k": "error", "where": "fixture", "error": str(e)})
        if self.ports["telemetry"]:
            self.threads.append((self._read_telemetry, (self.ports["telemetry"],)))

    def _start_fake(self) -> None:
        pins = FakeBenchHal(self.dut_box, self.lock)
        self.dut_box["dut"] = FakeDut(pins.pins, int(time.monotonic() * 1000))
        self.ports = {"dut": "fake:dut", "fixture": "fake:fixture", "telemetry": "fake:telemetry"}
        self._attach_fixture(MockTransport(pins))
        self.threads.append((self._run_fake_dut, ()))

    def _start_replay(self) -> None:
        with open(self.replay_path or "") as f:
            self.recording = [json.loads(line) for line in f if line.strip()]
        self.recording = [m for m in self.recording if m.get("k") not in ("hello", "ack", "bye")]
        self.meter = any(m.get("k") == "i" for m in self.recording)
        self.threads.append((self._play, ()))

    def _attach_fixture(self, transport: LineTransport) -> None:
        def on_error(msg: str) -> None:
            self.out.emit({"k": "error", "where": "fixture", "error": msg})

        self.fixture = FixtureLink(transport, self._on_sample, on_error)
        self.fixture.request("hello", timeout=2.0)
        self.meter = not self.fixture.request("ina226.read").get("missing", False)

    def _on_sample(self, sample: dict) -> None:
        # Fixture time keeps the 60 Hz spacing exact; it is pinned to host time at the first sample.
        if self.clock_offset is None:
            self.clock_offset = now_ms() - sample["t_ms"]
        self.out.emit({"k": "i", "at": sample["t_ms"] + self.clock_offset, "mA": round(sample["ina226"]["current_a"] * 1000, 3)})

    # ---- DUT telemetry -------------------------------------------------------------
    def _read_telemetry(self, port: str) -> None:
        import serial

        while not self.stopped.is_set():
            try:
                with serial.Serial(port, TELEMETRY_BAUD, timeout=0.2) as ser:
                    while not self.stopped.is_set():
                        raw = ser.readline()
                        if raw:
                            self.out.emit(dut_line(raw.decode(errors="replace")))
            except Exception as e:
                self.out.emit({"k": "error", "where": "telemetry", "error": str(e)})
                self.stopped.wait(2.0)

    def _run_fake_dut(self) -> None:
        while not self.stopped.is_set():
            with self.lock:
                dut = self.dut_box["dut"]
                dut.step(int(time.monotonic() * 1000))
                lines = dut.drain_lines()
            for line in lines:
                self.out.emit(dut_line(line))
            time.sleep(0.005)

    def _play(self) -> None:
        if not self.recording:
            return
        while not self.stopped.is_set():
            t0, start = self.recording[0]["at"], now_ms()
            for m in self.recording:
                if self.stopped.wait(max(0.0, (start + m["at"] - t0 - now_ms()) / 1000)):
                    return
                self.out.emit({**m, "at": now_ms()})
            self.stopped.wait(1.0)

    # ---- commands --------------------------------------------------------------------
    def handle(self, req: dict[str, Any]) -> bool:
        """Runs one command and acks it. Returns False on quit."""
        rid, cmd = req.get("id"), req.get("cmd")
        try:
            handler = getattr(self, f"cmd_{cmd}", None) if isinstance(cmd, str) else None
            result = handler(rid, req) if handler else {"ok": False, "error": f"unknown command {cmd!r}"}
        except Exception as e:
            result = {"ok": False, "error": str(e)}
        self.out.emit({"k": "ack", "id": rid, **result})
        return cmd != "quit"

    def cmd_quit(self, rid, req) -> dict:
        return {"ok": True}

    def cmd_ports(self, rid, req) -> dict:
        if self.source == "real":
            self.ports = port_scan.scan()
        return {"ok": True, "ports": dict(self.ports)}

    def cmd_flash(self, rid, req) -> dict:
        fw_dir, env = req["dir"], req.get("env", "esp32s3_bench")

        def progress(e: dict) -> None:
            self.out.emit({"k": "flashing", "id": rid, **e})

        if self.source == "replay":
            return {"ok": True, "simulated": True, "ms": 0}
        try:
            conflicts = bench_pin_conflicts(fw_dir)
        except FileNotFoundError:
            return {"ok": False, "stage": "build", "error": f"{fw_dir}/include/pins.h not found", "ms": 0}
        if conflicts:
            return {"ok": False, "stage": "build", "error": "; ".join(conflicts), "ms": 0}
        if self.source == "fake":
            return self._fake_flash(fw_dir, progress)
        stage_build_dir(fw_dir, self.work_dir)
        return flash(self.work_dir, env, port=lambda: port_scan.scan()["dut"], recover=self._recover, on_progress=progress, pio=self.pio)

    def _fake_flash(self, fw_dir: str, progress: Callable[[dict], None]) -> dict:
        start = time.monotonic()
        progress({"stage": "build", "pct": 0})
        try:
            info = read_firmware_info(fw_dir)
        except FileNotFoundError:
            return {"ok": False, "stage": "build", "error": f"{fw_dir}/include/pins.h not found", "ms": 0}
        time.sleep(2.0 / self.fake_speed)
        progress({"stage": "connect", "pct": 0})
        time.sleep(0.3 / self.fake_speed)
        for pct in range(0, 101, 10):
            progress({"stage": "write", "pct": pct})
            time.sleep(0.2 / self.fake_speed)
        with self.lock:
            self.dut_box["dut"].flash(info, int(time.monotonic() * 1000))
        return {"ok": True, "ms": int((time.monotonic() - start) * 1000)}

    def _need_fixture(self) -> FixtureLink:
        if not self.fixture:
            raise RuntimeError("no fixture: EN/BOOT/mode need the RP2350 (2e8a:0005)")
        return self.fixture

    def _pulse_en(self, fx: FixtureLink) -> None:
        fx.gpio(EN_PIN, 0)
        time.sleep(0.1)
        fx.gpio(EN_PIN, 1)

    def _dut_port_present(self) -> bool:
        if self.source == "fake":
            with self.lock:
                dut = self.dut_box["dut"]
                return dut.download_mode or dut.mode == "live" or dut.awake
        return port_scan.scan()["dut"] is not None

    def _recover(self) -> bool:
        """BOOT low through an EN pulse: the ROM bootloader starts and its USB port enumerates, even from deep sleep.
        Without a fixture there is nothing to pulse: False, so a flash fails cleanly instead of raising."""
        if not self.fixture:
            return False
        fx = self.fixture
        fx.gpio(BOOT_PIN, 0)
        self._pulse_en(fx)
        time.sleep(0.05)
        fx.gpio(BOOT_PIN, 1)
        end = time.monotonic() + RECOVER_WAIT_S
        while time.monotonic() < end:
            if self._dut_port_present():
                return True
            time.sleep(0.1)
        return False

    def cmd_recover(self, rid, req) -> dict:
        if self.source == "replay":
            return {"ok": True, "simulated": True}
        self._need_fixture()
        return {"ok": True} if self._recover() else {"ok": False, "error": f"no 303a:1001 port within {RECOVER_WAIT_S:.0f} s of BOOT+EN"}

    def cmd_reset(self, rid, req) -> dict:
        if self.source == "replay":
            return {"ok": True, "simulated": True}
        fx = self._need_fixture()
        fx.gpio(BOOT_PIN, 1)
        self._pulse_en(fx)
        return {"ok": True}

    def cmd_mode(self, rid, req) -> dict:
        mode = req.get("mode")
        if mode not in ("live", "duty"):
            return {"ok": False, "error": "mode must be live or duty"}
        if self.source == "replay":
            return {"ok": True, "simulated": True}
        self._need_fixture().gpio(MODE_PIN, 1 if mode == "duty" else 0, "pp")
        return self.cmd_reset(rid, req)

    # ---- main loop -------------------------------------------------------------------
    def serve(self, stdin: TextIO) -> None:
        for line in stdin:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except json.JSONDecodeError:
                self.out.emit({"k": "ack", "id": None, "ok": False, "error": "bad JSON"})
                continue
            if not self.handle(req):
                break
        self.stopped.set()
        if self.fixture:
            self.fixture.stop()
        self.out.emit({"k": "bye"})
        self.out.close()
