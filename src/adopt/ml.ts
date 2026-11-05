// The model on the device, checked against the device: phase 1 of "the device around the model". Finds the model a
// repo deploys (an Edge Impulse export, or a TFLite Micro model as a .tflite file or C array), what it expects (sensor,
// sample rate, window, arena, weights), and checks that against the firmware (the rate it samples at, the input it
// passes) and the board (a sensor of the right kind, the chip's RAM and flash). Read-only, no model execution.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join, relative } from "node:path"
import type { Board, Footprint } from "./pcb.ts"

export type SensorKind = "microphone" | "motion" | "camera" | "other"

export interface ModelFacts {
	kind: "edge-impulse" | "tflite-micro"
	// Where the model's facts come from (repo-relative).
	file: string
	name?: string
	weightsBytes?: number
	arenaBytes?: number
	sensor?: SensorKind
	rateHz?: number
	// Samples per window and values per sample (axes, or 1 for audio).
	samples?: number
	axes?: number
	// The values the classifier takes per window (samples × axes for Edge Impulse).
	inputValues?: number
	dtype?: string
	// The program that builds it (repo-relative; "" = the repo root): the nearest folder above the model with a
	// platformio.ini, CMakeLists.txt or .ino. Its firmware checks read only that program's sources.
	program: string
}

export interface MlFinding {
	mark: "✓" | "✗" | "?" | "·"
	what: string
	where?: string
	// For firmware findings: the program and the model (its file) they are about.
	program?: string
	model?: string
}

// ---- C constant evaluation --------------------------------------------------------------------------------------

export interface Macro {
	expr: string
	file: string
	line: number
}

// #define NAME expr, and (static) const(expr) int-like NAME = expr; across files. Function-like macros are skipped.
export function collectMacros(files: { path: string; text: string }[]): Map<string, Macro[]> {
	const out = new Map<string, Macro[]>()
	const add = (name: string, expr: string, file: string, line: number) => {
		const clean = expr.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "").trim()
		if (!clean) return
		out.set(name, [...(out.get(name) ?? []), { expr: clean, file, line }])
	}
	for (const { path, text } of files)
		text.split("\n").forEach((l, i) => {
			const d = /^\s*#\s*define\s+([A-Za-z_]\w*)\s+(.+?)\s*$/.exec(l)
			if (d) return add(d[1], d[2], path, i + 1)
			const c = /^\s*(?:static\s+)?(?:const(?:expr)?\s+)(?:static\s+)?(?:unsigned\s+)?(?:int|long|size_t|uint\d+_t|int\d+_t|float|double|auto)\s+([A-Za-z_]\w*)\s*=\s*([^;]+);/.exec(l)
			if (c) add(c[1], c[2], path, i + 1)
		})
	return out
}

// Evaluates a C constant expression with C's rules: integer division truncates when both sides are integers.
// Names resolve through the macros; casts and literal suffixes are ignored. Returns null when anything is unknown.
export function evalC(expr: string, macros: Map<string, Macro[]>, seen = new Set<string>()): number | null {
	const toks = expr.replace(/\(\s*(?:float|double|int|unsigned|long|size_t|uint\d+_t|int\d+_t)\s*\)/g, "").match(/\d+\.\d*(?:[eE][-+]?\d+)?[fF]?|\.\d+[fF]?|0[xX][0-9a-fA-F]+[uUlL]*|\d+[uUlL]*|[A-Za-z_]\w*|[-+*/%()]/g)
	if (!toks) return null
	let i = 0
	type V = { v: number; int: boolean } | null
	const atom = (): V => {
		const t = toks[i++]
		if (t === undefined) return null
		if (t === "(") {
			const v = sum()
			if (toks[i] === ")") i++
			return v
		}
		if (t === "-") {
			const v = atom()
			return v && { v: -v.v, int: v.int }
		}
		if (t === "+") return atom()
		if (/^0[xX]/.test(t)) return { v: parseInt(t, 16), int: true }
		if (/^[\d.]/.test(t)) {
			const float = /[.eEfF]/.test(t.replace(/[uUlL]+$/, ""))
			return { v: parseFloat(t), int: !float }
		}
		if (/^[A-Za-z_]/.test(t)) {
			const defs = macros.get(t)
			if (!defs || seen.has(t)) return null
			// One value only: a name defined differently in two places (#if branches) is unknown.
			const vals = new Set<number>()
			let int = true
			for (const d of defs) {
				const v = evalC(d.expr, macros, new Set([...seen, t]))
				if (v === null) return null
				vals.add(v)
				if (!Number.isInteger(v) || /\.\d|[eE]|\d[fF]\b/.test(d.expr)) int = false
			}
			return vals.size === 1 ? { v: [...vals][0], int } : null
		}
		return null
	}
	const prod = (): V => {
		let a = atom()
		while (a && ["*", "/", "%"].includes(toks[i])) {
			const op = toks[i++]
			const b = atom()
			if (!b) return null
			if (op === "*") a = { v: a.v * b.v, int: a.int && b.int }
			else if (op === "%") a = { v: a.v % b.v, int: a.int && b.int }
			else if (b.v === 0) return null
			else a = a.int && b.int ? { v: Math.trunc(a.v / b.v), int: true } : { v: a.v / b.v, int: false }
		}
		return a
	}
	const sum = (): V => {
		let a = prod()
		while (a && (toks[i] === "+" || toks[i] === "-")) {
			const op = toks[i++]
			const b = prod()
			if (!b) return null
			a = { v: op === "+" ? a.v + b.v : a.v - b.v, int: a.int && b.int }
		}
		return a
	}
	const r = sum()
	return r && i === toks.length ? r.v : null
}

