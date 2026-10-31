# Add a sensor: one request, four domains

`npm start -- briefs/beacon.md --mock --change "add a temperature/humidity sensor" --change-delay 5`

Scripted agents with real tools (tscircuit + KiCad, build123d, PlatformIO, QEMU) on one laptop, 31 Oct 2026.

- **Before (revision 7):** a BLE beacon with USB-C charging, a battery, a status LED and a wake button (SW1, top
  edge, GPIO3), and no sensor. It settled with 0 violations 263 s after the brief. The case has a USB-C cutout and a
  button hole, and no vent (`before/vents.json` is `[]`). The firmware advertises "no sensor".
- **Request:** `add a temperature/humidity sensor`.
  - parts added the SHT40 (U2) and its two I2C pull-ups;
  - the architect added I2C_SDA = GPIO8 → U2.SDA, I2C_SCL = GPIO9 → U2.SCL and a requirement line.
  - Three contract writes in 0.4 s (revisions 8–10).
- **Woke:** architect, parts, the board, case and firmware builders, the grounding check, and consistency. The
  firmware reviewer checked and changed nothing. The brief reviewer stayed idle until the design settled, then passed
  it again.
- **Peak violations: 9** at revision 10:
  - net-missing ×2 and pin-mismatch ×2: the board and firmware didn't have the I2C bus yet;
  - part-mismatch ×3: no U2, R5 or R6 on the board;
  - sensor-mismatch ×1: the firmware had no sensor driver;
  - vent-missing ×1: the case had no vent over U2.
- **Who cleared them:**
  - the case cleared vent-missing first (39 s);
  - the board cleared part-mismatch (136 s);
  - the firmware cleared pin-mismatch and sensor-mismatch (158 s);
  - the board cleared the last net-missing (195 s).
- **Consistent again: 195.1 s** after the request, with 0 violations. The board and firmware each built twice: once
  for the parts write and once for the pins write that followed 0.3 s later.
- **The vent:** a 4-slot grille, 8.4 × 6 mm (28.8 mm² open), through the lid at (45.5, 23.0) mm. The built board put
  U2 at (46.5, 23.0) mm, so U2 is under the grille. The grille's centre is 1 mm off because it stays inside the lid's
  lip. The print check passes. Coordinates are in mm from the board's bottom-left corner.
- **Firmware:** revision 10 compiles the SHT40 driver and boots in QEMU (QEMU has no I2C sensor, so it prints SENSOR
  FAIL there).

Files: `report.md`, `ripples.json`, `trace.jsonl`, `contracts/rev-N.json`, and per side `before/` (board rev 7, case
rev 4) and `after/` (board rev 10, case rev 9): `circuit.json`, `board.png`, `case.stl`, `lid.stl`, `vents.json`,
`spec.json`, `cutouts.json`, `standoffs.json`, `print.json`.
