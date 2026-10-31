# One working copy: a linked git folder

A mock `--stay --link <folder>` run with the real tools (tscircuit, KiCad, PlatformIO), from wt/firmware 7b580a9. The
contract is the only truth; the folder holds views of it (`firmware/pins.h`, `board/board.kicad_pcb`,
`enclosure/case.step|.stl`, `fab/*`). Bringup commits each settled revision there (`git-log.txt`; local only, never a
push or remote). The last Bringup commit is the base every save is compared with, three ways: base, the file on
disk, the contract now.

| When (UTC) | What | Result |
|---|---|---|
| 13:40:43 | First settle | commit `6c53df9` "Bringup rev 7: the design from the brief", 8 files |
| 13:40:43 | Edited `firmware/pins.h`: `PIN_I2C_SDA 8 → 4` | the design was where the base left it: request req-1, **adopted**; commit `136cf9c` "Bringup rev 8: edited pins.h: I2C_SDA GPIO8 → GPIO4" (board, fab and pins.h regenerated) |
| 13:42:48 | The design moved (req-2 "blink faster" changed `behavior`, a firmware input); then `PIN_I2C_SCL 9 → 3` saved in the pins.h from rev 8 | stale but independent (pins ∩ behavior = ∅): **rebased** onto rev 9 as req-3; commit `68d8b1b` "Bringup rev 10: edited pins.h at rev 8, rebased onto rev 9: I2C_SCL GPIO9 → GPIO3" |
| 13:44:45 | `board/board.kicad_pcb` re-saved as KiCad does: re-indented with tabs, every uuid re-stamped (6150 lines changed, `kicad-resave.diffstat.txt`) | same outline, connectors and content: **"re-saved, no design change"**, ignored |
| 13:44:46 | `#define DEBUG_LOG 1` added to `firmware/pins.h` | not in the contract: drift-4 stays **open** (Adopt is refused; Revert restores the base commit's bytes); regeneration would skip the file |

`files.json` is what the hub's `GET /api/runs/:id/files` returned at the end (the linked folder, `git`, `dirty`, Bringup's commits with revision, source and request from their trailers, and the drift entries). `status.txt` is `npm run bringup -- status` at the end: the linked folder rescanned three ways from git and the contract
files (it works offline and after a restart), then the drift history. Tests: `test/linked.test.ts`.

What it does not do: read arbitrary KiCad edits back (only the board outline and connector positions map to the
contract; anything else is drift), or import an arbitrary KiCad project. req-2 and the rebased edit settled together,
so commit `68d8b1b` describes the last request's ripple only. Mock models: the owners' decisions are scripted.
