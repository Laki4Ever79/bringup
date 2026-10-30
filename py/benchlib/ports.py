"""Finds the bench's three USB serial devices by VID:PID. No custom udev rules needed."""

from __future__ import annotations

# (vid, pid) -> role. The ESP32-S3's native USB-Serial-JTAG is also what its ROM bootloader enumerates as,
# so the DUT has the same port in download mode.
ROLES = {
    (0x303A, 0x1001): "dut",
    (0x303A, 0x4001): "dut",  # the same S3 running USB-OTG (TinyUSB) firmware, e.g. the factory demo
    (0x2E8A, 0x0005): "fixture",  # RP2350 running MicroPython
    (0x10C4, 0xEA60): "telemetry",  # CP2102 on the DUT's UART1 TX
}


def classify(devices: list[tuple[str, int | None, int | None]]) -> dict[str, str | None]:
    found: dict[str, str | None] = {"dut": None, "fixture": None, "telemetry": None}
    for device, vid, pid in sorted(devices):
        role = ROLES.get((vid, pid))
        if role and found[role] is None:
            found[role] = device
    # No CP2102: the S3's own USB port carries the telemetry too (the firmware writes to both).
    if found["telemetry"] is None:
        found["telemetry"] = found["dut"]
    return found


def scan() -> dict[str, str | None]:
    from serial.tools import list_ports

    return classify([(p.device, p.vid, p.pid) for p in list_ports.comports()])


def dut_identity() -> tuple[int, int, int] | None:
    """(vid, pid, USB device number) of the S3. The device number changes whenever it re-enumerates, which is how
    the bench sees that someone pressed its buttons."""
    from serial.tools import list_ports

    for p in list_ports.comports():
        if ROLES.get((p.vid, p.pid)) == "dut":
            devnum = -1
            path = getattr(p, "usb_device_path", None)
            try:
                with open(f"{path}/devnum") as f:
                    devnum = int(f.read())
            except (OSError, TypeError, ValueError):
                pass
            return p.vid, p.pid, devnum
    return None
