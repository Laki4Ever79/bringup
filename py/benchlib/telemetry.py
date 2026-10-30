"""Reads the DUT's JSON lines from a serial port: the CP2102 on GPIO17, or the S3's own USB port when there is no
CP2102. The own port is also the flashing port, so the reader can pause: it closes the port and keeps it closed until
resumed, which lets esptool open it."""

from __future__ import annotations

import json
import threading
from typing import Any, Callable

BAUD = 115200  # the CP2102's UART rate; the S3's own USB ignores it


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


def _open_serial(port: str):
    import serial

    return serial.Serial(port, BAUD, timeout=0.2)


class TelemetryReader:
    def __init__(self, port: str, emit: Callable[[dict], None], open_port: Callable[[str], Any] | None = None, retry_s: float = 0.5):
        self.port = port
        self.emit = emit
        self.open_port = open_port or _open_serial
        self.retry_s = retry_s
        self.stopped = threading.Event()
        self.paused = threading.Event()
        self.idle = threading.Event()  # set while the port is closed
        self.idle.set()
        self.wake = threading.Event()

    def start(self) -> None:
        threading.Thread(target=self._run, daemon=True).start()

    def pause(self, timeout: float = 2.0) -> None:
        """Returns once the port is closed."""
        self.paused.set()
        self.idle.wait(timeout)

    def resume(self) -> None:
        self.paused.clear()
        self.wake.set()

    def stop(self) -> None:
        self.stopped.set()
        self.wake.set()

    def _run(self) -> None:
        reported = False  # one error line per outage, not one per retry
        while not self.stopped.is_set():
            if self.paused.is_set():
                self.wake.wait(0.1)
                self.wake.clear()
                continue
            try:
                ser = self.open_port(self.port)
            except Exception as e:
                if not reported:
                    self.emit({"k": "error", "where": "telemetry", "error": str(e)})
                    reported = True
                self.stopped.wait(self.retry_s)
                continue
            reported = False
            self.idle.clear()
            try:
                while not (self.stopped.is_set() or self.paused.is_set()):
                    raw = ser.readline()
                    if raw:
                        self.emit(dut_line(raw.decode(errors="replace")))
            except Exception as e:  # the port vanished: a reset re-enumerates the S3's USB
                if not self.paused.is_set():
                    self.emit({"k": "error", "where": "telemetry", "error": str(e)})
                    reported = True
            finally:
                try:
                    ser.close()
                except Exception:
                    pass
                self.idle.set()
