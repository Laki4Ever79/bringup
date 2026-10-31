# File sync with real models

A real-model `--stay` run (logger brief, `--review-rounds 2`) from wt/firmware 8529046, before the linked folder. The
first settle (rev 14) was unsettled: the brief review still failed. Then the newest generated
`firmware/rev-14/include/pins.h` was edited: `PIN_I2C_SDA 5 → 6` (`pins.h.before-edit` → `pins.h.edited-rev-14`).

What happened (trace.jsonl):
- 12:50:02.9 saved; 12:50:03.2 `change.requested` req-1 "edited pins.h: I2C_SDA GPIO5 → GPIO6" (source: the file).
- 12:50:08.1 the architect, who owns pins, applied it: rev 15, "moving I2C_SDA from GPIO5 to GPIO6 while keeping all
  other pin assignments unchanged".
- Then 90 s of churn (pins v8 → v29). The firmware agent, woken by `pin-mismatch` against a firmware build that had
  not been rebuilt yet, twice proposed moving the contract back to the stale build's pin, and once the architect
  approved it. The firmware and the architect also argued over a BUTTON pin on SW1, which the contract lists as a
  connector, not a part.
- It ended with I2C_SDA on GPIO6, as edited, and 0 violations, but unsettled at rev 38 (`report.md`; the review still
  fails). `ripples.json`: fields pins, parts; peak 4 violations; consistent again 584.6 s after the save.

What to say: a hand edit to a generated file reached the real owner agent as an engineer request in 5 s, and the final
design kept it. What not to say: that it settled cleanly or quickly with real models. It shows a real weakness: a
`pin-mismatch` can only mean the firmware has not been rebuilt yet (the firmware is generated from the pins), yet it
wakes the firmware agent, who changes the contract to match the stale build.
