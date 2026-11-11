# Systems of boards

Approved 9 Nov 2026: UART links first, then I2C, and as much as possible without making a single-board design any
harder to read or work with.

## The rule: a board stays a board

A system is a layer on top. Each board is an ordinary Bringup design with its own contract, agents, builds and report,
run exactly as today. A board imported with `adopt` can be a member too, marked **fixed**: the others adapt to it.
Nothing in the system layer runs for a single-board design, and a board's contract only grows one optional field.

| Layer | Holds | Owned by |
|---|---|---|
| Board contract (unchanged) | requirements, outline, parts, pins, case, … | the board's agents |
| Board contract, new optional field `links` | what this board must expose for each link: the connector, the protocol, its side of it, the messages | the system's **integrator** |
| System spec (`system.json`) | the boards, the links between them, the cable, the messages | the engineer (and later an integrator agent) |

## Links

A link joins two boards' connectors with a straight cable. The connector is the 4-pin JST SH (SM04B-SRSS-TB, LCSC
C160404, the Qwiic / STEMMA QT connector): pin 1 GND, 2 VCC, 3 IO1, 4 IO2.

| Kind | IO1 | IO2 | On each board |
|---|---|---|---|
| `uart` | TX on one board, RX on the other | the opposite | pins `<link>_TX` and `<link>_RX` on the connector; the system puts side A's TX on IO1 and side B's on IO2, so a straight cable crosses them |
| `i2c` | SDA | SCL | the board's own I2C bus (the ESP32-C3 has one I2C controller), so a board that drives a local sensor must be the link's controller |

VCC is wired only when the link carries power: `supply: "out"` on the board that powers the other, `"in"` on the one
it powers (which then has no regulator of its own on 3V3). Otherwise pin 2 stays unconnected on both boards, and two
regulators never meet.

### Kinds

Every kind is one entry in `src/contract/link-kinds.ts`, which the spec check, the board's `links` field, the budget
and these docs read. Kinds not built yet are named, and a spec that uses one gets "kind spi is planned
(docs/system.md), not built yet" instead of a half-made link.

| Kind | Medium | Peripheral | GPIOs per side | Carries | Built | Tested by |
|---|---|---|---|---|---|---|
| `uart` | 4-pin cable | UART1 | 2 | messages | yes | checks, compile, host codec, QEMU, bench |
| `i2c` | 4-pin cable | the board's I2C bus | 2 (0 if the bus exists) | messages, both ways | yes | checks, compile, host codec, bench |
| `spi` | 6-pin cable | SPI2 | 4 | messages | planned | |
| `i2s` | 6-pin cable | I2S | 3 | an audio stream | planned | |
| `espnow` | radio | the radio | 0 | messages | planned | |
| `ble` | radio | the radio | 0 | messages | planned | |

The design for the planned kinds, and the order they come in, is in
`docs/superpowers/specs/2026-11-11-board-links-design.md` (local).

## Checks

