# Real hardware layer for the RP2350 fixture (MicroPython only).
# Pin map defaults follow docs/PLAN.md section 4.2.

import time
from machine import Pin, I2C

from ina226 import INA226

I2C_SDA = 4
I2C_SCL = 5
ONEWIRE_PIN = 22
ESTOP_PIN = 21  # NO contact to GND, internal pull-up: pressed -> 0
DS18B20_PERIOD_MS = 800


class HalRP2:
    def __init__(self, shunt_ohm=0.1, max_current_a=0.8):
        self._pins = {}
        self._ina = None
        try:
            i2c = I2C(0, sda=Pin(I2C_SDA), scl=Pin(I2C_SCL), freq=400000)
            if 0x40 in i2c.scan():
                self._ina = INA226(i2c, 0x40, shunt_ohm, max_current_a)
        except Exception:
            self._ina = None
        self._estop = Pin(ESTOP_PIN, Pin.IN, Pin.PULL_UP)
        self._ds = None
        self._roms = []
        self._temps = []
        self._last_convert = 0
        try:
            import onewire
            import ds18x20

            self._ds = ds18x20.DS18X20(onewire.OneWire(Pin(ONEWIRE_PIN)))
            self._roms = self._ds.scan()
            if self._roms:
                self._ds.convert_temp()
                self._last_convert = time.ticks_ms()
        except Exception:
            self._ds = None

    def time_ms(self):
        return time.ticks_ms()

    def set_pin(self, pin, value, mode):
        if mode == "od":
            # Open drain emulation: drive low, or release to high-Z.
            if value:
                p = Pin(pin, Pin.IN)
            else:
                p = Pin(pin, Pin.OUT, value=0)
        else:
            p = self._pins.get(pin)
            if p is None:
                p = Pin(pin, Pin.OUT)
            p.value(value)
        self._pins[pin] = p

    def read_pin(self, pin, pull=None):
        pull_mode = {"up": Pin.PULL_UP, "down": Pin.PULL_DOWN}.get(pull)
        p = Pin(pin, Pin.IN, pull_mode) if pull_mode is not None else Pin(pin, Pin.IN)
        return p.value()

    def ina226_read(self):
        if self._ina is None:
            return {"bus_v": 0.0, "shunt_mv": 0.0, "current_a": 0.0, "power_w": 0.0, "missing": True}
        return self._ina.read()

    def temp_read(self):
        # Non-blocking: return cached values and start the next conversion when due.
        if self._ds and self._roms and time.ticks_diff(time.ticks_ms(), self._last_convert) >= DS18B20_PERIOD_MS:
            try:
                self._temps = [round(self._ds.read_temp(r), 2) for r in self._roms]
                self._ds.convert_temp()
                self._last_convert = time.ticks_ms()
            except Exception:
                pass
        return self._temps

    def estop_pressed(self):
        return self._estop.value() == 0
