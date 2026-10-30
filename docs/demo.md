# Demo script (3 minutes)

For the live demo at NTP (Sat 31 Oct, 17:00) and the recorded video. The times are targets; the run itself takes
longer than 3 minutes, so for the video, record a full run and cut it, and for the live demo, start the run before
you start talking.

**Before you start**
- Run `npm test` once. The integration tests confirm tscircuit, KiCad (Docker), build123d and PlatformIO are all detected.
- Start the run, then the dashboard in a second terminal:
  ```bash
  npm run bringup -- briefs/logger.md            # real models; add --mock if there's no key or no network
  npx tsx src/dashboard/cli.ts out/<runId>       # prints the dashboard URL (default port 4317)
  ```
- Have three windows ready: the terminal, the dashboard, and the Mozaik Cloud link that `runLoop` prints.
- Have `briefs/logger.md` open in an editor tab.
- Fallback: if the network or the gateway is down, use `--mock`. The tools are real and only the models are scripted.

---

## 0:00 – 0:20 · The problem

> "Small boards fail at bring-up because domains drift apart: the schematic says GPIO8, the firmware says GPIO4, and
> the USB port is 2 mm off the hole in the case. Bringup keeps them in agreement while they're being designed."

Show `briefs/logger.md`: one page, written like a product person would, with no pin numbers.

## 0:20 – 0:50 · One contract, many agents waking at once

Switch to the dashboard.

- Point at the event stream. The architect writes the contract fields (requirements, outline, connectors, rails,
  pins), and each `contract.changed` wakes **only** the participants whose situations match that field.
- Point at the **board, enclosure and firmware builds running at the same time**: three `artifact.ready` events
  arrive in parallel, not in a pipeline.
- Say it: "No orchestrator. Nobody calls anybody. Every agent subscribes to the fields it depends on, so the Mozaik
  situations *are* the dependency graph."

## 0:50 – 1:30 · Change control through interception (the money shot)

- The brief asks for a status LED, but the first pin plan only wires the sensor's I2C bus. The firmware agent notices
  and calls `propose_contract_change` for `pins` to add `STATUS_LED`.
- The firmware agent doesn't own `pins` (the architect does), so the call is **held mid-loop** by a Mozaik
  `InterceptionHandler`. Point at the yellow `change.proposed` line.
- The architect wakes, reads the contract and approves. Point at `change.decided` (approved), then the held tool call
  resuming, then a new `contract.changed` for `pins`.
- Point at what reacts: the board and firmware rebuild, and the **enclosure doesn't**, because it doesn't depend on
  pins.
- Say it: "That's an engineering change order: the owner of the field signs off, and the requester waits, instead of
  overwriting it."

## 1:30 – 2:00 · Violations caught and fixed

- Point at a `consistency.checked` line with a violation, for example `pin-mismatch` (firmware still built from the old
  pins) or `cutout-misaligned`. Each violation lists the roles it `affects`, and only those wake.
- Then point at the next check coming back clean, and `design.settled`.
- Say it: "The checks are plain code, not an LLM. They read what was actually built. For example, the firmware's pin
  map is parsed back out of the header it compiled."

## 2:00 – 2:35 · The artifacts

- **Board**: the dashboard's board panel shows the KiCad render of the routed board.
- **Enclosure**: open `out/<runId>/enclosure/rev-N/case.stl` (any STL viewer, or the slicer). The USB-C hole sits on
  the contract's edge and offset.
- **Firmware**: show `out/<runId>/firmware/rev-N/include/pins.h`, which defines `PIN_I2C_SDA`, `PIN_STATUS_LED` and
  `BRINGUP_REVISION`, and the PlatformIO `SUCCESS` line.
- **Report**: `out/<runId>/report.md`: settled, 0 violations, and changes proposed, held, approved and rejected.

## 2:35 – 3:00 · How it uses Mozaik (closing)

Switch to the Mozaik Cloud link and show the agents' loops side by side.

> "Every agent is its own `runLoop`, running concurrently. The shared design contract lives in Mozaik's
> `RuntimeState`. Situations decide who wakes for which change. An `InterceptionHandler` turns cross-owner edits into
> change control. And because Mozaik 4.1 has a few rough edges, there's an outbox so every agent sees events in the
> same order, and a guard so a crashed agent says so instead of going quiet. It's all in the README."

---

## Optional segments (only if the feature has landed)

- **Mid-run change request.** While the run is going (after the first `artifact.ready`), type in a second terminal:
  ```bash
  npx tsx src/request.ts out/<runId> "make the board 60 mm wide"
  ```
  (From Claude Code with the MCP server: `request_change {runId, text}`.) The engineer's message wakes the architect,
  which proposes `outline` with `widthMm: 60`. Point at the new `contract.changed` for `outline`: the board and the
  enclosure rebuild, the firmware doesn't (it doesn't depend on the outline). The board's `outline-mismatch` shows
  until the rebuild lands, then clears, and the report says `Board 60×30 mm`. In a mock run this takes about 30 s
  from request to `design.settled`. The mock architect only understands "<N> mm wide"; real models take any wording.
  Send it before the run settles: requests that arrive after `design.settled` are not picked up. Do this at 1:30, in
  place of or right after the violations segment.
- **Design tournament** (not built yet). Two branches, ESP32-C3 and nRF52, run in parallel and are scored live. Show
  the scoreboard at 2:00 and skip the enclosure close-up to keep to time.
- **Firmware in QEMU** (only if `tools/qemu` is installed). Show the serial output `bringup rev N` and then
  `SENSOR FAIL`. That's expected: there's no sensor in emulation.

## If something goes wrong live

- **A build fails.** That's fine to show: `artifact.failed` is an event too, and the report names the missing tool.
- **The run doesn't settle in time.** Switch to the recorded video at the same timestamp.
- **The dashboard is blank.** Check that you passed the right `out/<runId>`. The trace is replayed from the start, so
  reloading the page is safe.
