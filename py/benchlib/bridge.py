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
from benchlib.telemetry import TelemetryReader, dut_line
from benchlib.transport import FakeHal, LineTransport, MockTransport, SerialTransport

EN_PIN, BOOT_PIN, MODE_PIN = 10, 11, 12  # fixture GP10/GP11/GP12 → DUT EN / GPIO0 / GPIO4
STREAM_HZ = 60  # faster than the INA226's 17.6 ms conversions, so every one is read
RECOVER_WAIT_S = 3.0
BOOT_WAIT_S = 8.0  # after a flash: how long the new firmware gets to say boot before someone is asked to tap RST
HUMAN_WAIT_S = 180.0  # how long an instruction waits for the person at the desk
ASK_BOOT_RESET = "Put the S3 into flashing mode: hold BOOT, tap RST, release BOOT."
ASK_RESET = "Tap RST once on the S3 to start the new firmware."


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
    def __init__(self, source: str, out: Out, pio: str, fake_speed: float = 1.0, replay: str | None = None, work_dir: str | None = None, no_meter: bool = False, no_imu: bool = False, fake_factory: bool = False):
        self.source = source
        self.no_meter = no_meter  # fake only: a tier-1 bench, the S3 alone with no fixture or INA226
        self.no_imu = no_imu  # fake only: no MPU-6050 on the S3's I2C
        self.fake_factory = fake_factory  # fake only: the S3 still runs its shipped demo
        self.rev_seen: dict[int, float] = {}  # firmware revision -> when a line from it last arrived (monotonic)
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
        self.telemetry: TelemetryReader | None = None

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
            self.telemetry = TelemetryReader(self.ports["telemetry"], self._dut_line)
            self.threads.append((self.telemetry._run, ()))

    def _start_fake(self) -> None:
        self.threads.append((self._run_fake_dut, ()))
        if self.no_meter:
            # Nothing drives the DUT's EN, BOOT or mode pins: they stay at their pull-ups/pull-downs.
            self.dut_box["dut"] = FakeDut({}, int(time.monotonic() * 1000), imu=not self.no_imu, factory=self.fake_factory)
            self.ports = {"dut": "fake:dut", "fixture": None, "telemetry": "fake:telemetry"}
            return
        pins = FakeBenchHal(self.dut_box, self.lock)
        self.dut_box["dut"] = FakeDut(pins.pins, int(time.monotonic() * 1000), imu=not self.no_imu, factory=self.fake_factory)
        self.ports = {"dut": "fake:dut", "fixture": "fake:fixture", "telemetry": "fake:telemetry"}
        self._attach_fixture(MockTransport(pins))

    def _start_replay(self) -> None:
        with open(self.replay_path or "") as f:
            self.recording = [json.loads(line) for line in f if line.strip()]
        # Command replies and progress belong to the recorded session's command ids, not to this one's.
        self.recording = [m for m in self.recording if m.get("k") not in ("hello", "ack", "flashing", "bye")]
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
    def _dut_line(self, obj: dict) -> None:
        """Every DUT line passes here: it notes which firmware revision is talking, then goes out."""
        if obj.get("k") in ("boot", "s", "cycle", "err") and isinstance(obj.get("rev"), int):
            self.rev_seen[obj["rev"]] = time.monotonic()
        self.out.emit(obj)

    # ---- the person at the desk ------------------------------------------------------
    def _ask(self, rid, action: str, text: str, done: Callable[[], bool]) -> bool:
        """Tells the person what to do, then waits until done() or HUMAN_WAIT_S. Both ends are protocol lines."""
        self.out.emit({"k": "instruct", "id": rid, "action": action, "text": text})
        end = time.monotonic() + HUMAN_WAIT_S
        ok = False
        while time.monotonic() < end and not self.stopped.is_set():
            if done():
                ok = True
                break
            time.sleep(0.1)
        self.out.emit({"k": "instruct", "id": rid, "action": action, "done": ok})
        return ok

    def _talked_since(self, rev: int, since: float) -> bool:
        return self.rev_seen.get(rev, 0.0) > since

    def _await_boot(self, rid, rev: int, since: float) -> int | None:
        """The new firmware must speak. If it doesn't, the fixture pulses EN, or the person is asked to tap RST."""
        end = time.monotonic() + BOOT_WAIT_S
        while time.monotonic() < end:
            if self._talked_since(rev, since):
                return rev
            time.sleep(0.1)
        if self.fixture:
            self.cmd_reset(rid, {})
            end = time.monotonic() + BOOT_WAIT_S
            while time.monotonic() < end:
                if self._talked_since(rev, since):
                    return rev
                time.sleep(0.1)
            return None
        return rev if self._ask(rid, "reset", ASK_RESET, lambda: self._talked_since(rev, since)) else None

    def _recover_or_ask(self, rid) -> Callable[[], bool]:
        """flash()'s recovery: the fixture's BOOT+EN, or the person's buttons. Done when the S3 re-enumerates in its
        bootloader (USB-Serial-JTAG, 303a:1001)."""
        def recover() -> bool:
            if self.fixture:
                return self._recover()
            before = port_scan.dut_identity()

            def in_bootloader() -> bool:
                now = port_scan.dut_identity()
                return now is not None and now[1] == 0x1001 and now != before

            return self._ask(rid, "boot-reset", ASK_BOOT_RESET, in_bootloader)

        return recover
    def _run_fake_dut(self) -> None:
        while not self.stopped.is_set():
            with self.lock:
                dut = self.dut_box["dut"]
                dut.step(int(time.monotonic() * 1000))
                lines = dut.drain_lines()
            for line in lines:
                self._dut_line(dut_line(line))
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
            handler = getattr(self, f"cmd_{cmd.replace('.', '_')}", None) if isinstance(cmd, str) else None
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
        rev = read_firmware_info(fw_dir)["rev"]
        if self.source == "fake":
            result = self._fake_flash(rid, fw_dir, progress)
        else:
            result = self._real_flash(rid, fw_dir, env, progress)
        if result["ok"]:
            result["booted"] = self._await_boot(rid, rev, result.pop("done_at"))
        return result

    def _real_flash(self, rid, fw_dir: str, env: str, progress: Callable[[dict], None]) -> dict:
        stage_build_dir(fw_dir, self.work_dir)
        # Without a CP2102 the telemetry comes over the flashing port: let go of it while esptool needs it.
        shared = self.telemetry is not None and self.ports["telemetry"] == self.ports["dut"]
        if shared:
            self.telemetry.pause()
        try:
            result = flash(self.work_dir, env, port=lambda: port_scan.scan()["dut"], recover=self._recover_or_ask(rid), on_progress=progress, pio=self.pio)
            result["done_at"] = time.monotonic()
            return result
        finally:
            if shared:
                self.telemetry.resume()

    def _fake_flash(self, rid, fw_dir: str, progress: Callable[[dict], None]) -> dict:
        start = time.monotonic()
        progress({"stage": "build", "pct": 0})
        info = read_firmware_info(fw_dir)
        time.sleep(2.0 / self.fake_speed)
        progress({"stage": "connect", "pct": 0})
        time.sleep(0.3 / self.fake_speed)
        dut = self.dut_box["dut"]
        with self.lock:
            reachable = dut.can_enter_download()
        if not reachable and not self._recover_fake(rid):
            return {"ok": False, "stage": "connect", "error": "the S3 never entered its bootloader", "ms": int((time.monotonic() - start) * 1000)}
        for pct in range(0, 101, 10):
            progress({"stage": "write", "pct": pct})
            time.sleep(0.2 / self.fake_speed)
        with self.lock:
            dut.flash(info, int(time.monotonic() * 1000))
        return {"ok": True, "ms": int((time.monotonic() - start) * 1000), "done_at": time.monotonic() - 0.01}

    def _recover_fake(self, rid) -> bool:
        """The fake's version of _recover_or_ask: the fixture's straps, else the person's buttons (fake.press)."""
        dut = self.dut_box["dut"]
        if self.fixture:
            return self._recover() and dut.download_mode
        return self._ask(rid, "boot-reset", ASK_BOOT_RESET, lambda: dut.download_mode)

    def cmd_fake_press(self, rid, req) -> dict:
        """Test and demo hook: the person at the desk presses the S3's buttons ("boot+rst" or "rst")."""
        if self.source != "fake":
            return {"ok": False, "error": "fake.press only works with --source fake"}
        if req.get("buttons") not in ("boot+rst", "rst"):
            return {"ok": False, "error": 'buttons must be "boot+rst" or "rst"'}
        with self.lock:
            self.dut_box["dut"].press(req["buttons"], int(time.monotonic() * 1000))
        return {"ok": True}

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
        # Commands run one at a time on a worker, so a flash that waits for the person doesn't block stdin;
        # fake.press (the person, simulated) is answered at once.
        work: queue.Queue = queue.Queue()

        def worker() -> None:
            while (req := work.get()) is not None:
                if not self.handle(req):
                    return

        runner = threading.Thread(target=worker, daemon=True)
        runner.start()
        for line in stdin:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except json.JSONDecodeError:
                self.out.emit({"k": "ack", "id": None, "ok": False, "error": "bad JSON"})
                continue
            if req.get("cmd") == "fake.press":
                self.handle(req)
                continue
            work.put(req)
            if req.get("cmd") == "quit":
                break
        else:
            work.put(None)
        runner.join()
        self.stopped.set()
        if self.fixture:
            self.fixture.stop()
        if self.telemetry:
            self.telemetry.stop()
        self.out.emit({"k": "bye"})
        self.out.close()
