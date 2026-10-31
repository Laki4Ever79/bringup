# Edit the file, the design follows: pins.h

A mock `--stay` run with the real tools (tscircuit, KiCad, PlatformIO, QEMU), from wt/firmware e17aa85. Once the design
settled, the newest generated `firmware/rev-7/include/pins.h` was edited by hand and saved. Nothing else was touched.

| When (UTC) | What |
|---|---|
| 11:22:53.8 | Saved `firmware/rev-7/include/pins.h` with `PIN_I2C_SDA 8` → `4` (`pins.h.generated-rev-7` → `pins.h.edited-rev-7`) |
| 11:22:54.1 | `change.requested` req-1 "edited pins.h: I2C_SDA GPIO8 → GPIO4", source `{kind: file, path: firmware/rev-7/include/pins.h, revision: 7}` |
| 11:22:54.2 | The architect (owner of pins) proposed the pin move; contract rev 8. The check flagged `pin-mismatch` and `net-missing` |
| 11:24:04.4 | Firmware rebuilt at rev 8 with `PIN_I2C_SDA 4` (`pins.h.rebuilt-rev-8`); it booted in QEMU |
| 11:24:30.4 | Board rebuilt at rev 8 (KiCad DRC 0 errors); the check was clean |
| 11:24:32.4 | Brief review passed; the design settled at rev 8 |

`ripples.json`: fields `pins`; woke architect, build:board, build:firmware, grounding, consistency (5 of 9); the case
stayed idle; peak 2 violations; consistent again 96.3 s after the save.

Mock models: the architect's move is scripted, so this shows the plumbing (save → request → owner → builders → check),
not a model's judgement. Local paths are stripped. Tests: `test/file-sync.test.ts`.
