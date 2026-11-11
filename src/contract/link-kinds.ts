// The kinds of link between boards (docs/system.md): one entry per kind, the single source the spec check, the board's
// links field, the budget and the docs read. Adding a kind means one entry here plus its own checks and codegen.
// Kinds marked built: false are named so the spec can say they are planned, and are rejected until they are built.

export type LinkKind = "uart" | "i2c" | "spi" | "i2s" | "espnow" | "ble"
export type Peripheral = "uart" | "i2c" | "spi" | "i2s" | "radio"
export type TestLevel = "checks" | "compile" | "host-codec" | "qemu" | "bench"

export interface KindInfo {
	kind: LinkKind
	label: string
	medium: "cable" | "radio"
	connector: "jst4_sh" | "jst6_sh" | null // the link connector's footprint; none for a radio link
	peripheral: Peripheral // the chip peripheral each side uses
	gpios: number // GPIOs each side needs for the link's own signals
	carries: "messages" | "stream"
	built: boolean
	testLevels: TestLevel[] // the levels a link of this kind is tested at today
}

const kind = (k: KindInfo) => k
export const LINK_KINDS: Record<LinkKind, KindInfo> = {
	uart: kind({ kind: "uart", label: "UART", medium: "cable", connector: "jst4_sh", peripheral: "uart", gpios: 2, carries: "messages", built: true, testLevels: ["checks", "compile", "host-codec", "qemu", "bench"] }),
	// QEMU can't join two chips' I2C buses, so the bench is its only running test.
	i2c: kind({ kind: "i2c", label: "I²C", medium: "cable", connector: "jst4_sh", peripheral: "i2c", gpios: 2, carries: "messages", built: true, testLevels: ["checks", "compile", "host-codec", "bench"] }),
	spi: kind({ kind: "spi", label: "SPI", medium: "cable", connector: "jst6_sh", peripheral: "spi", gpios: 4, carries: "messages", built: false, testLevels: [] }),
	i2s: kind({ kind: "i2s", label: "I²S", medium: "cable", connector: "jst6_sh", peripheral: "i2s", gpios: 3, carries: "stream", built: false, testLevels: [] }),
	espnow: kind({ kind: "espnow", label: "ESP-NOW", medium: "radio", connector: null, peripheral: "radio", gpios: 0, carries: "messages", built: false, testLevels: [] }),
	ble: kind({ kind: "ble", label: "Bluetooth LE", medium: "radio", connector: null, peripheral: "radio", gpios: 0, carries: "messages", built: false, testLevels: [] }),
}
export const BUILT_KINDS: LinkKind[] = (Object.keys(LINK_KINDS) as LinkKind[]).filter((k) => LINK_KINDS[k].built)
export const isLinkKind = (k: unknown): k is LinkKind => typeof k === "string" && Object.hasOwn(LINK_KINDS, k)

// The ESP32-C3 on a Bringup board (Espressif datasheet): UART0 is the console, so one UART is free; one I2C, one
// general-purpose SPI (SPI2; SPI0/1 are the flash), one I2S, one radio (Wi-Fi and BLE share it).
export const PERIPHERALS_FREE: Record<Peripheral, number> = { uart: 1, i2c: 1, spi: 1, i2s: 1, radio: 1 }
// GPIOs a design may use: not the strapping pins (2, 8, 9) nor USB (18, 19); UART0 (20, 21) is the console.
export const FREE_GPIOS: readonly number[] = [4, 5, 6, 7, 3, 1, 0]
