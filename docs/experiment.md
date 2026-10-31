# Experiment: one change, the whole design follows

Run 2026-10-31 with `npm run experiment` (real builders: tscircuit + KiCad, build123d, PlatformIO). Raw numbers: `docs/experiment-results.json`.

Across 6 changes: arm A ended with 0 violation(s); arm B would have shipped 16 cross-domain mismatch(es).

| Change | Arm A: consistent again | Arm A: woken | Arm A: violations at end | Arm C: builds one at a time | Arm B: heard by | Arm B: mismatches shipped |
| --- | --- | --- | --- | --- | --- | --- |
| Make the board 10 mm narrower | 53.1 s | 2 of 7 (board-builder, enclosure-builder) | 0 | 75.9 s | board | 4: board hole at (37, 3) mm has no standoff under it; board hole at (37, 27) mm has no standoff under it; standoff at (47, 3) mm has no board hole over it; standoff at (47, 27) mm has no board hole over it |
| Make the board 6 mm taller | 31.3 s | 2 of 7 (board-builder, enclosure-builder) | 0 | 83.3 s | enclosure | 5: board is 50×30 mm, contract says 50×36 mm; board hole at (3, 27) mm has no standoff under it; board hole at (47, 27) mm has no standoff under it; standoff at (3, 33) mm has no board hole over it; standoff at (47, 33) mm has no board hole over it |
| Move the USB-C port to the bottom edge | 51.9 s | 2 of 7 (board-builder, enclosure-builder) | 0 | 63.9 s | board | 1: cutout for J1 is left@15 mm 10×4.5, connector is bottom@25 mm 9×3.5 |
| Move the sensor's I2C bus to GPIO4/GPIO5 | 71.9 s | 4 of 7 (firmware-reviewer, board-builder, firmware-builder, grounding-check) | 0 | 90.8 s | firmware | 2: net I2C_SDA does not connect U1.GPIO4; net I2C_SCL does not connect U1.GPIO5 |
| Swap the LDO for the low-Iq XC6206 (3 pins, no EN) | 31.1 s | 3 of 7 (board-builder, firmware-builder, grounding-check) | 0 | 35.6 s | firmware | 1: board places AP2112K-3.3TRG1 as U3, contract says XC6206P332MR-G |
| Add a user button (GPIO3, reachable through the case) | 67.9 s | 5 of 7 (firmware-reviewer, board-builder, enclosure-builder, firmware-builder, grounding-check) | 0 | 93.7 s | firmware | 3: net BUTTON does not connect U1.GPIO3, SW1.A; enclosure has no cutout for SW1; board has no SW1 (TS-1187A-B-A-B) |

**Method.** The models are scripted (the keyless mock agents); the tools are real. Each trial starts from a freshly settled
logger design (briefs/logger.md). The change's contract writes are then made by the fields' owners, exactly as the
agents' propose_contract_change tool makes them. **Arm A** is the normal runtime: the shared contract plus Mozaik
situations. Its time runs from the first write until the consistency participant settles, and that includes its 1.5 s
quiet window. "Woken" counts the participants that did work after the change: an agent turn, a build or a grounding
pass. **Arm B** is a simulated "every team works from its own copy" baseline. Only the domain that received the change
rebuilds (its artifact is the one arm A's builder produced from the same contract), and every other domain ships what
it had built before the change. The same plain-code checks as arm A then run against the changed design. A mismatch no
checker looks for counts as 0, not as a pass. The part check (each part's MPN on the board against the parts list) arrived
with the LDO-swap trial; the LDO-swap and button trials were rerun with it. The other four changes don't touch the parts
list, so it couldn't change their arm B. **Arm C** is arm A with the builders made to take turns, for a
parallel-versus-sequential wall-clock on the same change. Each cell is one run on one laptop, and timings vary
from run to run (the tools share the CPU), so read the times as tens of seconds, not exact. Arms B and C are switches for the experiment only; runs never
use them.
