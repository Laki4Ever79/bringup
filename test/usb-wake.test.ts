// USB wake (engineer, 9 Nov 2026, after real run 4): a deep-sleeping board wakes when USB is plugged in and stays awake
// while it is, so a cable alone reflashes it; requirements.usbWake false turns it off; the engineer is told in the
// report's "Added for you" list.
import { test } from "node:test"
import assert from "node:assert/strict"
import { checkConsistency } from "../src/contract/consistency.ts"
import { circuitFromContract, generatedNets, supportParts, usbWake, USB_SENSE_NET } from "../src/codegen/circuit.ts"
import { pinsHeader } from "../src/codegen/firmware.ts"
import { addedForYou, addedForYouFactLines, addedForYouSection } from "../src/contract/added.ts"
import { designFacts } from "../src/agents/design-facts.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { fixtureContract } from "./fixture.ts"

const logger = () => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	return s
}

test("a deep-sleeping logger gets a VBUS-sense divider on a free wake pin, and the firmware learns the pin", () => {
	const s = logger()
	const wake = usbWake(s)
	assert.equal(wake?.gpio, 0, "the first free deep-sleep wake pin, GPIO2 (strapping) left out")
	assert.deepEqual(wake?.free, [0, 1, 3, 4, 5])
	const divider = supportParts(s).filter((sp) => /USB-sense/.test(sp.job))
	assert.deepEqual(divider.map((sp) => sp.spec.value), ["68k", "100k"])
	assert.deepEqual(divider.map((sp) => sp.spec.lcsc), ["C36871", "C25741"])
	assert.deepEqual(generatedNets(s).get(USB_SENSE_NET)?.sort(), ["U1.GPIO0", `${divider[0].ref}.pin2`, `${divider[1].ref}.pin1`].sort())
	assert.ok(generatedNets(s).get("VBUS")!.includes(`${divider[0].ref}.pin1`))
	assert.match(pinsHeader(s), /#define PIN_USB_SENSE 0\n/)
	assert.match(circuitFromContract(s), /from="\.U1 > \.GPIO0" to="net\.USB_SENSE"/)
	assert.deepEqual(checkConsistency(s, {}).map((v) => v.kind), [])
	// A pin on GPIO0 moves the sense to the next free one.
	const moved = logger()
	moved.values.pins = [...moved.values.pins!, { signal: "BUTTON", gpio: 0, partRef: "SW1", partPin: "A" }]
	assert.equal(usbWake(moved)?.gpio, 1)
})

test("no deep sleep, or usbWake false: no divider, no PIN_USB_SENSE", () => {
	const awake = logger()
	delete awake.values.requirements!.dutyCycle
	assert.equal(usbWake(awake), null)
	const off = logger()
	off.values.requirements = { ...off.values.requirements!, usbWake: false }
	assert.equal(usbWake(off), null)
	assert.ok(!supportParts(off).some((sp) => /USB-sense/.test(sp.job)))
	assert.doesNotMatch(pinsHeader(off), /PIN_USB_SENSE/)
	// No battery capacity in this fixture, so no battery-life figure for the phone-use assumption to qualify.
	assert.deepEqual(addedForYou(off).map((i) => i.id), ["case", "usb-wake-off", "recovery-pads", "bringup-pads", "en-reset"])
})

test("every wake pin taken is a violation for the architect", () => {
	const s = logger()
	s.values.pins = [...s.values.pins!, ...[0, 1, 3, 4, 5].map((g) => ({ signal: `X${g}`, gpio: g, partRef: "U2", partPin: "SDA" }))]
	assert.equal(usbWake(s)?.gpio, null)
	assert.doesNotMatch(pinsHeader(s), /PIN_USB_SENSE/)
	const v = checkConsistency(s, {}).filter((x) => x.kind === "usb-wake-pin-taken")
	assert.equal(v.length, 1)
	assert.deepEqual(v[0].affects, ["architect"])
	assert.match(v[0].message, /GPIO0, GPIO1, GPIO3, GPIO4, GPIO5/)
})

test("the engineer is told what was added, how it shows, what it costs and how to turn it off", () => {
	const s = logger()
	const items = addedForYou(s)
	// "case" first: the fixture doesn't say how the board is housed, so our case is an assumption too.
	assert.deepEqual(items.map((i) => i.id), ["case", "usb-wake", "recovery-pads", "bringup-pads", "en-reset"])
	const usb = items[1]
	assert.match(usb.shows, /pio run -t upload/)
	assert.match(usb.cost, /nothing from the battery/)
	assert.match(usb.cost, /Extended part/)
	assert.match(usb.change, /requirements\.usbWake to false/)
	const section = addedForYouSection(s)
	assert.equal(section[0], "## Added for you")
	assert.equal(section.filter((l) => l.startsWith("| ") && !l.startsWith("| What")).length, 5)
	// The agents and the reviewer get the same list.
	assert.ok(designFacts(s, "").some((l) => l.startsWith("- USB wake:")))
	assert.ok(addedForYouFactLines(s).some((l) => /ROM downloader/.test(l)))
})
