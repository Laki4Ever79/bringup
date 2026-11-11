import { HARD_RESERVED } from "./pins.ts"
import type { McuProfile } from "./profile.ts"
import { freeGpios, peripheralsFree } from "./solver.ts"

// What an agent is told about the chosen MCU (docs/mcu.md): every line from its profile, so a design on an STM32 gets
// STM32 facts and one on the ESP32-C3 the ESP32-C3's, with no vendor's facts written into the prompts.

const list = (xs: string[]) => (xs.length ? xs.join(", ") : "none")

export function mcuFacts(p: McuProfile): string[] {
	const usable = p.pins.filter((x) => !(x.reserved && HARD_RESERVED.has(x.reserved)) && x.name !== p.console?.tx && x.name !== p.console?.rx)
	const soft = p.pins.filter((x) => x.reserved && !HARD_RESERVED.has(x.reserved))
	const hard = p.pins.filter((x) => x.reserved && HARD_RESERVED.has(x.reserved))
	const free = peripheralsFree(p)
	const indexRule =
		p.vendor === "st" ? "pins[].gpio is the pin index: port×16 + number (PA5 = 5, PB7 = 23, PC14 = 46)" : p.vendor === "nordic" ? "pins[].gpio is the pin index: port×32 + number (P0.13 = 13, P1.04 = 36)" : "pins[].gpio is the GPIO number"
	const out = [
		`- MCU ${p.mpn} (${p.vendor}, ${p.core} ${p.mhz} MHz, ${p.flashKb} KB flash, ${p.ramKb} KB RAM, ${p.kind === "module" ? "module" : `bare ${p.package.name}`}; profile catalog/mcu/${p.id}.json).`,
		`- Pins: ${indexRule}. Usable: ${usable.map((x) => `${x.name}=${x.index}`).join(", ")}.`,
		...(hard.length ? [`- Never use: ${hard.map((x) => `${x.name} (${x.reserved})`).join(", ")}${p.console ? `; ${p.console.tx}/${p.console.rx} are the console (${p.console.instance})` : ""}.`] : p.console ? [`- ${p.console.tx}/${p.console.rx} are the console (${p.console.instance}); don't use them.`] : []),
		...(soft.length ? [`- Use with care: ${soft.map((x) => `${x.name} (${x.reserved})`).join(", ")}.`] : []),
		`- Peripherals free for the design: ${free.uart} UART, ${free.i2c} I2C, ${free.spi} SPI, ${free.i2s} I2S; radio: ${p.radio.length ? p.radio.join(", ") : "none"}. ${p.pins.some((x) => x.signals.includes("*")) ? "Any free pin can carry any peripheral (GPIO matrix)." : "Each peripheral only reaches certain pins: I2C SDA/SCL, UART TX/RX and SPI pins must be ones that carry that instance's signal (the pin solver checks)."}`,
		`- Programming: ${p.programming.method}${p.programming.method === "swd" ? ` (${p.programming.pins.join("/")}; the board gets SWD pads)` : ""}. ${p.boot.pin ? `Boot pin ${p.boot.pin} (${p.boot.level} at reset enters the ROM bootloader).` : "No boot pin to strap."}`,
		`- Sleep floor ${p.currents.sleepUa} µA, running ${p.currents.cpuMa} mA${p.currents.bleTxMa ? `, BLE TX ${p.currents.bleTxMa} mA` : ""}${p.currents.wifiTxMa ? `, Wi-Fi TX ${p.currents.wifiTxMa} mA` : ""}; the supply must deliver ${p.currents.supplyMinMa} mA (${p.currents.source.split(";")[0]}).`,
		...(p.firmware.history ? [`- Reading history: ${p.firmware.history.store === "eeprom" ? "the core's EEPROM emulation" : "a LittleFS partition"}, ${p.firmware.history.bytes} bytes (4 per reading).`] : []),
		...(p.usb ? [`- Native USB on ${p.usb.dp} (D+) / ${p.usb.dm} (D-): wire them to the USB-C connector's DP/DN.`] : ["- No native USB: the USB-C port only powers the board; it is flashed over its programming pads."]),
		...(!p.board.supported ? [`- Bringup cannot build this chip's board yet: ${p.board.reason}`] : []),
	]
	return out
}

// A design's link pins come from here: the profile's preferred free pins.
export const linkPinsFor = freeGpios
