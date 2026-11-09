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

## Checks

Board level (each board's own consistency check, so its own agents are woken):
- the link's connector is a part, placed on an edge (the case cuts its opening);
- UART: `<link>_TX` and `<link>_RX` are assigned, on the connector's IO pins the link names;
- I2C: the board has I2C_SDA and I2C_SCL; the generator wires the connector to them;
- `supply: "in"` and a regulator on 3V3 at the same time.

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

`npm run dashboard`, then **Systems** in the header (or `/system`):
- **Start a system:** choose a spec from `briefs/systems`. Scripted (free) is on by default; unticking it uses real models.
- **The system's page:**
  - its boards and the cables between them, as a diagram;
  - a card for each board, with its render, contract revision, size, connectors and link pins;
  - the system checks, the QEMU link tests and the cable tables;
  - while it runs, a Stop button.
- **Open board:** shows that board on the normal run page (run id `<system>.<board>`), with a link back to its system.

## Firmware

Everything link-specific is generated into `include/link.h`, so `main.cpp` only calls three functions: `linkBegin()`
at boot, `linkSendReading()` after each reading, and `linkPoll(ms)` while awake. Messages travel in frames
(`include/linkframe.h`): sync bytes, the definition's hash, the length, the payload, a checksum. A receiver drops a
frame whose hash it doesn't know, so two boards built against different definitions never misread each other.

- A message named `reading` is filled from the board's reading by field name (`tempCx100`, `rhx100`, `tempC`, `rh`,
  `ok`); any other field is sent as 0. A failed reading is sent only in a message with an `ok` field.
- I2C messages go from the controller to the target for now; a target can't start a transfer.
- The product firmware deep-sleeps, so a receiving board hears a link only while it is awake: on USB power (USB wake
  keeps it awake) or during its own wake. A receiver that must always listen needs a design without a duty cycle.

## Testing

| Level | How |
|---|---|
| Each board | its own checks, builds, QEMU boot and test kit, as for any design |
| Between boards, static | the system checks above, in code, on every settle |
| Between boards, running | the link-test build (`pio run -e esp32c3_linktest`: a known reading every half second, whatever arrives printed) of both boards, in two QEMUs joined by a virtual cable (UART links). Verified 9 Nov: the reading arrives intact; with a different definition on one side, its frames are dropped and the test fails |
| On the bench | the same link-test build flashed on both boards, with the real cable. I2C links can only be tested here: QEMU can't join two buses |

## Phases

1. Links on each board, the system checks, the cable and the shared header, `bringup system` over two boards. (done)
2. Two-chip UART tests in QEMU. (done) A generated system test plan for the bench. (next)
3. Imported boards as fixed members; board revisions pinned per system.
4. An integrator agent that proposes links from a system brief.
