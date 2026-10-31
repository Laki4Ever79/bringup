# Add a sensor, with real models: the review now keeps it

Real models, `briefs/beacon.md` (which says sensors are out of scope, "for now"), `--review-rounds 2`, and one engineer
change after the first settle: `--change "add a temperature/humidity sensor"`. From wt/firmware d0deb53 (bringup-core
2fc54d3: the review reads change requests as amendments, af's sensor-unwired and reviewer facts, the pin/sensor-mismatch
fix). 1452 s in total.

The question: af's earlier real run (docs/runs/add-sensor-real) rippled the sensor in, then the brief review, judging
against the original brief, had it removed. Does it stay now?

**Yes.** After the request no review called the sensor out of scope again. The first two reviews after it went the
other way: "The amended brief requires a temperature/humidity sensor, but the firmware facts state the product build
has no sensor because it lacks I2C_SDA/I2C_SCL". The agents then gave it I2C pins (GPIO6/GPIO7), and the last review
no longer raised it. The final contract (rev 39) has U2 SHT40-AD1B-R2 on I2C_SDA 6 / I2C_SCL 7, and requirements list
"temperature/humidity sensor".

`ripples.json`, req-1 "add a temperature/humidity sensor": fields requirements, parts; woke architect, parts,
build:board, build:enclosure, build:firmware, grounding, consistency (7 of 9); consistent again 78.8 s after the
request; then 3 review rounds changed requirements, rails, parts, pins, behavior (the pins for the sensor among them).

Final verdict: UNSETTLED at rev 39, 0 violations. The last review's blocker is battery life (the brief's 3 months on
500 mAh against the computed wake profile); a major is that the button should make the beacon show up at once.

What to say: with the engineer's change counted as an amendment to the brief, the review held the design to it (it even
asked for the sensor's wiring) instead of undoing it, and the sensor stayed to the end.

What not to say:
- that the run passed review (it is unsettled on battery life);
- that "add a sensor" added it from nothing: before the request, the parts agent had already put a sensor in more than
  once against the brief (the first-settle reviews flagged it as out of scope, correctly), so the SHT40 was in the parts
  list when the request arrived; the request made it legitimate, then the review rounds wired it;
- that Wokwi simulated this run (docs/runs/wokwi is the mock-model add-sensor run).
