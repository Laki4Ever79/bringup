# Robot module library (items 1 and 5 of the competitor ideas, 15 Nov)

**Status: analysis, nothing built.** Owner: d9610c. The idea is borrowed from Diode (proven blocks); no code, text or
design is copied.

## What a module is

A module is a block a robot is built from. It has four parts:
- **Parts:** catalog entries, referred to by MPN.
- **Circuit:** what the board generator places for it.
- **Firmware:** the driver that runs it.
- **Evidence:** a record of every time that combination was shown to work, and how strongly it was shown.

Examples: the DRV8833 motor stage with two N20 gearmotors, the 1S cell with the TP4054 charger, the VL53L0X distance
sensor on its STEMMA plug, and later an IMU, a USB-C hub, an emergency stop, a pull-cord start switch and encoder
motors (the last three are needed for the Eurobot starter).

## What exists today

| Piece | Where | State |
|---|---|---|
| Mechanical parts with per-field datasheet sources (`source.<field>.url`, `where`) | `catalog/mechanics.json` | 12 entries; every number cited |
| Shop links, price, stock, lead time | `buy` per entry; `bom.json` robot section (09741c, item 4) | built |
| Board parts, plus parts learned from datasheets with page and region | `catalog/parts.json`, `catalog/learned/` | built |
| Circuit blocks (DRV8833 stage, charger, LDO, sensor plug) | `src/codegen/circuit.ts` | built, but not named as blocks |
| Generated drivers with host tests run after each firmware build | `include/drivers` (09741c, item 6) | built |
| Bench procedures | `docs/bench-motor.md`, `docs/design/bench.md`, `py/benchlib/` | designed; **no robot bench run yet** |
| Simulation evidence | `drive/rev-N/drive.json` per run | built, per run, not per module |

## The gap

- **No module concept.** Parts, circuit, driver and evidence are not tied together, so nothing can be called "proven".
- **Evidence isn't kept.** Each run's drive result and build results stay in that run's folder and are never added
  up per block.
- **Today's strongest evidence is simulation.** No module has a real bench measurement yet. "Proven on the bench"
  needs the user's hardware.

## Design

`catalog/modules/<id>.json`, one file per module, plus an append-only `catalog/modules/<id>.evidence.jsonl`:

```
module:   { id, kind: "motor-stage" | "power" | "sensor" | "safety" | "compute" | ..., title,
            parts: [{ mpn, role, qty }], circuit: <block name in codegen>, driver?: <include/drivers file>,
            interfaces: [{ kind: "i2c" | "uart" | "pwm" | "power" | ..., pins }],
            limits: { <name>: { value, unit, source } } }        // e.g. stallA per channel, from the catalog's source
evidence: { at, level, run?, revision?, board?, result: "pass" | "fail", measured?: { <name>: { value, unit,
            expected, tolerance } }, by: "simulation" | "host-test" | "build" | "bench" | "field", note? }
```

**Proof levels**, from weakest to strongest. A module's level is the highest one that has a pass and no later fail:

| Level | Meaning | Evidence comes from |
|---|---|---|
| 0 cited | every limit has a datasheet source | the catalog |
| 1 built | the circuit routes with DRC clean and the driver compiles | every run's builds, added automatically |
| 2 tested | the driver's host tests pass | 09741c's driver tests, added automatically |
| 3 simulated | it passed a simulated drive or link test in a settled run | drive.json and link tests, added automatically |
| 4 bench | measured on real hardware, within tolerance of the datasheet | `py/benchlib` results, added by the bench run |
| 5 fielded | N robots built and driven | the user, by hand |

Each settled run (and each fork of a starter robot, 197bfe's item 2) adds evidence records for the modules it used.
A failed simulated drive or a bench measurement out of tolerance adds a fail that names the module. The agents see
each module's level in the parts search, so proven modules are preferred. The report and the dashboard show
"level 3, 14 runs, last 15 Nov".

**Item 5, datasheet sources on every robot check.** Each `MechFigure` and each `mech-*` finding gets
`sources: [{ field, mpn, url, where }]`, collected from the catalog fields the check used. The report prints them under
the figure, and the dashboard renders the link. The data is already in the catalog, so nothing new needs to be
researched.

## Tests (written before the code)

- Loading a module checks that every MPN exists in a catalog and every limit has a source.
- A scripted rover run adds level 1 to 3 evidence for its four modules; a run with a broken drive adds a fail that
  names the motor stage.
- The level is computed from the evidence: a pass, then a fail, gives the lower level.
- Each mech finding carries the source URL of every catalog number it used, for example a mech-current finding cites
  the motor's stallA page and the pack's peak current.

## Order

Item 5 first: it's small and has no dependencies. Then the module files for the rover's four blocks, then evidence
from runs, then the parts-search preference. The Eurobot parts (emergency stop, pull-cord, encoder motors) come with
datasheet sources.