// The program a file belongs to: the nearest folder above it that builds firmware.
export function programOf(repo: string, file: string, files: string[]): string {
	// A build file inside a library folder (lib/, libs/, components/) belongs to that library, not to a program.
	const builds = new Set(
		files
			.filter((f) => /(^|\/)(platformio\.ini|CMakeLists\.txt)$|\.ino$/.test(f) && !RUNTIME.test(relative(repo, f)) && !/(^|\/)(lib|libs|components|managed_components)\//.test(relative(repo, f)))
			.map((f) => relative(repo, f).split("/").slice(0, -1).join("/")),
	)
	let dir = relative(repo, file).split("/").slice(0, -1)
	while (dir.length) {
		const d = dir.join("/")
		if (builds.has(d)) return d
		dir = dir.slice(0, -1)
	}
	return ""
}

// ---- finding the model --------------------------------------------------------------------------------------------

function walk(dir: string, out: string[] = [], depth = 0): string[] {
	if (depth > 12) return out
	for (const name of readdirSync(dir)) {
		if (name === ".git" || name === "node_modules" || name === ".pio" || name === "build") continue
		const p = join(dir, name)
		let st
		try {
			st = statSync(p)
		} catch {
			continue
		}
		if (st.isDirectory()) walk(p, out, depth + 1)
		else out.push(p)
	}
	return out
}

// Library code that defines the runtime itself, not this product's model or firmware.
const RUNTIME = /(^|\/)(edge-impulse-sdk|tensorflow|tflite-micro|third_party|CMSIS|cmsis|esp-nn|flatbuffers|kissfft|pico-sdk|managed_components|components\/esp)(\/|$)/

const ELEM_BYTES: Record<string, number> = { float: 4, double: 8, int8_t: 1, uint8_t: 1, char: 1, int16_t: 2, uint16_t: 2, int32_t: 4, uint32_t: 4 }

// Bytes held in constant arrays of a source file: `const float tensor_data4[64*216] = {` (Edge Impulse EON), or
// `const unsigned char g_model[] = {0x1c, …}` counted by its values, or its `_len = N` companion.
export function arrayBytes(text: string, macros: Map<string, Macro[]> = new Map()): number {
	let total = 0
	const lens = new Map<string, number>()
	for (const m of text.matchAll(/\b(?:unsigned\s+)?(?:int|long)?\s*(\w+)_len\s*=\s*(\d+)\s*;/g)) lens.set(m[1], Number(m[2]))
	for (const m of text.matchAll(/const\s+(?:[\w()]+\s+)*?(?:unsigned\s+)?(float|double|u?int(?:8|16|32)_t|char)\s+(\w+)\s*\[([^\]]*)\]\s*(?:[\w()\s]*)=\s*\{/g)) {
		const elem = ELEM_BYTES[m[1]] ?? 1
		const n = m[3].trim() ? evalC(m[3], macros) : null
		if (n !== null) total += n * elem
		else if (lens.has(m[2])) total += lens.get(m[2])! * elem
		else {
			// No size given: count the values up to the closing brace.
			const end = text.indexOf("};", m.index!)
			const body = text.slice(m.index! + m[0].length, end < 0 ? undefined : end)
			total += (body.match(/0[xX][0-9a-fA-F]+|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?f?/g)?.length ?? 0) * elem
		}
	}
	return total
}

const SENSOR_OF_EI: Record<string, SensorKind> = {
	EI_CLASSIFIER_SENSOR_MICROPHONE: "microphone",
	EI_CLASSIFIER_SENSOR_ACCELEROMETER: "motion",
	EI_CLASSIFIER_SENSOR_FUSION: "motion",
	EI_CLASSIFIER_SENSOR_CAMERA: "camera",
}

export function findModels(repo: string, files = walk(repo)): ModelFacts[] {
	const rel = (p: string) => relative(repo, p)
	const models: ModelFacts[] = []

	// Edge Impulse: model-parameters/model_metadata.h, weights in the sibling tflite-model/ sources.
	for (const meta of files.filter((f) => basename(f) === "model_metadata.h" && /model-parameters/.test(f))) {
		const text = readFileSync(meta, "utf8")
		const macros = collectMacros([{ path: rel(meta), text }])
		const n = (name: string) => evalC(name, macros)
		const sensorDef = macros.get("EI_CLASSIFIER_SENSOR")?.[0]?.expr ?? ""
		const root = meta.replace(/\/model-parameters\/model_metadata\.h$/, "")
		const weights = files
			.filter((f) => f.startsWith(`${root}/tflite-model/`) && /\.(cpp|cc|c|h)$/.test(f) && !/ops_define/.test(f))
			.reduce((s, f) => s + arrayBytes(readFileSync(f, "utf8")), 0)
		const samples = n("EI_CLASSIFIER_RAW_SAMPLE_COUNT") ?? undefined
		const axes = n("EI_CLASSIFIER_RAW_SAMPLES_PER_FRAME") ?? undefined
		models.push({
			kind: "edge-impulse",
			program: programOf(repo, meta, files),
			file: rel(meta),
			name: /"([^"]*)"/.exec(macros.get("EI_CLASSIFIER_PROJECT_NAME")?.[0]?.expr ?? "")?.[1],
			weightsBytes: weights || undefined,
			arenaBytes: n("EI_CLASSIFIER_TFLITE_LARGEST_ARENA_SIZE") ?? undefined,
			sensor: SENSOR_OF_EI[sensorDef] ?? (sensorDef ? "other" : undefined),
			rateHz: n("EI_CLASSIFIER_FREQUENCY") ?? undefined,
			samples,
			axes,
			inputValues: n("EI_CLASSIFIER_DSP_INPUT_FRAME_SIZE") ?? (samples !== undefined && axes !== undefined ? samples * axes : undefined),
			dtype: /DATATYPE_(\w+)/.exec(macros.get("EI_CLASSIFIER_TFLITE_INPUT_DATATYPE")?.[0]?.expr ?? "")?.[1]?.toLowerCase(),
		})
	}
	if (models.length) return models

	// TFLite Micro: a .tflite file or a model C array, and the arena the firmware gives the interpreter.
	const product = files.filter((f) => !RUNTIME.test(rel(f)))
	const tflite = product.filter((f) => f.endsWith(".tflite"))
	const arrays = product.filter((f) => /\.(h|hpp|cc|cpp|c)$/.test(f) && /model/i.test(basename(f)) && statSync(f).size < 20e6).filter((f) => /\b(?:unsigned\s+char|uint8_t)\s+\w*model\w*\s*\[/i.test(readFileSync(f, "utf8")))
	const sources = product.filter((f) => /\.(h|hpp|cc|cpp|c|ino)$/.test(f) && statSync(f).size < 2e6)
	const texts = sources.map((f) => ({ path: rel(f), text: readFileSync(f, "utf8") }))
	if (!tflite.length && !arrays.length) return models
	if (!texts.some((t) => /MicroInterpreter|tflite::|tflite_micro|TfLite/.test(t.text))) return models
	const macros = collectMacros(texts)
	const arenaName = [...macros.keys()].find((k) => /^k?_?tensor_?arena_?size$/i.test(k) || /TENSOR_ARENA_SIZE|kTensorArenaSize|ARENA_SIZE$/i.test(k))
	let arena = arenaName ? evalC(arenaName, macros) : null
	if (arena === null)
		for (const t of texts) {
			const m = /\btensor_arena\s*\[([^\]]+)\]/.exec(t.text)
			if (m) arena = evalC(m[1], macros)
			if (arena !== null) break
		}
	// Every distinct model blob: each model C array (by its _len, or its values counted), and each .tflite file whose
	// size no array already has (the same model, kept twice). Several models share one arena (multi-tenant).
	const blobs: { file: string; name: string; bytes: number }[] = []
	for (const f of arrays) {
		const text = readFileSync(f, "utf8")
		for (const m of text.matchAll(/(?:const\s+)?(?:alignas\(\d+\)\s+)?(?:const\s+)?(?:unsigned\s+char|uint8_t)\s+(\w*model\w*)\s*\[[^\]]*\]/gi)) {
			const decl = text.slice(m.index!, m.index! + 400)
			if (!/=\s*\{/.test(decl.split(";")[0])) continue
			const len = new RegExp(`\\b${m[1]}_len\\s*=\\s*(\\d+)`).exec(text)
			const bytes = len ? Number(len[1]) : arrayBytes(text.slice(m.index!, text.indexOf("};", m.index!) + 2), macros)
			if (bytes > 0) blobs.push({ file: rel(f), name: m[1], bytes })
		}
	}
	for (const f of tflite) {
		const bytes = statSync(f).size
		if (!blobs.some((b) => b.bytes === bytes)) blobs.push({ file: rel(f), name: basename(f, ".tflite"), bytes })
	}
	const audio = macros.has("kAudioSampleFrequency") ? evalC("kAudioSampleFrequency", macros) : null
	const hearsAudio = audio !== null || texts.some((t) => /\bPDM\b|i2s_read|I2S\.read|audio_provider/i.test(t.text))
	for (const b of blobs) {
		// What a model reads, from its name: person/image/vision → camera; speech/keyword/command/micro_features → mic.
		const sensor: SensorKind | undefined = /person|image|vision|vww|camera|detect/i.test(b.name) ? "camera" : /speech|keyword|kws|command|micro_features|audio|wake|g_model$/i.test(b.name) && hearsAudio ? "microphone" : undefined
		models.push({
			kind: "tflite-micro",
			program: programOf(repo, join(repo, b.file), files),
			file: b.file,
			name: b.name,
			weightsBytes: b.bytes,
			arenaBytes: arena ?? undefined,
			...(sensor ? { sensor } : {}),
			...(sensor === "microphone" && audio !== null ? { rateHz: audio } : {}),
		})
	}
	return models
}

