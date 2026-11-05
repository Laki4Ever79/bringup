// Finds the pin assignments a firmware tree makes, without compiling it: platformio.ini build flags (one variant per
// [env:...], extends resolved) and C/C++ defines and constants whose names say they are pins.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"
import { CondTracker, familyOfPlatform, type Cond, type Family } from "./preproc.ts"
import { ANALOG_BASE, nrfPin, parsePortPin, portPin } from "./pins.ts"

export interface FirmwarePin {
	name: string
	gpio: number
	// Repo-relative file and 1-based line.
	file: string
	line: number
	// The #if conditions the definition sits under; evaluated per build in match.ts.
	conds?: Cond[]
	// Set by the check: under #if branches whose outcome for this build adopt can't tell.
	conditional?: boolean
	// Set by the check: no use of it is compiled in this build, so it can't miswire anything.
	unused?: boolean
	// Each place a source names it, as the #if conditions there.
	uses?: Cond[][]
	// Came from the build system (a -D flag, a CMake compile definition), not from a source file.
	fromBuild?: boolean
	// Its value says it is a GPIO (GPIO_NUM_25, a gpio_num_t), whatever its name.
	proven?: boolean
	// The value as written, when the check resolved it to another pin (Arduino 13 → PB5 on an Uno).
	as?: string
	// Devicetree: the peripheral a pinctrl line belongs to (uart0), whether it is only an assignment (pinctrl), whether
	// that peripheral is the console (zephyr,console), and whether its node is disabled.
	peripheral?: string
	assigned?: boolean
	console?: boolean
	disabled?: boolean
	// Devicetree: the pin the peripheral's sleep state puts this line on, when it differs from the default state's.
	sleepPin?: number
}

export interface FirmwareVariant {
	// "env:view" for a PlatformIO environment; "source" for pins found in C/C++ files.
	id: string
	pins: FirmwarePin[]
	// The build's -D flags and chip family (PlatformIO envs); unset for a bare source tree.
	defines?: Map<string, string>
	// Every name any build of this repo passes as -D: one this build doesn't pass is known undefined here.
	selectors?: Set<string>
	// Macros the sources define with one agreed value.
	source?: Map<string, string>
	family?: Family | null
}

// A name that says it is a pin. Deliberately narrow: a false pin costs more than a missed one.
const PIN_NAME = /(^|_)(PIN|GPIO|IO)(_|$|\d)|PIN$|^PIN|_(SDA|SCL|MOSI|MISO|SCK|SCLK|CS|CSN|SS|DC|RST|BL|TX|RX|LED|BTN|BUTTON|IRQ|INT)$|^(SDA|SCL|MOSI|MISO|SCK|SCLK|TFT_[A-Z]+|LED|BUTTON)(_|$)/
const NOT_PIN = /^(ENABLE|HAS|USE|IS|MAX|MIN|DEFAULT_NUM)_|BUFSIZE|_EPIN|INDEX|COUNT|^NUM_|FREQ|MASK|SIZE|_MS$|_US$|BAUD|SPEED|WIDTH|HEIGHT|OFFSET|CHANNEL|_BIT$|_BITS$|LEVEL|VERSION|ENABLED?$|DRIVER$/
// Highest pin number on the chips adopt knows: ESP32-S3 GPIO48, Arduino Mega digital pin 69.
const MAX_GPIO = 69

// Pins on an I/O expander or shift register (MCP_PIN_CLAMP), not the MCU's own GPIOs. PIN_MCP_NRESET still counts:
// it is the MCU's pin that drives the expander.
const EXPANDER = /^(MCP|PCF|TCA|PCA|EXP|IOX|SR|SHIFT)\d*_/

export function looksLikePin(name: string): boolean {
	return PIN_NAME.test(name) && !NOT_PIN.test(name) && !EXPANDER.test(name)
}

function gpioValue(v: string): number | null {
	// STM32-style port pins (Arduino STM32: #define LED PC13).
	const bare = v.trim().replace(/^\(\s*|\s*\)$/g, "")
	const port = parsePortPin(bare)
	if (port !== null) return port
	// Arduino analog names (A0): resolved to a chip pin per board in match.ts.
	const analog = /^A(\d{1,2})$/.exec(bare)
	if (analog) return ANALOG_BASE + Number(analog[1])
	const m = /^\(?\s*(?:\(gpio_num_t\)\s*)?(?:GPIO_NUM_|GPIO|IO)?(\d+)[uUlL]*\s*\)?$/.exec(v.trim())
	if (!m) return null
	const n = Number(m[1])
	return n >= 0 && n <= MAX_GPIO ? n : null
}