Board level (each board's own consistency check, so its own agents are woken):
- the link's connector is a part, placed on an edge (the case cuts its opening);
- UART: `<link>_TX` and `<link>_RX` are assigned, on the connector's IO pins the link names;
- I2C: the board has I2C_SDA and I2C_SCL; the generator wires the connector to them;
- `supply: "in"` and a regulator on 3V3 at the same time;
- **the budget:** each link takes a peripheral and GPIOs from the kind table. The ESP32-C3 has one free UART (UART0 is
  the console), one I2C bus (I2C links share it), one SPI, one I2S and one radio, and seven GPIOs a design may use
  (4, 5, 6, 7, 3, 1, 0: not the strapping pins 2, 8, 9 nor USB 18, 19). Over budget names the links and what would fit
  ("make L2 I2C (it shares the board's bus), or free pins"). The spec check counts the peripherals before anything runs.

System level (computed in code from both boards' contracts and the spec):
- UART: one side's TX meets the other's RX through the cable; both sides run the same baud rate;
- I2C: exactly one controller; every target address unique on the bus, the boards' own devices included; exactly one
  set of pull-ups; a cable short enough for the bus capacitance at the bus speed (an estimate, labelled);
- both boards at the same logic level (3.3 V);
- power over the link: the supplying board's regulator covers both boards' peaks, and the cable's drop leaves the
  powered board within its supply range (an estimate, labelled);
- both firmwares built against the same message definition (one hash on both sides).

## Outputs

Per system: `system-report.md` (boards, links, checks, what each board was asked to change), `cable.md` and a WireViz
`cable.yml` (render it with WireViz if you have it), and one message header that both firmwares include.

## Running it

`bringup system <system.json>` starts each board's run (or reads a finished one), hands each board its `links`, and
re-checks the system whenever a board settles. A system violation goes to the board that can fix it, as a
change request. Board runs stay separate processes: Mozaik allows one runtime per process, and it keeps each board
exactly as it runs alone.

## On the dashboard

`npm run dashboard` opens **Home**. Every page has the same bar: **Bringup · Home · Designs · Docs**, the section
you're in underlined, and on the right a trail of where you are (*Designs › logger and beacon over UART › logger*), each
step a link back up. The pages follow the levels of what is designed: a **design** (the device) has one board or
several, and each **board** has its layers (PCB, case, firmware).

| Page | Address | What it is for | How you get there |
|---|---|---|---|
| **Home** | `/` | An example turning in 3D (the logger and beacon, the pocket logger, the indoor rover) and the sentence that made it. Change it or write your own, then **Build**. | The bar; the logo |
| **Plan** | `/plan/<id>` | After Build: the proposed boards and cables, nothing built yet. Drag to edit, change in words, see the checks and estimates, then build. | Build on Home |
| **Designs** | `/designs` | Every design, one board or several, with its board count and state. "Start from a file": a written brief (`/builds`) or a system file (`/system`). | The bar |
| **A design** | `/system?id=<id>` | Its **Overview**: the boards assembling in 3D (a robot as the robot: chassis, wheels, sensor), cables, timeline, checks, cable and bench test. Under the bar, **Overview · Boards: logger · beacon**. | Designs; the end of a plan |
| **A board** | `/system?id=<id>&board=<name>` | That board's own page, filling the window under the bar: the status band, agents, contract fields, timeline, then the PCB (most of the window), case, parts, and the **Firmware** tab. | Its tab, or clicking it in 3D |

- **Home's examples** are finished runs shipped in `examples/` (`scripts/save-example.ts`), so showing them costs
  nothing. "Try for free" builds with the scripted architect and agents, which know the logger, the beacon and the
  rover: it picks the one your sentence describes, and two boards only when two boards or a cable are asked for.
- **The plan:** drag a board, drag its orange dot onto another board for a cable (UART or I²C), Delete, "+ board",
  click a board for its brief; "Change the plan in words" asks the architect again. The checks run in plain code on
  every edit. Time estimates come from recorded real runs; cost once three runs carry cost data.
- **A one-board design** opens on its Overview too, with its board one level down (a design with one board, not a
  different kind of thing). A board's address from before (`/?run=<id>`) leads to its design with that board open;
  `&standalone=1` shows the board page on its own.
- **The Firmware tab** (on every board): each firmware revision's source files, the ones generated from the design
  marked "gen", compared with the revision before (or any other) file by file and line by line, changes only or the
  whole file. Read-only.
- **Spend:** every model call's tokens and cost go to `usage.jsonl` in its run folder (prices in
  `src/inference/prices.ts`, with the date they were checked). Each page shows what was spent. "Unknown" means the
  provider didn't report tokens, never $0. Runs from before 9 Nov 2026 say "not recorded".
- **Speed:** `npm run perf` loads these pages in a visible Chromium on this machine's GPU and fails if the start screen
  takes over 1 s, a frame of an orbit or a zoom takes over 33 ms, or an idle scene draws at all.
- **Browser tests:** `test/system-view.browser.test.ts` (headless Chromium, over a recorded system in `out/`) checks
  that a board fills the window under the bar, the tabs switch in place, the PCB gets most of the window, the
  Firmware tab and the phone-width headers.

## Firmware

Everything link-specific is generated into `include/link.h`, so `main.cpp` only calls three functions: `linkBegin()`
at boot, `linkSendReading()` after each reading, and `linkPoll(ms)` while awake. Messages travel in frames
(`include/linkframe.h`): sync bytes, the definition's hash, the length, the payload, a checksum. A receiver drops a
frame whose hash it doesn't know, so two boards built against different definitions never misread each other.

- A message named `reading` is filled from the board's reading by field name (`tempCx100`, `rhx100`, `tempC`, `rh`,
  `ok`); any other field is sent as 0. A failed reading is sent only in a message with an `ok` field.