// ---- the chip's memory ----------------------------------------------------------------------------------------------

export interface ChipMemory {
	chip: string
	ramKB: number
	flashKB?: number
	psramKB?: number
}

// On-chip SRAM and flash from the datasheets, built in. ESP32 and RP2 flash is external: an ESP32 module's code says it
// (-N8R2: 8 MB flash, 2 MB PSRAM), otherwise it is unknown. RAM is the chip's total; the firmware's own use comes out
// of it, so a model that takes most of it is flagged before it is refused.
const CHIPS: { re: RegExp; chip: string; ramKB: number; flashKB?: number }[] = [
	{ re: /esp32.?s3/i, chip: "ESP32-S3", ramKB: 512 },
	{ re: /esp32.?s2/i, chip: "ESP32-S2", ramKB: 320 },
	{ re: /esp32.?c3/i, chip: "ESP32-C3", ramKB: 400 },
	{ re: /esp32.?c6/i, chip: "ESP32-C6", ramKB: 512 },
	{ re: /esp32.?h2/i, chip: "ESP32-H2", ramKB: 320 },
	{ re: /esp32/i, chip: "ESP32", ramKB: 520 },
	{ re: /rp2350/i, chip: "RP2350", ramKB: 520 },
	{ re: /rp2040|\bpico\b/i, chip: "RP2040", ramKB: 264 },
	{ re: /nrf52840/i, chip: "nRF52840", ramKB: 256, flashKB: 1024 },
	{ re: /nrf52833/i, chip: "nRF52833", ramKB: 128, flashKB: 512 },
	{ re: /nrf52832/i, chip: "nRF52832", ramKB: 64, flashKB: 512 },
	{ re: /nrf54l15|bl54l15/i, chip: "nRF54L15", ramKB: 256, flashKB: 1524 },
	{ re: /stm32f103.[8b]/i, chip: "STM32F103", ramKB: 20 },
	{ re: /stm32f103.[cde]/i, chip: "STM32F103", ramKB: 64 },
	{ re: /stm32f401.[bc]/i, chip: "STM32F401", ramKB: 64 },
	{ re: /stm32f401.[de]/i, chip: "STM32F401", ramKB: 96 },
	{ re: /stm32f411/i, chip: "STM32F411", ramKB: 128 },
	{ re: /stm32f40[57]/i, chip: "STM32F405/407", ramKB: 192 },
	{ re: /stm32h743/i, chip: "STM32H743", ramKB: 1024 },
	{ re: /atmega328/i, chip: "ATmega328P", ramKB: 2, flashKB: 32 },
	{ re: /atmega2560/i, chip: "ATmega2560", ramKB: 8, flashKB: 256 },
	{ re: /atmega32u4/i, chip: "ATmega32U4", ramKB: 2.5, flashKB: 32 },
	{ re: /samd21/i, chip: "SAMD21", ramKB: 32, flashKB: 256 },
]
// STM32 flash by the size letter after the pin-count letter (STM32F103C8 → 8 = 64 KB).
const STM32_FLASH: Record<string, number> = { "4": 16, "6": 32, "8": 64, B: 128, C: 256, D: 384, E: 512, F: 768, G: 1024, H: 1536, I: 2048 }

