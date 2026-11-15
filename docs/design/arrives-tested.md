# "Arrives tested": ordering a robot's boards so they come back tested (design note, nothing built)

Status: design only, 15 Nov 2026. **Nothing is ordered and no fab is contacted by this design or by any code written from
it without the user's explicit yes for that order.** The idea comes from the competitor review (a module maker that ships
boards built from tested blocks). We borrow the product pattern only.

## The promise

A team presses "order" on a robot and gets back boards that have each passed the test their own design calls for. Every
board's result is recorded against the revision that was ordered. Those results are what the module library (item 1,
d9610c) counts as "proven".

## What already exists (and covers most of it)

| Piece | Where | State |
|---|---|---|
| Fab files: Gerbers, drill, JLC assembly BOM and placement | the board build (`fab/`) | built every run |
| Bring-up pads on every board, by default | `src/codegen/circuit.ts` `testPoints`, `docs/test-kit.md` | built |
| Test plan with pass limits per step (power, current, self-test, sleep current) | `testkit/rev-N/test-plan.json` | built |
| Factory-test firmware | `testkit/rev-N/firmware` (`esp32c3_test`) | built; ESP32-C3 only |
| Printable bed-of-nails fixture, checked against the built pads | `testkit/rev-N/fixture.stl` | built |
| Bench tests a person runs: one drive motor, the system's cable link | `docs/bench-motor.md`, `src/system/linktest.ts` | built |
| Host tests of every motor and sensor driver | `src/tools/driver-tests.ts` | built 15 Nov |
| Price, stock and lead time per part, boards and robot parts | `agents/bom.ts`, `src/tools/robot-parts.ts` | built 15 Nov |

## What is missing

1. **An order bundle.** One folder per order: the fab files, the test plan and factory-test firmware for the **same**
   revision, the fixture, and the parts list with prices and stock as checked at order time. Plus a manifest that hashes
   each file, so a result can be traced to exactly what was made.
2. **A result record.** What a tested board reports, kept with the order:
   `{ order, board, revision, serial (the chip's unique id), step, measured, limit, pass, at, by: "bench" | "fab" | "user" }`.
   The factory-test firmware already prints its steps over USB; `py/bench.py` would write these records.
3. **Three ways a board can get tested.** Each feeds the same record, and the user picks one per order:
   - **The user tests.** They print the fixture and run the factory test on their own laptop over the one USB-C. No
     appliance to buy (the user's rule: test points must not tie anyone to extra hardware from us).
   - **The fab's own test.** Some assembly houses run a customer-supplied functional test. We send the firmware and the
     plan in the bundle. Not checked with any fab; this needs the user's go before anyone is contacted.
   - **We test.** Later, if ever: the boards come to us and go on the fixture. That's a business decision, not code.
4. **A gate.** "Order" only writes the bundle and a draft order summary: boards, quantities, the price as checked, and
   lines out of stock or not checked. Placing it is a separate, explicit act by the user at the fab's own site. Bringup
   never places an order and never stores payment details.
5. **Results feed back.** A failed step becomes a contract finding against that revision, the same way a mid-run change
   request does. Passed boards add one "proven" count to every module block on them (the shape d9610c defines for item 1).

## Checks this adds (plain code, like the rest)

- `order-stale`: the bundle's revision is not the contract's current one, or its parts check is older than a set age.
- `order-untestable`: a board in the order has no test plan, or its factory-test firmware didn't build (today: any
  non-ESP32-C3 board).
- `order-stock`: a line is out of stock at the chosen supplier when the bundle is written. This only warns, it doesn't
  block, as stock-outs are advisory today.

## Smallest step when the user says go

Build items 1 and 2 (the order bundle and the result record) for the rover's main board. Then fill one result record
from a real bench run of `bench_motor` plus the factory test on a board already in hand. No order is needed for that
step.

## Open questions for the user

- Which assembly house first, and whether to ask them about a functional test step. This would mean contacting a fab, so
  it waits for the user's yes.
- Whether "we test" belongs in the product at all, or stays out.
