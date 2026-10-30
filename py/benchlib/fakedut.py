"""A simulated ESP32-S3 running the bench firmware, for --source fake and the tests.

It follows the same rules as templates/fw/src/main.cpp under BENCH: BENCH_MODE (fixture GP12 → DUT GPIO4) is read
at every boot, BOOT (GP11) low during a reset means download mode, and the JSON lines match bench.md §2.
"""

from __future__ import annotations

import json
import math

MODE_PIN = 12  # fixture GP12 → DUT GPIO4
BOOT_PIN = 11  # fixture GP11 → DUT GPIO0
LIVE_SAMPLE_MS = 50
DUTY_PERIOD_MS = 3000  # BENCH_PERIOD_S = 3
DUTY_AWAKE_MS = 180
TILT_SWING_DEG = 35
TILT_PERIOD_MS = 8000
CURRENT_MA = {"blank": 30.0, "download": 30.0, "factory": 40.0, "live": 45.0, "led": 5.0, "awake": 60.0, "asleep": 6.0}


class FakeDut:
    def __init__(self, pins, now_ms: int, info: dict | None = None, imu: bool = True, factory: bool = False):
        self.pins = pins
        # factory: running the board's shipped demo (TinyUSB), which the laptop can't reset into flashing mode
        self.factory = factory
        # the bootloader was entered with the BOOT button: after a flash the S3 stays there until RST (seen 30 Oct)
        self.manual_download = False
        self.next_demo = now_ms
        self.imu = imu  # False: no MPU-6050 wired, as on a bare S3
        self.last_err = None
        self.info = info
        self.lines: list[str] = []
        self.download_mode = False
        self.mode = "factory" if factory else "blank"
        self.boot_ms = now_ms
        self.led = 0
        self.next_toggle = now_ms
        self.next_sample = now_ms
        self.cycle = 0
        self.wake_ms = now_ms
        self.awake = False
        if info:
            self._boot(now_ms, "poweron")

    # ---- what the bridge drives ------------------------------------------------
    def can_enter_download(self) -> bool:
        """Whether esptool can reset the S3 into its bootloader over USB: yes for our firmware (USB-Serial-JTAG)."""
        return self.download_mode or self.mode not in ("factory",)

    def flash(self, info: dict, now_ms: int) -> None:
        self.info = info
        self.factory = False
        self.cycle = 0
        if self.manual_download:
            return  # written, but still in the bootloader until someone taps RST
        self.download_mode = False
        self._boot(now_ms, "usb")  # esptool resets the S3 through its USB-Serial-JTAG

    def press(self, buttons: str, now_ms: int) -> None:
        """A human at the desk: "boot+rst" (hold BOOT, tap RST, release BOOT) or "rst"."""
        if buttons == "boot+rst":
            self.download_mode, self.manual_download, self.mode = True, True, "download"
            return
        self.download_mode = self.manual_download = False
        if self.factory or not self.info:
            self.mode = "factory" if self.factory else "blank"
            return
        self.cycle = 0
        self._boot(now_ms, "poweron")

    def reset(self, now_ms: int) -> None:
        """The fixture's EN pulse: the same as the buttons, with BOOT as the fixture holds it."""
        self.press("boot+rst" if self.pins.get(BOOT_PIN, 1) == 0 else "rst", now_ms)

    def can_enter_download(self) -> bool:
        """Whether esptool can reset the S3 into its bootloader over USB: yes for our firmware (USB-Serial-JTAG)."""
        return self.download_mode or self.mode not in ("factory",)

    def flash(self, info: dict, now_ms: int) -> None:
        self.info = info
        self.factory = False
        self.cycle = 0
        if self.manual_download:
            return  # written, but still in the bootloader until someone taps RST
        self.download_mode = False
        self._boot(now_ms, "usb")  # esptool resets the S3 through its USB-Serial-JTAG

    def press(self, buttons: str, now_ms: int) -> None:
        """A human at the desk: "boot+rst" (hold BOOT, tap RST, release BOOT) or "rst"."""
        if buttons == "boot+rst":
            self.download_mode, self.manual_download, self.mode = True, True, "download"
            return
        self.download_mode = self.manual_download = False
        if self.factory or not self.info:
            self.mode = "factory" if self.factory else "blank"
            return
        self.cycle = 0
        self._boot(now_ms, "poweron")

    def reset(self, now_ms: int) -> None:
        if self.pins.get(BOOT_PIN, 1) == 0:
            self.download_mode = True
            self.mode = "download"
            return
        self.download_mode = False
        self.cycle = 0
        self._boot(now_ms, "poweron")  # an EN pulse is a power-on reset on the ESP32-S3

    def step(self, now_ms: int) -> None:
        if self.mode == "factory" and now_ms >= self.next_demo:
            self.next_demo = now_ms + 1000
            self.lines.append("50%" + "RGB"[(now_ms // 1000) % 3])
        if self.mode == "live":
            if self.pins.get(MODE_PIN, 0) == 1:
                self._sleep(now_ms)
                return
            if now_ms >= self.next_toggle:
                self.led ^= 1
                self.next_toggle = now_ms + self._period(now_ms) // 2
            if now_ms >= self.next_sample:
                self.next_sample = now_ms + LIVE_SAMPLE_MS
                self._imu_error(now_ms)
                self._emit(self._sample(now_ms))
        elif self.mode == "duty":
            if self.awake and now_ms >= self.wake_ms + DUTY_AWAKE_MS:
                self._imu_error(now_ms)
                self._emit(self._sample(now_ms))
                self._emit({"k": "cycle", "rev": self.info["rev"], "n": self.cycle, "awakeMs": DUTY_AWAKE_MS})
                self._sleep(now_ms)
            elif not self.awake and now_ms >= self.wake_ms:
                self.cycle += 1
                self._boot(now_ms, "deepsleep")

    def current_ma(self, now_ms: int) -> float:
        if self.mode in ("blank", "download", "factory"):
            return CURRENT_MA[self.mode]
        if self.mode == "live":
            return CURRENT_MA["live"] + (CURRENT_MA["led"] if self.led else 0.0)
        return CURRENT_MA["awake"] if self.awake else CURRENT_MA["asleep"]

    def drain_lines(self) -> list[str]:
        out, self.lines = self.lines, []
        return out

    # ---- firmware behaviour ----------------------------------------------------
    def _boot(self, now_ms: int, reason: str) -> None:
        self.boot_ms = now_ms
        self.last_err = None
        duty = self.pins.get(MODE_PIN, 0) == 1
        self.mode = "duty" if duty else "live"
        self.awake = duty
        self.wake_ms = now_ms
        self.led = 0
        self.next_toggle = now_ms
        self.next_sample = now_ms
        self._emit({"k": "boot", "rev": self.info["rev"], "reset": reason, "mode": self.mode})

    def _sleep(self, now_ms: int) -> None:
        self.mode = "duty"
        self.awake = False
        self.led = 0
        self.wake_ms = now_ms + DUTY_PERIOD_MS - DUTY_AWAKE_MS

    def _angle(self, now_ms: int) -> float:
        return TILT_SWING_DEG * math.sin(2 * math.pi * (now_ms - self.boot_ms) / TILT_PERIOD_MS)

    def _period(self, now_ms: int) -> int:
        tilted = self.imu and abs(self._angle(now_ms)) > self.info["tiltDeg"]
        return self.info["tiltBlinkMs"] if tilted else self.info["blinkMs"]

    def _imu_error(self, now_ms: int) -> None:
        """At most one a second, and once per boot, as main.cpp does."""
        if self.imu or (self.last_err is not None and now_ms - self.last_err < 1000):
            return
        self.last_err = now_ms
        self._emit({"k": "err", "rev": self.info["rev"], "what": "imu", "detail": "no ACK at 0x68"})

    def _sample(self, now_ms: int) -> dict:
        if not self.imu:
            return {"k": "s", "rev": self.info["rev"], "ms": now_ms - self.boot_ms, "ax": 0, "ay": 0, "az": 0, "tilt": 0,
                    "tC": None, "tSrc": "none", "led": 1 if self.mode == "duty" else self.led}
        a = math.radians(self._angle(now_ms))
        return {
            "k": "s",
            "rev": self.info["rev"],
            "ms": now_ms - self.boot_ms,
            "ax": round(math.sin(a), 3),
            "ay": 0.0,
            "az": round(math.cos(a), 3),
            "tilt": round(abs(math.degrees(a)), 1),
            "tC": 24.6,
            "tSrc": "mpu",
            "led": 1 if self.mode == "duty" else self.led,
        }

    def _emit(self, obj: dict) -> None:
        self.lines.append(json.dumps(obj, separators=(",", ":")))
