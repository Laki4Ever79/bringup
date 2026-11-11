// What Bringup decided for the engineer without being asked (engineer, 9 Nov 2026: "users should know what we
// implemented and how it would manifest", and be given an option where there is one). Each entry says what was added,
// how the engineer will notice it on the device, why, what it costs and how to change it. The report lists them
// ("Added for you"), and the agents and the reviewer get the same lines in their design facts.
import { enclosureMode, type ContractSnapshot } from "./types.ts"
import { downloadStrap, recoveryBootPin, recoveryPads, supportParts, usbWake, USB_SENSE_NET } from "../codegen/circuit.ts"
import { DEFAULT_PERIOD_S, templateConstant } from "../codegen/firmware.ts"
import { estimatePower, PHONE_CONNECTIONS_PER_DAY, phoneUseMa } from "./power.ts"
import { profileForPart } from "../mcu/profile.ts"

export interface AddedItem {
	id: "case" | "no-case" | "own-housing" | "usb-wake" | "usb-wake-off" | "recovery-pads" | "phone-use" | "button-window"
	what: string
	shows: string // how the engineer will notice it on the device
	why: string
	cost: string
	change: string // how to turn it off or change it; "" when there is nothing to change
}

// brief: the run's brief, where the battery capacity may be stated; without it, only the requirements' capacity counts.
export function addedForYou(s: ContractSnapshot, brief = ""): AddedItem[] {
	const items: AddedItem[] = []
	const mode = enclosureMode(s.values)
	// How the board is reached for reflashing, by who houses it.
	const closed = mode === "case" ? ", case closed" : mode === "own" ? ", in your housing" : ""
	const openUp = mode === "case" ? "open the case, " : mode === "own" ? "take the board out of your housing (or leave the pads reachable), " : ""
	const toChangeCase = `requirements.enclosure: "case" (Bringup designs and prints one), "none" (a bare board) or "own" (your housing: Bringup writes the board's mechanical interface instead)`
	if (s.values.requirements?.enclosure === undefined && s.values.outline)
		items.push({
			id: "case",
			what: `A printed case, designed around the board`,
			shows: `case.stl and lid.stl, built for every revision, with an opening for each connector and button, a vent over a sensor, standoffs for the mounting holes${antennaModule(s) ? " and the module's antenna inside its own wall" : ""}.`,
			why: `requirements.enclosure isn't set: the brief didn't say how the board is housed, or the architect didn't record it. A case is the default.`,
			cost: `The print files and a print; every button must have an opening (checked).`,
			change: `Set ${toChangeCase} (a change request: "no case, bare board" or "it goes into our own housing").`,
		})
	if (mode === "none")
		items.push({
			id: "no-case",
			what: `No case: a bare board`,
			shows: `Only the board is built. The battery hangs on its wires, nothing covers the parts, and static from fingers can reach the USB pins and the module: handle it on a bench, not in a pocket. The radio module's FCC label goes on the board's silkscreen or a sticker.`,
			why: `requirements.enclosure is "none".`,
			cost: `None.`,
			change: `Set ${toChangeCase}.`,
		})
	if (mode === "own")
		items.push({
			id: "own-housing",
			what: `Your own housing: a mechanical interface instead of a case`,
			shows: `interface.md and interface.json beside the report: board size, mounting holes, the openings for connectors and buttons, lights, vents, the antenna's keep-out, the pads underneath and the label your housing must carry; board.step has every part's height. Regenerated on every change.`,
			why: `requirements.enclosure is "own".`,
			cost: `None from Bringup; your housing must match it.`,
			change: `Set ${toChangeCase}.`,
		})
	const boot = recoveryBootPin(s)
	const wake = usbWake(s)
	const periodS = Math.round(s.values.requirements?.dutyCycle?.periodS ?? DEFAULT_PERIOD_S)
	if (wake?.gpio != null) {
		const divider = supportParts(s).filter((sp) => (("net" in sp.a && sp.a.net === USB_SENSE_NET) || ("net" in sp.b && sp.b.net === USB_SENSE_NET)))
		items.push({
			id: "usb-wake",
			what: `USB wake: plugging in USB wakes the board, and it stays awake while USB is powered`,
			shows: `With the cable in, the computer sees a USB serial device ("USB JTAG/serial debug unit") and \`pio run -t upload\` flashes it with the cable alone${closed}. Meanwhile it keeps taking a reading every ${periodS} s, USB powers it and the battery charges. Unplugged, it is back in deep sleep within 0.1 s (or once a reading in progress ends).`,
			why: `The firmware deep-sleeps between readings, and the ESP32-C3's USB is off in deep sleep: without this, nothing answers on USB.`,
			cost: `${divider.map((sp) => `${sp.ref} ${sp.spec.value}`).join(" and ")} from VBUS to ${wake.mcu.ref}.GPIO${wake.gpio}: about 30 µA from USB while plugged in, nothing from the battery. The 68k (${divider.find((sp) => sp.spec.value === "68k")?.spec.lcsc ?? "C36871"}) is a JLCPCB Extended part, which adds an assembly fee. The firmware's switch into download mode over its own USB is Espressif's documented path, not yet tried on a Bringup board.`,
			change: `Set requirements.usbWake to false (a change request: "turn off USB wake"). Reflashing then needs ${mode === "case" ? "the case open and " : ""}the recovery pads.`,
		})
	} else if (boot && s.values.requirements?.usbWake === false) {
		items.push({
			id: "usb-wake-off",
			what: `USB wake is off (requirements.usbWake false)`,
			shows: `Plugging in USB charges the battery but doesn't wake the board, so the computer sees no device until its next reading, and only for that moment. Reflashing needs ${mode === "case" ? "the case open and " : ""}the recovery pads.`,
			why: `Turned off in the contract.`,
			cost: `None on the board.`,
			change: `Remove requirements.usbWake, or set it to true, for USB wake.`,
		})
	}
	const pads = boot && s.values.outline ? recoveryPads(s).placed : []
	if (boot && pads.length >= 2) {
		const [b, g] = pads
		const strap = downloadStrap(s)
		const strapPulled = !!strap && supportParts(s).some((sp) => sp.job.startsWith(`${strap.mcu.ref}.${strap.pin} pull-up`))
		items.push({
			id: "recovery-pads",
			what: `Recovery pads: ${b.ref} (BOOT, on ${boot.mcu.ref}.${boot.pin}, net ${b.net}) and ${g.ref} (GND), bare copper side by side on the bottom`,
			shows: `Only needed when a firmware doesn't boot, so USB never comes up${wake?.gpio != null ? " (USB wake covers every other reflash)" : ""}. To use them: ${openUp}unplug USB and the battery, short ${b.ref} to ${g.ref} with tweezers while reconnecting the battery, then plug in USB. The chip waits in its ROM downloader, and \`pio run -t upload\` flashes it. (USB alone also powers it through the charger, so start with both unplugged.)`,
			why: `${boot.mcu.ref}'s ${boot.pin} held low at power-up starts the ROM downloader, which works whatever the firmware does.`,
			cost: strapPulled ? `Two 1.5 mm pads, and a 10k pull-up on ${strap!.mcu.ref}.${strap!.pin}: download boot also needs that pin high at reset, and it floats without one. It draws nothing while the pin is high.` : `Two 1.5 mm pads; no part, no extra board area${strap ? ` (${strap.mcu.ref}.${strap.pin}, which download boot also needs high, is already pulled up by the I2C bus)` : ""}.`,
			change: ``,
		})
	}
	// A wake button keeps the board visible long enough for a phone to find it (main.cpp BUTTON_ADVERTISE_MS).
	const button = (s.values.pins ?? []).find((p) => p.signal === "BUTTON" && p.gpio >= 0 && p.gpio <= 5)
	const windowS = templateConstant("BUTTON_ADVERTISE_MS") / 1000
	if (button && (s.values.connectivity?.radio ?? "ble") === "ble" && Number.isFinite(windowS))
		items.push({
			id: "button-window",
			what: `A button press keeps it visible for a phone for ${windowS} s`,
			shows: `Press the button, then open the app: the device shows up within the ${windowS} s and a phone can connect. A timer wake stays visible only for the reading's short burst.`,
			why: `Between readings it is visible for a fraction of a second every ${Math.round(s.values.requirements?.dutyCycle?.periodS ?? DEFAULT_PERIOD_S)} s, so a phone could scan that long before finding it.`,
			cost: `Up to ${windowS} s awake per press: an estimate of ${Math.round(28 * windowS / 100) / 10}–${Math.round(86 * windowS / 100) / 10} C (the CPU at 28 mA, up to the radio's 86 mA), about what a phone connection costs. The battery estimate counts the phone connections, not the presses.`,
			change: `BUTTON_ADVERTISE_MS in templates/fw/src/main.cpp (a constant today).`,
		})
	// It qualifies the battery-life figure, so it is listed only when there is one.
	const phone = phoneUseMa(s)
	if (phone && estimatePower(s, brief).days !== null)
		items.push({
			id: "phone-use",
			what: `Battery estimate assumes ${PHONE_CONNECTIONS_PER_DAY} phone connection${PHONE_CONNECTIONS_PER_DAY === 1 ? "" : "s"} a day`,
			shows: `The battery-life figure includes it. A phone that stays connected keeps the board awake up to ${templateConstant("BLE_CONNECTED_MAX_MS") / 1000} s each time, so connecting more often shortens battery life; the power budget says how many more connections a day the target leaves room for.`,
			why: `The brief doesn't say how often a phone reads the device.`,
			cost: `${Number((phone.averageMa * 1000).toPrecision(3))} µA on average.`,
			change: `Not adjustable from the brief or the contract yet: it is the constant PHONE_CONNECTIONS_PER_DAY in src/contract/power.ts.`,
		})
	return items
}

