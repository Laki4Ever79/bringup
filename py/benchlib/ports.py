"""Finds the bench's three USB serial devices by VID:PID. No custom udev rules needed."""

from __future__ import annotations

# (vid, pid) -> role. The ESP32-S3's native USB-Serial-JTAG is also what its ROM bootloader enumerates as,
# so the DUT has the same port in download mode.
ROLES = {
    (0x303A, 0x1001): "dut",
    (0x2E8A, 0x0005): "fixture",  # RP2350 running MicroPython
    (0x10C4, 0xEA60): "telemetry",  # CP2102 on the DUT's UART1 TX
}


def classify(devices: list[tuple[str, int | None, int | None]]) -> dict[str, str | None]:
    found: dict[str, str | None] = {"dut": None, "fixture": None, "telemetry": None}
    for device, vid, pid in sorted(devices):
        role = ROLES.get((vid, pid))
        if role and found[role] is None:
            found[role] = device
    return found


def scan() -> dict[str, str | None]:
    from serial.tools import list_ports

    return classify([(p.device, p.vid, p.pid) for p in list_ports.comports()])
