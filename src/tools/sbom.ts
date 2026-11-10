import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { connectivityOf } from "../contract/connectivity.ts"
import type { ContractSnapshot } from "../contract/types.ts"

// A software bill of materials for the product firmware (CycloneDX 1.5 JSON): every component it is built from, at
// the version actually installed or pinned, read when it is built, so it can't go stale. The EU Cyber Resilience Act
// asks manufacturers for one (Annex I Part II). Only what this design's firmware links: NimBLE on Bluetooth LE,
// PubSubClient for MQTT.
export interface SbomComponent {
	name: string
	version: string
	purl: string
	from: string
}

const pioHome = () => process.env.PLATFORMIO_CORE_DIR ?? join(homedir(), ".platformio")

function packageVersion(dir: string): string | null {
	for (const file of ["package.json", "platform.json"]) {
		const path = join(dir, file)
		if (existsSync(path)) {
			const v = (JSON.parse(readFileSync(path, "utf8")) as { version?: string }).version
			if (v) return v
		}
	}
	return null
}

function defineVersion(path: string, prefix: string): string | null {
	if (!existsSync(path)) return null
	const text = readFileSync(path, "utf8")
	const part = (n: string) => new RegExp(`#define ${prefix}_${n}\\s+(\\d+)`).exec(text)?.[1]
	const [a, b, c] = ["MAJOR", "MINOR", "PATCH"].map(part)
	return a && b && c ? `${a}.${b}.${c}` : null
}

export function sbomComponents(s: ContractSnapshot, iniText: string): SbomComponent[] {
	const home = pioHome()
	const out: SbomComponent[] = []
	const platform = /platform = espressif32@([\d.]+)/.exec(iniText)?.[1]
	if (platform) out.push({ name: "platform-espressif32", version: platform, purl: `pkg:github/platformio/platform-espressif32@v${platform}`, from: "platformio.ini (pinned)" })
	const core = defineVersion(join(home, "packages/framework-arduinoespressif32/cores/esp32/esp_arduino_version.h"), "ESP_ARDUINO_VERSION")
	if (core) out.push({ name: "arduino-esp32", version: core, purl: `pkg:github/espressif/arduino-esp32@${core}`, from: "installed core (esp_arduino_version.h)" })
	const libs = join(home, "packages/framework-arduinoespressif32-esp32c3-libs")
	const idfHeader = existsSync(libs) ? findFile(libs, "esp_idf_version.h") : null
	const idf = idfHeader ? defineVersion(idfHeader, "ESP_IDF_VERSION") : null
	if (idf) out.push({ name: "esp-idf", version: idf, purl: `pkg:github/espressif/esp-idf@v${idf}`, from: "installed libs (esp_idf_version.h)" })
	const toolchain = packageVersion(join(home, "packages/toolchain-riscv32-esp"))
	if (toolchain) out.push({ name: "toolchain-riscv32-esp", version: toolchain, purl: `pkg:generic/toolchain-riscv32-esp@${toolchain}`, from: "installed toolchain" })
	const c = connectivityOf(s)
	const pinned = (lib: string) => new RegExp(`${lib.replace("/", "\\/")}@([\\d.]+)`).exec(iniText)?.[1]
	const nimble = pinned("h2zero/NimBLE-Arduino")
	if (c.radio === "ble" && nimble) out.push({ name: "NimBLE-Arduino", version: nimble, purl: `pkg:github/h2zero/NimBLE-Arduino@${nimble}`, from: "platformio.ini (pinned)" })
	const mqtt = pinned("knolleary/PubSubClient")
	if (c.report.includes("mqtt") && mqtt) out.push({ name: "PubSubClient", version: mqtt, purl: `pkg:github/knolleary/pubsubclient@v${mqtt}`, from: "platformio.ini (pinned)" })
	return out
}

function findFile(dir: string, name: string, depth = 0): string | null {
	if (depth > 6) return null
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry)
		if (entry === name) return path
		if (statSync(path).isDirectory()) {
			const found = findFile(path, name, depth + 1)
			if (found) return found
		}
	}
	return null
}

export function sbomJson(s: ContractSnapshot, iniText: string, revision: number): string {
	const components = sbomComponents(s, iniText)
	return JSON.stringify(
		{
			bomFormat: "CycloneDX",
			specVersion: "1.5",
			version: 1,
			metadata: { component: { type: "firmware", name: "bringup-product-firmware", version: `rev ${revision}` }, tools: [{ name: "Bringup", version: "adopt" }] },
			components: components.map((c) => ({ type: "library", name: c.name, version: c.version, purl: c.purl, properties: [{ name: "bringup:from", value: c.from }] })),
		},
		null,
		2,
	)
}
