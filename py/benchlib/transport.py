"""Line transports: a real serial port, or an in-process mock running the fixture firmware core.

Copied from hw_agent (src/bench/drivers/transport.py @ 3c2226b); only the import path changed.
"""

from __future__ import annotations

import time
from typing import Callable, Protocol

from benchlib.fixture_fw.core import FixtureCore


class LineTransport(Protocol):
    def write_line(self, line: str) -> None: ...
    def read_line(self, timeout: float) -> str | None: ...
    def close(self) -> None: ...


class SerialTransport:
    def __init__(self, port: str, baud: int = 115200):
        import serial

        self._ser = serial.Serial(port, baud, timeout=0.05)
        self._buf = b""

    def write_line(self, line: str) -> None:
        self._ser.write(line.encode() + b"\n")

    def read_line(self, timeout: float) -> str | None:
        deadline = time.monotonic() + timeout
        while True:
            if b"\n" in self._buf:
                line, self._buf = self._buf.split(b"\n", 1)
                return line.decode(errors="replace").rstrip("\r")
            if time.monotonic() >= deadline:
                return None
            self._buf += self._ser.read(self._ser.in_waiting or 1)

    def close(self) -> None:
        self._ser.close()


class FakeHal:
    """Simulated fixture hardware: a DUT drawing `load_a` from `psu_v` through relay 1 and the INA226."""

    def __init__(self, clock_ms: Callable[[], int] | None = None, psu_v: float = 5.0, load_a: float = 0.12):
        self._clock = clock_ms or (lambda: int(time.monotonic() * 1000))
        self.psu_v = psu_v
        self.load_a = load_a
        self.pins: dict[int, int] = {}
        self.inputs: dict[int, int] = {}
        self.temps = [24.5, 25.1]
        self.estop = False
        self.power_relay_pin = 6
        self.relay_active_low = True

    def time_ms(self) -> int:
        return self._clock()

    def set_pin(self, pin: int, value: int, mode: str) -> None:
        self.pins[pin] = value

    def read_pin(self, pin: int, pull: str | None = None) -> int:
        if pin in self.inputs:
            return self.inputs[pin]
        return self.pins.get(pin, 1 if pull == "up" else 0)

    def _dut_powered(self) -> bool:
        level = self.pins.get(self.power_relay_pin, 1)
        return level == 0 if self.relay_active_low else level == 1

    def ina226_read(self) -> dict:
        if not self._dut_powered():
            return {"bus_v": 0.0, "shunt_mv": 0.0, "current_a": 0.0, "power_w": 0.0}
        i = self.load_a
        return {"bus_v": self.psu_v, "shunt_mv": round(i * 0.1 * 1000, 4), "current_a": i, "power_w": round(self.psu_v * i, 5)}

    def temp_read(self) -> list[float]:
        return list(self.temps)

    def estop_pressed(self) -> bool:
        return self.estop


class MockTransport:
    """Runs FixtureCore in-process, so the host stack is exercised against the real firmware logic."""

    def __init__(self, hal: FakeHal | None = None, config: dict | None = None):
        self.hal = hal or FakeHal()
        self.core = FixtureCore(self.hal, config)
        self._pending: list[str] = []

    def write_line(self, line: str) -> None:
        self.core.handle_line(line)
        self.core.tick()
        self._pending.extend(self.core.drain())

    def read_line(self, timeout: float) -> str | None:
        deadline = time.monotonic() + timeout
        while True:
            if self._pending:
                return self._pending.pop(0)
            self.core.tick()
            self._pending.extend(self.core.drain())
            if self._pending:
                continue
            if time.monotonic() >= deadline:
                return None
            time.sleep(0.001)

    def close(self) -> None:
        pass


def open_fixture_transport(port: str, baud: int = 115200) -> LineTransport:
    if port == "mock":
        return MockTransport()
    return SerialTransport(port, baud)
