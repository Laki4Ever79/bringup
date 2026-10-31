# Add a sensor, real models (gpt models from .env, real tools)

`npm start -- briefs/beacon.md --change "add a temperature/humidity sensor" --change-delay 5`. The result was
**UNSETTLED** (exit 2): every check passed, but the brief review never did.

- **First design:** a beacon with no sensor. The models put J1 on the bottom edge and SW1 on the right, chose a
  low-Iq XC6206 LDO, and named the button pin BUTTON_WAKE on GPIO9. That name and GPIO are ignored by the firmware,
  whose wake needs BUTTON on GPIO0..5; this is fixed since, in the agents' prompt and the reviewer's facts.
- **The request, `add a temperature/humidity sensor`:**
  - parts added an SHTC3 (U2) at 6.9 s;
  - the architect added a requirement (11.8 s) and raised the rail's average (19.9 s);
  - the firmware agent itself proposed the I2C pins (GPIO4/GPIO5) through change control (15.1 s);
  - parts fixed U2's pin names (43.3 s).
- **Woke 8 of 9:** architect, parts, firmware, the board, case and firmware builders, grounding, and consistency.
  The brief reviewer stayed idle until settle.
- **Peak violations: 7** at revision 17: net-missing ×2, pin-mismatch ×2, part-mismatch, sensor-mismatch and
  vent-missing. It was consistent again in **133.5 s**. The case cut its vent over U2 at (4.5, 23.0) mm.
- **Then the brief review fought the request.** It judged against the original brief ("sensors out of scope") and
  was told the sensorless firmware "reads the sensor" (that fact is fixed since). Its blockers made the agents remove
  the sensor (revision 24–27) and re-add the part without its I2C pins (revisions 28–29). It also blocked on battery
  life: its own 120 mA × 0.3 s / 60 s check gives 34 days against the 90-day target.
- **End state:** revision 29, 0 violations. U2 is in the parts with no I2C pins, and nothing flags a sensor part
  without a bus.
