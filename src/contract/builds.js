// What each artifact is built from, in one place for the builders (src/agents/builders.ts: BUILD_INPUTS, BUILD_REQUIRES,
// OPTIONAL_KINDS) and the run timeline (src/timeline/lanes.js, ripple.js: which lane wakes, which waits). A plain ES module
// with no imports: Node imports it, and the dashboard server serves it to the page as /contract/builds.js. It was a hand
// copy in lanes.js until 17 Nov 2026, when the board's rails (an input and a requirement since real run 16) were missing
// from the copy and the board lane showed "building" for a build that would never start.
//   inputs: every field that shapes the artifact; a change to one rebuilds it.
//   requires: fields it can't be built without. Until each has been written (version > 0) a build request is a silent
//     skip: no artifact, no artifact.failed, no recorded inputs, so the consistency participant still sees the
//     artifact as not current and waits (or ends a stuck run, see src/agents/consistency.ts).
//   optional: the field whose presence asks for the artifact; without it the kind counts as current (nothing to build).
export const BUILDS = {
	board: {
		// test: a bottom-side test pad for each net the test field names. links: a link's VCC and an I2C link's bus traces
		// (docs/system.md). rails: the supply nets and their track widths (real run 16, 16 Nov 2026: rails arrived at
		// revision 23 and the board built at 22 without its 3V3 net stayed "current"; 13 boards were built at revisions
		// 10–22, none with its 3V3). The few mechanics and requirements values the generator reads are its derived key
		// (BOARD_DERIVED), so a chassis change alone doesn't rebuild it.
		inputs: ["parts", "pins", "outline", "connectors", "test", "links", "rails"],
		requires: ["outline", "parts", "pins", "rails"],
	},
	// parts: the lid's vent sits over the sensor, wherever the board generator places it. case: walls, height, features.
	enclosure: { inputs: ["outline", "connectors", "parts", "case"], requires: ["outline", "connectors"] },
	// requirements: the product firmware's sleep period is requirements.dutyCycle.periodS (pins.h DUTY_PERIOD_S).
	// model: model.h sizes the tensor arena and the weights the firmware reserves. connectivity: the radio code, the
	// reports and the partition table. links: link.h, the links' protocols and the messages that cross them. behavior and
	// model are optional inputs (behavior.h has defaults; model.h says MODEL_PRESENT 0). mechanics, motion: a robot's
	// firmware is the rover firmware, its hw_pins.h written from them (src/mechanics/firmware.ts roverHeader: the track,
	// the wheel, the turn scale, the cruise speed); without them a mechanics change left the program you flash stale
	// while the simulated drive, which builds its own copy, moved on (27 Nov 2026).
	firmware: { inputs: ["parts", "pins", "behavior", "requirements", "model", "connectivity", "links", "mechanics", "motion"], requires: ["parts", "pins"] },
	// The test pads follow the board's placement (outline, connectors, parts); the limits follow the power budget (rails,
	// requirements); the self-tests follow the pins and parts. Only when the contract has a test field.
	testkit: { inputs: ["test", "outline", "connectors", "parts", "pins", "rails", "requirements"], requires: ["test", "outline", "pins"], optional: "test" },
	// The chassis follows the mechanics layout, the targets (the payload's mass) and the board's size (its standoffs).
	// assembly: the other boards' places and built sizes. connectors, parts: where the board's mounting holes are (a
	// corner a connector covers has none; the scripted rover moved its connectors at revision 11 and kept a chassis with
	// the old corners, 15 Nov 2026). Only with a mechanics field.
	chassis: { inputs: ["mechanics", "motion", "outline", "assembly", "connectors", "parts"], requires: ["mechanics", "motion", "outline"], optional: "mechanics" },
	// The simulated drive runs the firmware (pins, parts) on the mechanics (mechanics, motion, the board's size).
	drive: { inputs: ["mechanics", "motion", "pins", "parts", "outline", "assembly"], requires: ["mechanics", "motion", "pins"], optional: "mechanics" },
	// A robot arm's printed parts (py/arm.py through src/tools/arm.ts): the arm's joints, servos and base, swept through
	// the poses armTargets asks for (pick, drop and the approach above each). Only with an arm field.
	arm: { inputs: ["arm", "armTargets"], requires: ["arm"], optional: "arm" },
	// The arm's pick-and-place in the loop (src/tools/drive.ts runArmDrive): its firmware (pins, parts) drives the MuJoCo
	// arm (arm, armTargets: the cup, the repeats) in QEMU. Only with an arm field.
	armsim: { inputs: ["arm", "armTargets", "pins", "parts"], requires: ["arm", "armTargets", "pins"], optional: "arm" },
	// The CNC's firmware in the loop (src/tools/cnc-sim.ts runCncSim): grblHAL's simulation build from the board map (pins,
	// parts) and settings (cnc, cncTargets) runs in Renode: steps per motor, the e-stop, the stall stop, a hard limit. Only
	// with a cnc field.
	cncsim: { inputs: ["cnc", "cncTargets", "pins", "parts"], requires: ["cnc", "pins"], optional: "cnc" },
}