// The report's table: what, how it shows, why, cost, and how to change it.
export function addedForYouSection(s: ContractSnapshot, brief = ""): string[] {
	const items = addedForYou(s, brief)
	if (items.length === 0) return []
	const cell = (t: string) => t.replace(/\|/g, "\\|").replace(/\s+/g, " ")
	return [
		`## Added for you`,
		``,
		`Bringup added these without being asked. Each says how you'll notice it, and how to turn it off where you can.`,
		``,
		`| What | How you'll notice it | Why | Cost | To change it |`,
		`|---|---|---|---|---|`,
		...items.map((i) => `| ${cell(i.what)} | ${cell(i.shows)} | ${cell(i.why)} | ${cell(i.cost)} | ${cell(i.change || "nothing to change")} |`),
		``,
	]
}

// The same list for the agents and the reviewer: what the design does that the contract doesn't spell out.
export function addedForYouFactLines(s: ContractSnapshot, brief = ""): string[] {
	const items = addedForYou(s, brief)
	if (items.length === 0) return []
	return [
		"",
		"## Added by Bringup (computed in code; the engineer sees this list in the report)",
		...items.map((i) => `- ${i.what}. ${i.shows} Why: ${i.why} Cost: ${i.cost}${i.change ? ` To change: ${i.change}` : ""}`),
	]
}

// A design whose MCU is a module with an antenna (the ESP32-C3-MINI-1; any profile with a radio and kind "module"); a
// part with no profile is the ESP32-C3.
function antennaModule(s: ContractSnapshot): boolean {
	const mcu = (s.values.parts ?? []).find((p) => p.role === "mcu")
	if (!mcu) return false
	const prof = profileForPart(mcu)
	return prof ? prof.kind === "module" && prof.radio.length > 0 : true
}
