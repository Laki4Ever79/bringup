# A real-model run that settles and passes the brief review

`npm run bringup -- briefs/beacon.md --review-rounds 4`, with real models (architect and reviewer on the strong model),
real tools (tscircuit, KiCad, build123d, PlatformIO, QEMU), from wt/firmware-orphan 4b77afd, started 31 Oct 22:39 CET.
It settled at contract revision 19 with 0 violations, and the final brief review passed on its second round (22:48).
Files: `report.md`, `trace.jsonl` (554 events), `contract.json`; local paths are replaced with `<run>` / `<local>`.

## What happened

| Revision | What |
|---|---|
| 1–13 | Architect, parts and firmware agents drafted the design concurrently; the live checks flagged `part-unconnected` twice along the way |
| 13 | Review 1: **fail**. Blocker: "a status LED that blinks … and shows charging state" read as one LED doing both, while the design had D1 (wake blink) and D2 (hardware charge LED). Major: the stated rail averages did not match the duty-cycle check. Minor: no size margin |
| 14–15 | The architect rewrote the requirements toward one LED; the parts agent clarified the indicator and the no-sensor scope |
| 17 | The architect set the 3V3 rail average to 0.077 mA from the duty-cycle check's datasheet phase currents (30 ms at 28 mA, then 50 ms at 84 mA, every 60 s) and the rail peak to 84 mA |
| 18 | The architect removed the charge LED |
| 19 | The parts agent put the dedicated charge LED and its 1k resistor back |
| 19 | Review 2: **pass**, one minor finding (two LEDs instead of one doing both). Settled |

The final design: ESP32-C3-MINI-1, XC6206 LDO (1 µA Iq), TP4054 charger, USB-C, JST-PH battery connector, a status LED
on GPIO1, a hardware charge LED on the charger's CHRG pin, a wake button on GPIO0; 50 × 30 mm; battery estimate
231 days against the 90-day target. The firmware compiles and boots in QEMU at revision 19. The case builds and passes
its print check.

## What made the difference (all tonight, all general causes, none in the reviewer's standards)

Every earlier real run failed the review. The general cause was **information asymmetry**: the reviewer judged with
facts and computed checks the designers never saw. The fixes:

- `designFacts` (src/agents/design-facts.ts): one source of part facts, firmware facts, field meanings and the live
  power budget for the reviewer **and** every designer turn.
- Live checks during design instead of at the final review: `battery-short` and `part-unconnected` (this run hit the
  latter twice and fixed it before the review).
- The battery check charges each wake phase at the MCU's datasheet current (ESP32-C3 datasheet v2.4: CPU 28 mA, radio
  receiving 84 mA as the stand-in for the missing BLE figure), with the rail peak kept as a labelled worst case.
  Before, it charged the whole wake at the rail's peak, a modelling error the reviewer trusted.
- CONTRACT_SHAPES examples marked as examples ("U2 = sensor" had been read as a mandate, so beacons got sensors).

## What to say

- "A real-model run settled and passed the final brief review: the beacon brief, concurrent Mozaik agents on one
  contract, real board, case and firmware builds, about 8 minutes."
- "It failed the first review, fixed itself, and passed the second."
- "What got us there was making the designers see what the reviewer sees, and turning review checks into live checks."

## What NOT to say

- Not "passes every time": the night's real runs were used to find and fix general problems, and runs on the final code still failed on genuine design trade-offs (LDO dropout, a short advertising window, battery assumptions).
- Not "the agents resolved the LED question": the same two-LED design was a blocker in review 1 and a minor in review
  2. The architect removed the charge LED at rev 18 and the parts agent put it back at rev 19. The pass on that point
  is reviewer judgement on an ambiguous brief line ("a status LED that … shows charging state").
- Not "ready to order": KiCad DRC reports 2 errors (`hole_clearance`, the USB-C vendor land pattern's pads next to its
  own locating holes) and 88 warnings (mostly silkscreen); stock is unknown (the live search returned none).
- Not "measured battery life": 231 days is computed from the duty cycle and datasheet currents, with the receive
  current standing in for BLE, and it leaves out the LED blink and phone connections (the check says the target leaves
  room for several full-length connections a day).
- Not "simulated in Wokwi": this run booted in QEMU only.