export function chipMemory(f: Pick<Footprint, "value" | "lib">): ChipMemory | null {
	const t = `${f.value} ${f.lib}`
	const c = CHIPS.find((x) => x.re.test(t))
	if (!c) return null
	let flashKB = c.flashKB
	let psramKB: number | undefined
	const mod = /-N(\d+)(?:R(\d+))?\b/i.exec(t)
	if (mod && /esp32/i.test(t)) {
		flashKB = Number(mod[1]) * 1024
		if (mod[2]) psramKB = Number(mod[2]) * 1024
	}
	const stm = /stm32\w\d{3}\w([468BCDEFGHI])/i.exec(t)
	if (stm) flashKB = STM32_FLASH[stm[1].toUpperCase()]
	return { chip: c.chip, ramKB: c.ramKB, ...(flashKB ? { flashKB } : {}), ...(psramKB ? { psramKB } : {}) }
}

// ---- the checks -----------------------------------------------------------------------------------------------------

// Parts that are sensors of each kind, by value or library (an IMU breakout's Adafruit number included).
const SENSOR_PARTS: Record<Exclude<SensorKind, "other">, RegExp> = {
	microphone: /\bmic|microphone|inmp441|sph0645|ics-?4343|msm261|t5838|mp34dt|spm0687|im69d|vm3011|pdm|^MK\d/i,
	motion: /bno0?8\d|bno055|mpu-?\d{4}|icm-?\d{5}|lsm6\w*|lsm303|lis2|lis3|bmi\d{3}|bmx\d{3}|adxl\d+|mma\d+|kx\d{3}|\b4754\b|\b4646\b|imu|accel/i,
	camera: /ov\d{4}|gc\d{4}|hm01b0|hm0360|camera|\bcam\b|dvp/i,
}

