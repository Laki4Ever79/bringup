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

## board.kicad_pcb: the outline (`board/`)

The same kind of run from wt/firmware 866aee7. After the first settle, the newest
`board/rev-7/dist/board/kicad/board.kicad_pcb` had its right board edge dragged out by 5 mm: the three Edge.Cuts lines
at x = 125 moved to x = 130 (`board/board-edit.diff`), the way KiCad's PCB editor saves it.

| When (UTC) | What |
|---|---|
| 11:44:54.2 | Saved `board/rev-7/dist/board/kicad/board.kicad_pcb` with the outline 50 → 55 mm wide |
| 11:44:54.5 | `change.requested` req-1 "edited board.kicad_pcb: outline 50×30 → 55×30 mm", source `{kind: file, path: board/rev-7/…/board.kicad_pcb, revision: 7}` |
| 11:44:54.5 | The architect (owner of the outline) changed it; contract rev 8. The check flagged `outline-mismatch` |
| 11:44:59.3 | The case rebuilt at 55 mm; its standoffs no longer matched the old board's holes (`standoff-mismatch` ×2) |
| 11:45:15.5 | The board rebuilt at rev 8 (KiCad DRC 0 errors; it reads back 55×30); the check was clean |
| 11:45:17.4 | Settled at rev 8 |

`board/ripples.json`: fields `outline`; woke architect, build:board, build:enclosure, consistency (4 of 9); the
firmware build and grounding stayed idle; peak 3 violations; consistent again 20.9 s after the save. The board is read
back with af's `readBoardEdits` (`src/tools/kicad-read.ts`). Tests: `test/file-sync.test.ts` and
`test/file-sync.int.test.ts` (the outline edit with the real tools).

## Drift: edits that are not applied (`drift/`)

A mock `--stay --no-hardware` run from wt/firmware d3a0fed (stub builders; the point is the events). After the first
settle, two saves, neither of which becomes a change request:

| When (UTC) | Save | Event |
|---|---|---|
| 11:50:42.5 | `#define DEBUG_LOG 1` added to the newest `firmware/rev-7/include/pins.h` | `file.drift` reason `not-in-contract`, items `["+ #define DEBUG_LOG 1"]`: "this edit isn't in the design contract; the next rebuild will overwrite it" |
| 11:50:42.9 | `PIN_I2C_SCL` moved to 3 in the older `firmware/rev-6/include/pins.h` (the pins changed at rev 7) | `file.drift` reason `stale`, items `["I2C_SCL GPIO9 → GPIO3"]`: "saved against rev 6, the design is at rev 7"; not applied |

There is no `change.requested` and no `requests.jsonl` in this run.