- I2C messages go both ways. A target can't start a transfer, so what it sends waits as one frame; the controller
  reads it (`Wire.requestFrom`) from each sending target at most every 200 ms, and the target hands each frame over
  once. So a target sends one message per link (the spec check says so). It works only while both boards are awake:
  in the product firmware that means both on USB, since a target deep-sleeps right after its reading (the bench plan
  says so). A board on I2C links is the controller on all of them, or the target on exactly one.
- The product firmware deep-sleeps, so a receiving board hears a link only while it is awake: on USB power (USB wake
  keeps it awake) or during its own wake. A receiver that must always listen needs a design without a duty cycle.

## Testing

| Level | How |
|---|---|
| Each board | its own checks, builds, QEMU boot and test kit, as for any design |
| Between boards, static | the system checks above, in code, on every settle |
| The frame codec | `test/linkframe-host.test.ts`: `linkframe.h`, the one frame every message kind uses, compiled with this computer's g++ and run: round trip, resync after garbage, split reads, a bad checksum, an over-long frame, the largest payload, two frames back to back |
| Between boards, running | the link-test build (`pio run -e esp32c3_linktest`: a known reading every half second, whatever arrives printed) of both boards, in two QEMUs joined by a virtual cable (UART links). Verified 9 Nov: the reading arrives intact; with a different definition on one side, its frames are dropped and the test fails |
| What QEMU can't do | Espressif's QEMU here models no radio, I2C or I2S for the C3 (checked 11 Nov in its device list). It does model the TWAI (CAN) controller. So only UART links run between two QEMUs; I2C, and the radio kinds once built, are tested on the bench |
| On the bench | `bench-plan.md`, generated with the cable on every check (below). I2C links can only be tested here: QEMU can't join two buses |

### The bench test plan

Every system run writes `bench-plan.md` (steps for a person) and `bench-plan.json` (what the checker expects) next to
`cable.md`, from the same contracts. The system page links it as **Bench test**. The steps, in order:

| Step | Passes when |
|---|---|
| 1. Each board alone | its own production test passes (with a test kit); otherwise its USB port prints `SENSOR OK …` at each reading and its LED blinks |
| 2. The cable | each wire beeps through end to end; no two pins short; VCC absent on a link that carries no power |
| 3. Power over the cable (links that carry it) | 3.2 to 3.4 V at the other board's pin 2 (an estimate: the catalog has no regulator accuracy), and it boots |
| 4. The link | each message arrives at least 3 times in 15 s with the link test's known values; no frame from another definition |
| 5. Pull the cable | the received lines stop while it is out and come back after |
| 6. The product firmware | real readings arrive, on the receiving board's USB port |

Step 4 uses the bench build of the link test, `pio run -e esp32c3_linktest_usb -t upload`. It prints on the USB port
(the QEMU build prints on UART0) and keeps sending until reset, so the boards don't have to start together. The checker
reads every board's USB port at once and judges the lines as the QEMU link test does:

```bash
.venv/bin/python py/bench_system.py out/<system>/bench-plan.json --port logger=/dev/ttyACM0 --port beacon=/dev/ttyACM1
.venv/bin/python py/bench_system.py out/<system>/bench-plan.json --log beacon=beacon.txt   # saved output
```

**Not done:**
- **No boards yet:** nothing in the plan has run on real boards; none have been built.
- **The product firmware's USB output is compiled and checked in QEMU, not yet seen on a real board.** It prints on
  UART0 (QEMU) and on the C3's own USB at once (main.cpp, `Console`); a USB write never waits for a host.
- **Manual checks:** the meter steps (2 and 3) are done by hand.


## Phases

1. Links on each board, the system checks, the cable and the shared header, `bringup system` over two boards. (done)
2. Two-chip UART tests in QEMU. (done) A generated system test plan for the bench. (done, not run on hardware)
3. Imported boards as fixed members; board revisions pinned per system.
4. An integrator agent that proposes links from a system brief.

Links of every kind, a separate track (the design in `docs/superpowers/specs/2026-11-11-board-links-design.md`):
1. The kind table, the budget, I2C messages both ways, the host codec test. (done)
2. SPI and I2S on a 6-pin cable.
3. ESP-NOW and Bluetooth LE between boards.
4. On the dashboard: choosing the kind, radio links drawn as arcs, an example system using three kinds.
5. Later: CAN for long cables, buses of more than two boards, Wi-Fi between boards.