// The firmware's sources, excluding the runtime, the model export itself, and third-party libraries (a folder with a
// library.json or library.properties, as PlatformIO and Arduino mark them).
function firmwareSources(repo: string, files: string[]): { path: string; text: string }[] {
	const libs = files.filter((f) => /(^|\/)library\.(json|properties)$/.test(f)).map((f) => f.split("/").slice(0, -1).join("/"))
	return files
		.filter((f) => /\.(h|hpp|cc|cpp|c|ino)$/.test(f) && !RUNTIME.test(relative(repo, f)) && !/(^|\/)(model-parameters|tflite-model)\//.test(relative(repo, f)) && !libs.some((l) => f.startsWith(`${l}/`)) && statSync(f).size < 2e6)
		.map((f) => ({ path: relative(repo, f), text: readFileSync(f, "utf8") }))
}

// Rates the firmware samples its sensor at: constants named like a sensor rate, not a clock, bus or baud rate.
// By whole name parts (SENSOR_POLL_RATE_HZ, kAudioSampleFrequency), so INTEGRATED doesn't count as RATE.
const nameParts = (n: string) => n.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase().split(/_+/).filter(Boolean)
const RATE_WORDS = new Set(["RATE", "FREQ", "FREQUENCY", "HZ"])
const SENSOR_WORDS = new Set(["SAMPLE", "SAMPLES", "SAMPLING", "SENSOR", "POLL", "ACCEL", "IMU", "GYRO", "AUDIO", "MIC", "ODR", "DATA"])
const NOT_RATE = new Set(["CPU", "I2C", "SPI", "BAUD", "PWM", "FREERTOS", "TICK", "CLOCK", "CLK", "UART", "LED", "TIMER", "WIFI", "BLE", "DISPLAY", "REFRESH", "FPS", "LOOP", "BLINK", "EI"])
const isRateName = (n: string) => {
	const p = nameParts(n)
	return p.some((w) => RATE_WORDS.has(w)) && (p.some((w) => SENSOR_WORDS.has(w)) || p.at(-1) === "HZ") && !p.some((w) => NOT_RATE.has(w))
}

// The firmware facts of one program (repo-relative folder; "" = the whole repo).
export function firmwareFacts(repo: string, files = walk(repo), program = "") {
	const inProgram = (f: string) => !program || relative(repo, f) === program || relative(repo, f).startsWith(`${program}/`)
	const srcs = firmwareSources(repo, files.filter(inProgram))
	const meta = files.filter((f) => inProgram(f) && /model-parameters\/model_metadata\.h$/.test(f)).map((f) => ({ path: relative(repo, f), text: readFileSync(f, "utf8") }))
	const macros = collectMacros([...srcs, ...meta])
	const rates: { name: string; hz: number; file: string; line: number }[] = []
	for (const [name, defs] of macros) {
		if (!isRateName(name) || defs.some((d) => meta.some((m) => m.path === d.file))) continue
		const hz = evalC(name, macros)
		if (hz !== null && hz > 0 && hz < 1e6) rates.push({ name, hz, file: defs[0].file, line: defs[0].line })
	}
	// What the firmware hands the classifier: arguments of the call that runs it (run_classifier, signal_from_buffer,
	// or the firmware's own inference wrapper) and `total_length =` assignments, where they are named constants.
	const passed: { name: string; values: number; file: string; line: number }[] = []
	for (const s of srcs)
		s.text.split("\n").forEach((line, i) => {
			if (/^\s*(\/\/|\*|#\s*define)/.test(line)) return
			const call = /\b(run_classifier\w*|signal_from_buffer|\w*infer\w*|\w*classif\w*)\s*\(([^;]*)\)/i.exec(line) ?? /\.total_length\s*=\s*([^;]+)/.exec(line)
			if (!call) return
			const args = (call[2] ?? call[1]).split(",").map((a) => a.trim())
			for (const a of args) {
				if (!/^[A-Z_][A-Z0-9_]*$/.test(a) || !/SIZE|LEN|COUNT|FEATURE|SAMPLES|FRAME|INPUT/.test(a) || /^EI_CLASSIFIER_/.test(a)) continue
				const v = evalC(a, macros)
				if (v !== null && !passed.some((p) => p.name === a)) passed.push({ name: a, values: v, file: s.path, line: i + 1 })
			}
		})
	return { rates, passed, macros }
}

const kb = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`)

// Every check of a model against the firmware (once per repo) and against each board's MCU and sensors.
export function checkModel(model: ModelFacts, fw: ReturnType<typeof firmwareFacts>): MlFinding[] {
	const out: MlFinding[] = []
	if (model.inputValues !== undefined)
		for (const p of fw.passed) {
			if (p.values === model.inputValues) out.push({ mark: "✓", what: `the firmware passes ${p.values} values (${p.name}), the model's input`, where: `${p.file}:${p.line}` })
			else {
				const perAxis = model.axes ? ` (${model.axes} axes: ${p.values / model.axes} samples, not ${model.samples})` : ""
				out.push({ mark: "✗", what: `the firmware passes ${p.values} values (${p.name}) where the model takes ${model.inputValues}${perAxis}: it runs on a different window than it was trained on`, where: `${p.file}:${p.line}` })
			}
		}
	// Only a model that knows its rate: an audio model's sample rate, an Edge Impulse model's frequency.
	if (model.rateHz !== undefined && fw.rates.length) {
		const same = fw.rates.find((r) => Math.abs(r.hz - model.rateHz!) < 0.5)
		if (same) out.push({ mark: "✓", what: `the firmware samples at ${same.hz} Hz (${same.name}), the model's rate`, where: `${same.file}:${same.line}` })
		else out.push({ mark: "?", what: `the model was trained at ${model.rateHz} Hz; the firmware's rates are ${fw.rates.map((r) => `${r.name} = ${r.hz} Hz`).join(", ")}`, where: `${fw.rates[0].file}:${fw.rates[0].line}` })
	}
	return out
}

export function checkModelOnBoard(model: ModelFacts, b: Board, mcu: Footprint | null, onDevBoard: boolean): MlFinding[] {
	const out: MlFinding[] = []
	if (model.sensor && model.sensor !== "other") {
		const part = b.footprints.find((f) => SENSOR_PARTS[model.sensor as Exclude<SensorKind, "other">].test(`${f.ref} ${f.value} ${f.lib}`))
		if (part) out.push({ mark: "✓", what: `the model reads a ${model.sensor} sensor; the board has ${part.ref} (${part.value})` })
		else out.push({ mark: onDevBoard || !mcu ? "?" : "✗", what: `the model reads a ${model.sensor} sensor and this board has none${onDevBoard || !mcu ? " (it may be on the plugged-in dev board)" : ""}` })
	}
	const mem = mcu && chipMemory(mcu)
	if (!mcu) return out
	if (!mem) {
		out.push({ mark: "?", what: `${mcu.value || mcu.ref}: its memory isn't in adopt's chip table, so the model's fit isn't checked` })
		return out
	}
	if (model.arenaBytes !== undefined) {
		const share = model.arenaBytes / (mem.ramKB * 1024)
		const psram = mem.psramKB ? ` (+ ${kb(mem.psramKB * 1024)} PSRAM)` : ""
		out.push({ mark: share > 1 ? "✗" : share > 0.5 ? "?" : "✓", what: `tensor arena ${kb(model.arenaBytes)} is ${(share * 100).toFixed(share < 0.01 ? 2 : 0)}% of the ${mem.chip}'s ${kb(mem.ramKB * 1024)} RAM${psram}${share > 1 ? ": it doesn't fit" : share > 0.5 ? ": little is left for the firmware" : ""}` })
	}
	if (model.weightsBytes !== undefined) {
		if (mem.flashKB) {
			const share = model.weightsBytes / (mem.flashKB * 1024)
			out.push({ mark: share > 1 ? "✗" : share > 0.5 ? "?" : "✓", what: `model weights ${kb(model.weightsBytes)} are ${(share * 100).toFixed(share < 0.01 ? 2 : 0)}% of ${kb(mem.flashKB * 1024)} flash${share > 1 ? ": they don't fit" : ""}` })
		} else out.push({ mark: "·", what: `model weights ${kb(model.weightsBytes)}; the ${mem.chip}'s flash is external and its size isn't on the board` })
	}
	return out
}

export function describeModel(m: ModelFacts): string {
	const parts = [
		m.kind === "edge-impulse" ? `Edge Impulse${m.name ? ` "${m.name}"` : ""}` : `TFLite Micro${m.name ? ` ${m.name}` : ""}`,
		m.sensor && `${m.sensor} input`,
		m.rateHz !== undefined && `${m.rateHz} Hz`,
		m.samples !== undefined && m.axes !== undefined && `${m.samples} samples × ${m.axes} axes`,
		m.weightsBytes !== undefined && `weights ${kb(m.weightsBytes)}`,
		m.arenaBytes !== undefined && `arena ${kb(m.arenaBytes)}`,
		m.dtype,
	].filter(Boolean)
	return parts.join(", ")
}

export { walk as walkRepo }
export const repoHasModel = (repo: string) => existsSync(repo) && findModels(repo).length > 0
