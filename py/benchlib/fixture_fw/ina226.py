# MicroPython INA226 driver (also importable on CPython with any I2C object that has
# readfrom_mem / writeto_mem).

REG_CONFIG = 0x00
REG_SHUNT = 0x01
REG_BUS = 0x02
REG_POWER = 0x03
REG_CURRENT = 0x04
REG_CAL = 0x05

import time

# AVG=16, VBUSCT=1.1ms, VSHCT=1.1ms, continuous shunt+bus.
CONFIG_DEFAULT = 0x4000 | (0b010 << 9) | (0b100 << 6) | (0b100 << 3) | 0b111
# Bringup change: continuous SHUNT ONLY, AVG=16, VSHCT=1.1ms. A new averaged current every 17.6 ms with no gaps,
# because the bus conversion no longer takes half the time. Polling it faster than that reads every conversion.
CONFIG_SHUNT_ONLY = 0x4000 | (0b010 << 9) | (0b100 << 6) | (0b100 << 3) | 0b101
# One triggered shunt+bus conversion, no averaging: how the bus voltage is read once at start.
CONFIG_TRIGGERED_BOTH = 0x4000 | (0b000 << 9) | (0b100 << 6) | (0b100 << 3) | 0b011


def _sleep_ms(ms):
    if hasattr(time, "sleep_ms"):
        time.sleep_ms(ms)
    else:
        time.sleep(ms / 1000)


def _signed(v):
    return v - 0x10000 if v & 0x8000 else v


class INA226:
    def __init__(self, i2c, addr=0x40, shunt_ohm=0.1, max_current_a=0.8, shunt_only=True):
        self.i2c = i2c
        self.addr = addr
        # Round the current LSB up to a tidy value so readings are easy to sanity-check.
        raw_lsb = max_current_a / 32768
        self.current_lsb = 25e-6 if raw_lsb <= 25e-6 else raw_lsb
        self.cal = int(0.00512 / (self.current_lsb * shunt_ohm))
        self.shunt_only = shunt_only
        self.bus_v = None
        if shunt_only:
            self._write(REG_CONFIG, CONFIG_TRIGGERED_BOTH)
            self._write(REG_CAL, self.cal)
            _sleep_ms(5)
            self.bus_v = round(self._read(REG_BUS) * 1.25e-3, 4)
            self._write(REG_CONFIG, CONFIG_SHUNT_ONLY)
        else:
            self._write(REG_CONFIG, CONFIG_DEFAULT)
            self._write(REG_CAL, self.cal)

    def _write(self, reg, value):
        self.i2c.writeto_mem(self.addr, reg, bytes([(value >> 8) & 0xFF, value & 0xFF]))

    def _read(self, reg):
        b = self.i2c.readfrom_mem(self.addr, reg, 2)
        return (b[0] << 8) | b[1]

    def read(self):
        # Shunt-only mode never updates the bus register: report the voltage measured at start.
        bus_v = self.bus_v if self.shunt_only else self._read(REG_BUS) * 1.25e-3
        shunt_v = _signed(self._read(REG_SHUNT)) * 2.5e-6
        current_a = _signed(self._read(REG_CURRENT)) * self.current_lsb
        power_w = self._read(REG_POWER) * 25 * self.current_lsb
        return {
            "bus_v": round(bus_v, 4),
            "shunt_mv": round(shunt_v * 1000, 4),
            "current_a": round(current_a, 6),
            "power_w": round(power_w, 5),
        }