interface IniSection {
	name: string
	keys: Map<string, { value: string; line: number }>
}

// PlatformIO's ini: [sections], key = value, continuation lines indented, ; and # comments.
function parseIni(text: string): IniSection[] {
	const out: IniSection[] = []
	let cur: IniSection | null = null
	let key: string | null = null
	text.split("\n").forEach((raw, i) => {
		const line = raw.replace(/\s[;#].*$/, "").replace(/^[;#].*$/, "")
		const sec = /^\[([^\]]+)\]/.exec(line)
		if (sec) {
			cur = { name: sec[1].trim(), keys: new Map() }
			out.push(cur)
			key = null
			return
		}
		if (!cur || !line.trim()) return
		const kv = /^([A-Za-z_][\w.]*)\s*=\s*(.*)$/.exec(line)
		if (kv && !/^\s/.test(line)) {
			key = kv[1]
			cur.keys.set(key, { value: kv[2], line: i + 1 })
		} else if (key && /^\s/.test(line)) {
			const k = cur.keys.get(key)!
			// Each continuation line keeps its own line number after a marker, so flags can point at their line.
			k.value += `\n@${i + 1}@${line.trim()}`
		}
	})
	return out
}

// The -D flags of one build_flags value, each with its line.
function defines(value: string, firstLine: number): { name: string; value: string; line: number }[] {
	const out: { name: string; value: string; line: number }[] = []
	for (const part of value.split("\n")) {
		const m = /^@(\d+)@(.*)$/.exec(part)
		const line = m ? Number(m[1]) : firstLine
		const text = m ? m[2] : part
		for (const d of text.matchAll(/-D\s*([A-Za-z_]\w*)(?:=(\S+))?/g)) out.push({ name: d[1], value: d[2] ?? "1", line })
	}
	return out
}

// One key of a section as PlatformIO resolves it: own value, else extends, else [env]; ${sec.key} expanded.
function resolveKey(byName: Map<string, IniSection>, s: IniSection, key: string, seen = new Set<string>()): string | undefined {
	if (seen.has(s.name)) return undefined
	seen.add(s.name)
	const own = s.keys.get(key)?.value.replace(/\n@\d+@/g, " ")
	if (own !== undefined)
		return own.replace(/\$\{([\w:.-]+)\.([\w.]+)\}/g, (_, sec: string, k: string) => {
			const rs = byName.get(sec)
			return (rs && resolveKey(byName, rs, k, new Set(seen))) ?? ""
		})
	const parents = [...(s.keys.get("extends")?.value.split(/[,\s]+/).filter(Boolean) ?? []), ...(s.name.startsWith("env:") ? ["env"] : [])]
	for (const p of parents) {
		const ps = byName.get(p)
		const v = ps && resolveKey(byName, ps, key, seen)
		if (v !== undefined) return v
	}
	return undefined
}

// The directories an env compiles, repo-relative: src_dir (or the build_src_filter's +<dir> entries relative to it)
// and include_dir. Coarse: a -<...> exclusion is ignored unless it names a whole directory.
export function envSourceDirs(text: string, file: string, env: string): string[] {
	const sections = parseIni(text)
	const byName = new Map(sections.map((s) => [s.name, s]))
	const root = dirname(file) === "." ? "" : dirname(file)
	const pio = byName.get("platformio")
	const srcDir = join(root, pio?.keys.get("src_dir")?.value.trim() ?? "src")
	const incDir = join(root, pio?.keys.get("include_dir")?.value.trim() ?? "include")
	const s = byName.get(env)
	const filter = s && (resolveKey(byName, s, "build_src_filter") ?? resolveKey(byName, s, "src_filter"))
	const dirs = new Set<string>([incDir])
	if (!filter) dirs.add(srcDir)
	else
		for (const m of filter.matchAll(/([+-])<([^>]*)>/g)) {
			const target = m[2].replace(/\/?\*.*$/, "").replace(/\/$/, "")
			const dir = join(srcDir, target)
			if (m[1] === "+") dirs.add(dir)
			else if (target && !/[.*]/.test(target)) dirs.delete(dir)
		}
	return [...dirs]
}

export function platformioVariants(text: string, file: string, sourceByDir: Map<string, FirmwarePin[]> = new Map()): FirmwareVariant[] {
	const sections = parseIni(text)
	const byName = new Map(sections.map((s) => [s.name, s]))
	// build_flags with ${section.build_flags} references and `extends` expanded; cycles stop at the first repeat.
	const flagsOf = (s: IniSection, seen = new Set<string>()): { name: string; value: string; line: number }[] => {
		if (seen.has(s.name)) return []
		seen.add(s.name)
		const out: { name: string; value: string; line: number }[] = []
		const parents = [...(s.name.startsWith("env:") && byName.get("env") ? ["env"] : []), ...(s.keys.get("extends")?.value.split(/[,\s]+/).filter(Boolean) ?? [])]
		for (const p of parents) {
			const ps = byName.get(p)
			if (ps) out.push(...flagsOf(ps, seen))
		}
		const bf = s.keys.get("build_flags")
		if (bf) {
			for (const ref of bf.value.matchAll(/\$\{([\w:.-]+)\.build_flags\}/g)) {
				const rs = byName.get(ref[1])
				if (rs) out.push(...flagsOf(rs, seen))
			}
			out.push(...defines(bf.value, bf.line))
		}
		return out
	}
	const variants: FirmwareVariant[] = []
	for (const s of sections) {
		if (!s.name.startsWith("env:")) continue
		// A later -D of the same name wins, as it does on the compiler's command line.
		const last = new Map<string, FirmwarePin>()
		const all = new Map<string, string>()
		for (const d of flagsOf(s)) {
			all.set(d.name, d.value)
			if (!looksLikePin(d.name)) continue
			const gpio = gpioValue(d.value)
			if (gpio === null) last.delete(d.name)
			else last.set(d.name, { name: d.name, gpio, file, line: d.line, fromBuild: true })
		}
		// The env's source tree: its pins first, so a -D of the same name (which an #ifndef default yields to) wins.
		const dirs = envSourceDirs(text, file, s.name)
		const fromSource: FirmwarePin[] = []
		for (const [key, pins] of sourceByDir) {
			const dir = key.split(":")[0]
			if (dirs.some((d) => dir === d || dir.startsWith(`${d}/`))) fromSource.push(...pins.filter((p) => !last.has(p.name)))
		}
		const family = familyOfPlatform(resolveKey(byName, s, "platform"))
		if (last.size || fromSource.length) variants.push({ id: s.name, pins: [...fromSource, ...last.values()], defines: all, family })
	}
	return variants
}

const DEFINE = /^\s*#\s*define\s+([A-Za-z_]\w*)\s+(\(?\s*(?:\(gpio_num_t\)\s*)?(?:GPIO_NUM_|GPIO)?\d+[uUlL]*\s*\)?|\(?\s*P[A-L]\d{1,2}\s*\)?|A\d{1,2})\s*(?:\/\/.*|\/\*.*)?$/
const CONST = /^\s*(?:static\s+)?(?:const(?:expr)?\s+)(?:static\s+)?(?:unsigned\s+)?(?:int|uint8_t|uint16_t|uint32_t|uint|int8_t|gpio_num_t|pin_size_t|byte|auto)\s+([A-Za-z_]\w*)\s*=\s*((?:GPIO_NUM_|GPIO)?\d+[uUlL]*|A\d{1,2}|P[A-L]\d{1,2})\s*;/

export function sourcePins(text: string, file: string): FirmwarePin[] {
	const out: FirmwarePin[] = []
	const cond = new CondTracker()
	const lines = text.split("\n")
	lines.forEach((line, i) => {
		if (cond.line(line, lines[i + 1] ?? "")) return
		const m = DEFINE.exec(line) ?? CONST.exec(line)
		if (!m) return
		// GPIO_NUM_25, PA0 or a gpio_num_t constant is a pin whatever its name (NES_LATCH); a bare number needs a pin-like name.
		const proven = /GPIO_NUM_|^\(?\s*GPIO\d|^\(?\s*P[A-K]\d/.test(m[2]) || /gpio_num_t/.test(line)
		if (EXPANDER.test(m[1].toUpperCase()) || (!proven && !looksLikePin(m[1].toUpperCase()))) return
		const gpio = gpioValue(m[2])
		// Under its own #ifndef it is a default: compiled unless a build passes -D of the same name (which then wins).
		const conds = cond.conds().filter((c) => c.defaultOf !== m[1])
		if (gpio !== null) out.push({ name: m[1], gpio, file, line: i + 1, ...(conds.length ? { conds } : {}), ...(proven ? { proven: true } : {}) })
	})
	// STM32 HAL (CubeMX main.h): #define LED_Pin GPIO_PIN_13 with #define LED_GPIO_Port GPIOC is pin PC13, named LED.
	const ports = new Map<string, string>()
	for (const m of text.matchAll(/^\s*#\s*define\s+(\w+)_GPIO_Port\s+GPIO([A-K])\b/gm)) ports.set(m[1], m[2])
	lines.forEach((line, i) => {
		const m = /^\s*#\s*define\s+(\w+)_Pin\s+GPIO_PIN_(\d+)\b/.exec(line)
		const port = m && ports.get(m[1])
		if (m && port) out.push({ name: m[1], gpio: portPin(port, Number(m[2])), file, line: i + 1, proven: true })
	})
	// A run of 4+ name-matched constants valued 0, 1, 2, … on consecutive lines is an index list (NES button indices),
	// not pins.
	for (let i = 0; i < out.length; ) {
		let j = i
		while (j + 1 < out.length && !out[j + 1].proven && out[j + 1].gpio === out[j].gpio + 1 && out[j + 1].line - out[j].line <= 2) j++
		if (!out[i].proven && out[i].gpio === 0 && j - i + 1 >= 4) out.splice(i, j - i + 1)
		else i = j + 1
	}
	return out
}

// A CMakeLists.txt's set() variables and compile definitions (add_compile_definitions, target_compile_definitions),
// with ${VAR} expanded. Enough for pico-sdk and ESP-IDF projects that pass pins as definitions.
export function cmakeBuild(text: string, file: string): { pins: FirmwarePin[]; defines: Map<string, string>; family: Family | null } {
	const vars = new Map<string, string>()
	// Comments blanked, not removed, so offsets still give the right line.
	const clean = text.replace(/#.*$/gm, (c) => " ".repeat(c.length))
	for (const m of clean.matchAll(/\bset\s*\(\s*(\w+)\s+"?([^\s")]+)"?/gi)) if (!vars.has(m[1])) vars.set(m[1], m[2])
	const expand = (v: string) => v.replace(/\$\{(\w+)\}/g, (_, k: string) => vars.get(k) ?? "")
	const defines = new Map<string, string>()
	const pins: FirmwarePin[] = []
	for (const m of clean.matchAll(/\b(?:add_compile_definitions|target_compile_definitions)\s*\(([^)]*)\)/gi)) {
		const offset = (m.index ?? 0) + m[0].indexOf(m[1])
		for (const d of m[1].matchAll(/\b([A-Z_][A-Z0-9_]*)(?:=("[^"]*"|\S+))?/g)) {
			if (["PUBLIC", "PRIVATE", "INTERFACE"].includes(d[1])) continue
			const value = expand((d[2] ?? "1").replace(/^"|"$/g, ""))
			defines.set(d[1], value)
			const line = text.slice(0, offset + (d.index ?? 0)).split("\n").length
			const gpio = looksLikePin(d[1]) ? gpioValue(value) : null
			if (gpio !== null) pins.push({ name: d[1], gpio, file, line, fromBuild: true })
		}
	}
	const family: Family | null = vars.has("PICO_BOARD") || /pico_sdk_import|pico_sdk_init/.test(clean) ? "rp2040" : /\$ENV\{IDF_PATH\}|project\.cmake/.test(clean) ? "esp32" : null
	if (family === "rp2040") defines.set("PICO_BOARD", vars.get("PICO_BOARD") ?? "pico")
	return { pins, defines, family }
}

// Zephyr devicetree (.dts, .dtsi, .overlay): pinctrl's NRF_PSEL(UART_TX, 1, 4), named after the group's peripheral
// instance (uart20_default → UART20_TX; sleep groups repeat default ones and are dropped), and <name>-gpios =
// <&gpio0 15 flags>, named after the property and its node (led-gpios in a board's node → LED; gpios under led0 →
// LED0; a list → ROW0, ROW1). Devicetree is build configuration: its pins are build pins, never "unused".
export function dtsPins(text: string, file: string): FirmwarePin[] {
	const out: FirmwarePin[] = []
	const seen = new Set<string>()
	const stack: string[] = []
	const sleep = new Map<string, number>()
	const add = (name: string, port: number, pin: number, line: number) => {
		const key = `${name}@${port}.${pin}`
		if (seen.has(key) || pin > 31 || port > 3) return
		seen.add(key)
		out.push({ name: name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, ""), gpio: nrfPin(port, pin), file, line, proven: true, fromBuild: true })
	}
	const clean = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " ")).replace(/\/\/.*$/gm, "")
	clean.split("\n").forEach((line, i) => {
		// Node openings and closings, so each property knows the nodes it is in.
		for (const m of line.matchAll(/(?:([\w,.-]+)\s*:\s*)?(&?[\w,.@-]+)\s*\{|\}/g)) {
			if (m[0] === "}") stack.pop()
			else stack.push((m[1] ?? m[2]).replace(/^&/, "").replace(/@.*$/, ""))
		}
		const node = stack[stack.length - 1] ?? ""
		const sleepGroup = stack.find((n) => /_sleep$/.test(n))
		if (sleepGroup) {
			// Kept aside: the sleep state should put each line where the default state does.
			for (const m of line.matchAll(/NRF_PSEL\s*\(\s*(\w+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g))
				sleep.set(`${sleepGroup.replace(/_sleep$/, "")}_${m[1].replace(/^[A-Z0-9]+?_(?=[A-Z])/, "")}`.toUpperCase(), nrfPin(Number(m[2]), Number(m[3])))
			return
		}
		for (const m of line.matchAll(/NRF_PSEL\s*\(\s*(\w+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g)) {
			const group = stack.find((n) => /_default$/.test(n))?.replace(/_default$/, "") ?? ""
			// UART_TX in uart20_default → UART20_TX; TWIM_SDA in i2c0_default → I2C0_SDA.
			const fn = m[1].replace(/^[A-Z0-9]+?_(?=[A-Z])/, "")
			add(group ? `${group}_${fn}` : m[1], Number(m[2]), Number(m[3]), i + 1)
			const last = out[out.length - 1]
			if (last && last.line === i + 1) Object.assign(last, { assigned: true, ...(group ? { peripheral: group } : {}) })
		}
		const g = /^\s*([\w,-]*?)-?gpios\s*=\s*(.*)$/.exec(line)
		if (g) {
			const refs = [...g[2].matchAll(/<\s*&gpio(\d)\s+(\d+)[^>]*>/g)]
			const prop = g[1].replace(/^.*,/, "")
			const base = prop ? (stack.length > 1 && !/^(zephyr_user|soc|root|\/)$/.test(node) && !prop.includes(node) ? `${node}_${prop}` : prop) : node
			refs.forEach((r, k) => add(refs.length > 1 ? `${base}${k}` : base, Number(r[1]), Number(r[2]), i + 1))
		}
	})
	for (const p of out) {
		const asleep = sleep.get(p.name)
		if (asleep !== undefined && asleep !== p.gpio) p.sleepPin = asleep
	}
	return out
}

// Across a build's devicetree files: which peripherals are disabled (&uart0 { status = "disabled"; }) and which one
// is the console (chosen { zephyr,console = &uart0; }).
export function dtsFacts(texts: string[]): { disabled: Set<string>; console: string | null; flowControl: Set<string> } {
	const disabled = new Set<string>()
	// UARTs with hw-flow-control: on the others RTS and CTS are assigned but unused.
	const flowControl = new Set<string>()
	let console: string | null = null
	for (const t of texts) {
		const clean = t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
		// A node's own properties come before its first child node, so its status is in that first part.
		for (const m of clean.matchAll(/&(\w+)\s*\{([^{}]*)/g)) {
			const st = /status\s*=\s*"(\w+)"/.exec(m[2])?.[1]
			if (st === "disabled") disabled.add(m[1])
			else if (st === "okay") disabled.delete(m[1])
			if (/\bhw-flow-control\b/.test(m[2])) flowControl.add(m[1])
		}
		console = /zephyr,console\s*=\s*&(\w+)/.exec(clean)?.[1] ?? console
	}
	return { disabled, console, flowControl }
}

// An STM32CubeMX project (.ioc): every configured pin with its user label, or else its peripheral signal
// (PA5.Signal=SPI1_SCK). It is the chip's pin configuration, so its pins are build pins and never "unused".
export function iocPins(text: string, file: string): FirmwarePin[] {
	const label = new Map<string, { value: string; line: number }>()
	const signal = new Map<string, { value: string; line: number }>()
	text.split("\n").forEach((line, i) => {
		const m = /^(P[A-K]\d{1,2})(?:-[\w-]+)?\.(Signal|GPIO_Label)=(.+?)\s*$/.exec(line)
		if (m) (m[2] === "GPIO_Label" ? label : signal).set(m[1], { value: m[3], line: i + 1 })
	})
	const out: FirmwarePin[] = []
	for (const pin of new Set([...label.keys(), ...signal.keys()])) {
		const l = label.get(pin)
		const s = signal.get(pin)
		// A bare GPIO_Output or EXTI line with no label says nothing to check a net name against.
		const named = l ?? (s && !/^(GPIO_\w+|GPXTI\d+)$/.test(s.value) ? s : undefined)
		const gpio = parsePortPin(pin)
		if (named && gpio !== null) out.push({ name: named.value, gpio, file, line: named.line, proven: true, fromBuild: true })
	}
	return out
}

// Directories that hold other people's code: SDKs, vendored libraries, build output.
const SKIP_DIR = /^(\.git|\.pio|node_modules|lib|libs|third[_-]?party|vendor|external|managed_components|build|dist|.*sdk.*|Pico-PIO-USB|tinyusb|freertos.*|esp-idf|arduino-esp32|\.venv|electronics|pcb|hardware|case|enclosure|3d|cad|docs?)$/i
const SOURCE = /\.(h|hpp|hh|c|cc|cpp|ino|ioc|dts|dtsi|overlay)$/

function walk(dir: string, root: string, files: string[]): void {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name)
		let st
		try {
			st = statSync(p)
		} catch {
			continue
		}
		if (st.isDirectory()) {
			if (!SKIP_DIR.test(name)) walk(p, root, files)
		} else if ((SOURCE.test(name) || name === "platformio.ini") && !/[._-](example|sample|template)\./i.test(name)) files.push(relative(root, p))
	}
}

export function firmwareVariants(repo: string): FirmwareVariant[] {
	const files: string[] = []
	if (existsSync(repo)) walk(repo, repo, files)
	const variants: FirmwareVariant[] = []
	// Source pins grouped by directory. A PlatformIO env takes the directories it compiles; directories no env claims
	// become variants of their own, since a repo often holds several programs, each for its own board.
	const byDir = new Map<string, FirmwarePin[]>()
	const overlays = new Map<string, FirmwarePin[]>()
	const dtsTexts = new Map<string, string>()
	const inis = files.filter((x) => x.endsWith("platformio.ini"))
	for (const f of files) {
		if (f.endsWith("platformio.ini")) continue
		const text = readFileSync(join(repo, f), "utf8")
		const pins = f.endsWith(".ioc") ? iocPins(text, f) : /\.(dts|dtsi|overlay)$/.test(f) ? dtsPins(text, f) : sourcePins(text, f)
		if (/\.(dts|dtsi|overlay)$/.test(f)) dtsTexts.set(f, text)
		if (!pins.length) continue
		// Each overlay is a build of its own (Zephyr board revisions: beelight_nrf54l15_cpuapp_1.overlay), on top of
		// its directory's board files; it is merged with them below.
		if (f.endsWith(".overlay")) {
			overlays.set(f, pins)
			continue
		}
		const dir = dirname(f)
		byDir.set(dir, [...(byDir.get(dir) ?? []), ...pins])
	}
	for (const [f, pins] of overlays) {
		const dir = dirname(f)
		const base = (byDir.get(dir) ?? []).filter((p) => /\.(dts|dtsi)$/.test(p.file) && !pins.some((o) => o.name === p.name))
		byDir.set(`${dir}:${basename(f)}`, [...base, ...pins])
	}
	// A board directory with overlays builds once per overlay; its bare board files are no build of their own.
	for (const dir of new Set([...overlays.keys()].map((f) => dirname(f)))) if ([...(byDir.get(dir) ?? [])].every((p) => /\.(dts|dtsi)$/.test(p.file))) byDir.delete(dir)
	// Disabled peripherals' pins are unused; the console's unwired pins stay a finding (logs that go nowhere).
	for (const [key, pins] of byDir) {
		const dir = key.split(":")[0]
		const texts = [...dtsTexts].filter(([f]) => dirname(f) === dir && (!f.endsWith(".overlay") || key.endsWith(`:${basename(f)}`))).map(([, t]) => t)
		if (!texts.length) continue
		const facts = dtsFacts(texts)
		for (const p of pins) {
			if (p.peripheral && facts.disabled.has(p.peripheral)) p.disabled = true
			if (p.peripheral && /^u?art/i.test(p.peripheral) && /_(RTS|CTS)$/.test(p.name) && !facts.flowControl.has(p.peripheral)) p.disabled = true
			if (p.peripheral && p.peripheral === facts.console) p.console = true
		}
	}
	const claimed = new Set<string>()
	for (const f of inis) {
		const text = readFileSync(join(repo, f), "utf8")
		for (const v of platformioVariants(text, f, byDir)) {
			variants.push({ ...v, id: inis.length > 1 ? `${f}:${v.id}` : v.id })
			const dirs = envSourceDirs(text, f, v.id)
			for (const key of byDir.keys()) {
				const dir = key.split(":")[0]
				if (dirs.some((d) => dir === d || dir.startsWith(`${d}/`))) claimed.add(key)
			}
		}
	}
	for (const dir of claimed) byDir.delete(dir)

	// A CMake project at the root (pico-sdk, ESP-IDF) compiles the unclaimed source directories, with its compile
	// definitions as -D flags.
	if (existsSync(join(repo, "CMakeLists.txt")) && byDir.size) {
		const cm = cmakeBuild(readFileSync(join(repo, "CMakeLists.txt"), "utf8"), "CMakeLists.txt")
		const fromSource = [...byDir.values()].flat().filter((p) => !cm.pins.some((q) => q.name === p.name))
		variants.push({ id: "cmake", pins: [...fromSource, ...cm.pins], defines: cm.defines, family: cm.family })
		byDir.clear()
	}
	for (const [dir, pins] of byDir) variants.push({ id: `src:${dir}`, pins })

	// Names any build passes as -D, minus those a source #defines itself (those can't be known from flags alone).
	const selectors = new Set(variants.flatMap((v) => [...(v.defines?.keys() ?? [])]))
	for (const f of files) {
		if (f.endsWith("platformio.ini")) continue
		for (const m of readFileSync(join(repo, f), "utf8").matchAll(/^\s*#\s*define\s+(\w+)/gm)) selectors.delete(m[1])
	}
	for (const v of variants) if (v.defines) v.selectors = selectors

	// Where each pin is used, with the #if conditions of each use, so a build can tell whether it compiles any use
	// (HiveHub's INMP441 pins exist on the C6 but every use is under ENABLE_INMP441_MICS, which is 0 there). Uses are
	// mentions outside a #define of the same name. And the macros sources define, kept where all definitions agree.
	const names = new Set(variants.flatMap((v) => v.pins.map((p) => p.name)))
	const uses = new Map<string, Cond[][]>()
	const values = new Map<string, Set<string>>()
	for (const f of files) {
		if (f.endsWith("platformio.ini") || /\.(ioc|dts|dtsi|overlay)$/.test(f)) continue
		const lines = readFileSync(join(repo, f), "utf8").split("\n")
		const t = new CondTracker()
		lines.forEach((line, i) => {
			if (t.line(line, lines[i + 1] ?? "")) return
			const def = /^\s*#\s*(define|undef)\s+(\w+)\s*(\S*)/.exec(line)
			if (def?.[1] === "define") {
				const v = def[3] === "" ? "1" : /^(-?\d+[uUlL]*|true|false)$/.test(def[3]) ? def[3].replace(/[uUlL]+$/, "") : "?"
				values.set(def[2], (values.get(def[2]) ?? new Set()).add(v))
			}
			for (const w of new Set(line.match(/[A-Za-z_]\w*/g) ?? []))
				if (names.has(w) && w !== def?.[2]) uses.set(w, [...(uses.get(w) ?? []), t.conds()])
		})
	}
	const source = new Map([...values].filter(([, v]) => v.size === 1 && !v.has("?")).map(([k, v]) => [k, [...v][0]]))
	for (const v of variants) {
		v.source = source
		for (const p of v.pins) p.uses = uses.get(p.name) ?? []
	}
	return variants
}
