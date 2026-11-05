// Just enough of the C preprocessor to tell which #if branch a pin definition is in for a given build: conditions
// are recorded while scanning, and evaluated later against one build's defines. Three-valued: a macro adopt can't
// know (from an included header, say) makes the answer "unknown", never a guess.

// One condition a line depends on: expr must evaluate to want.
export interface Cond {
	expr: string
	want: boolean
	// Set on an #ifndef X: a "#define X" right under it is X's default value, overridable by -D X.
	defaultOf?: string
}

interface Frame {
	// Conditions of the branches before this one in the #if/#elif chain (each must have been false).
	prior: string[]
	current: Cond[]
	guard: boolean
}

// Feeds lines in order; conds() is what the current line depends on. Include guards are skipped.
export class CondTracker {
	private stack: Frame[] = []
	private seen = false
	// Returns true if the line was a preprocessor conditional (and so holds no definition).
	line(text: string, next: string): boolean {
		const m = /^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b\s*(.*?)\s*(?:\/\/.*|\/\*.*)?$/.exec(text)
		if (!m) return false
		const [, kw, rest] = m
		if (kw === "if" || kw === "ifdef" || kw === "ifndef") {
			const expr = kw === "if" ? rest : kw === "ifdef" ? `defined(${rest})` : `!defined(${rest})`
			// #ifndef X / #define X is an include guard only as a file's first conditional with a valueless define;
			// "#ifndef PIN / #define PIN 14" anywhere is a default value, and stays a condition.
			const name = rest.replace(/\W/g, "")
			const guard = kw === "ifndef" && !this.seen && this.stack.length === 0 && new RegExp(`^\\s*#\\s*define\\s+${name}\\s*(?:\\/\\/.*)?$`).test(next)
			this.seen = true
			this.stack.push({ prior: [expr], current: guard ? [] : [{ expr, want: true, ...(kw === "ifndef" ? { defaultOf: name } : {}) }], guard })
		} else if (kw === "elif") {
			const f = this.stack[this.stack.length - 1]
			if (f) {
				f.current = [...f.prior.map((expr) => ({ expr, want: false })), { expr: rest, want: true }]
				f.prior.push(rest)
			}
		} else if (kw === "else") {
			const f = this.stack[this.stack.length - 1]
			if (f && !f.guard) f.current = f.prior.map((expr) => ({ expr, want: false }))
		} else this.stack.pop()
		return true
	}
	conds(): Cond[] {
		return this.stack.flatMap((f) => f.current)
	}
}

export interface BuildContext {
	// -D flags: name → value ("1" for a bare -DNAME).
	defines: Map<string, string>
	// The chip family being built for, if known: decides the platform macros.
	family: Family | null
	// Build selectors: names some build passes as -D (BOARD_REV4). A build that doesn't pass one doesn't define it.
	selectors?: Set<string>
	// Macros the sources define, where every definition agrees (ENABLE_INMP441_MICS 0): known unless -D overrides.
	source?: Map<string, string>
	// The chip's own macro when the board names it (__AVR_ATmega328P__): every other chip macro is then undefined.
	chip?: string
}

export type Family = "esp32" | "esp8266" | "avr" | "rp2040" | "stm32" | "nrf52" | "samd"

// Macros each toolchain defines, and the patterns that belong to a family (so they are known false elsewhere).
const FAMILY: Record<Family, { defined: string[]; owns: RegExp }> = {
	esp32: { defined: ["ESP32", "ARDUINO_ARCH_ESP32", "ESP_PLATFORM"], owns: /^(ESP32\w*|ARDUINO_ARCH_ESP32|ESP_PLATFORM|CONFIG_IDF_TARGET\w*|ARDUINO_ESP32\w*)$/ },
	esp8266: { defined: ["ESP8266", "ARDUINO_ARCH_ESP8266"], owns: /^(ESP8266\w*|ARDUINO_ARCH_ESP8266|ARDUINO_ESP8266\w*)$/ },
	avr: { defined: ["__AVR__", "ARDUINO_ARCH_AVR"], owns: /^(__AVR\w*|ARDUINO_ARCH_AVR|ARDUINO_AVR\w*)$/ },
	rp2040: { defined: ["PICO_BOARD", "ARDUINO_ARCH_RP2040"], owns: /^(PICO_\w+|ARDUINO_ARCH_RP2040|RASPBERRYPI_PICO\w*|ARDUINO_RASPBERRY_PI_PICO\w*)$/ },
	stm32: { defined: ["ARDUINO_ARCH_STM32"], owns: /^(STM32\w*|ARDUINO_ARCH_STM32)$/ },
	nrf52: { defined: ["NRF52", "ARDUINO_ARCH_NRF52"], owns: /^(NRF5\w*|ARDUINO_ARCH_NRF5\w*)$/ },
	samd: { defined: ["ARDUINO_ARCH_SAMD"], owns: /^(__SAMD\w*|ARDUINO_ARCH_SAMD|ARDUINO_SAMD\w*)$/ },
}

export function familyOfPlatform(platform: string | undefined): Family | null {
	if (!platform) return null
	const p = platform.toLowerCase()
	if (p.includes("espressif32")) return "esp32"
	if (p.includes("espressif8266")) return "esp8266"
	if (p.includes("atmelavr")) return "avr"
	if (p.includes("raspberrypi") || p.includes("rp2040")) return "rp2040"
	if (p.includes("ststm32")) return "stm32"
	if (p.includes("nordicnrf52")) return "nrf52"
	if (p.includes("atmelsam")) return "samd"
	return null
}

export function familyOfPart(text: string): Family | null {
	const t = text.toUpperCase()
	if (/ESP32|T-?MICRO32|T-?DISPLAY|TTGO/.test(t)) return "esp32"
	if (/ESP8266|ESP-?12|WEMOS|D1.?MINI/.test(t)) return "esp8266"
	if (/RP2040|RP2350|PICO/.test(t)) return "rp2040"
	if (/ATMEGA|ATTINY|ARDUINO.?(NANO|UNO|PRO.?MINI|MEGA|LEONARDO|MICRO)(?!.?(EVERY|ESP32|33|RP2040|MATTER|R4))|PRO.?MICRO/.test(t)) return "avr"
	if (/STM32/.test(t)) return "stm32"
	if (/NRF52/.test(t)) return "nrf52"
	if (/SAMD|ATSAMD/.test(t)) return "samd"
	return null
}

type Tri = number | undefined

function isDefined(ctx: BuildContext, name: string): boolean | undefined {
	if (ctx.defines.has(name)) return true
	if (ctx.source?.has(name)) return true
	if (ctx.selectors?.has(name)) return false
	if (ctx.chip && /^__AVR_AT\w+__$/.test(name)) return name === ctx.chip
	if (!ctx.family) return undefined
	if (FAMILY[ctx.family].defined.includes(name)) return true
	for (const [fam, f] of Object.entries(FAMILY)) if (f.owns.test(name)) return fam === ctx.family ? undefined : false
	return undefined
}

function valueOf(ctx: BuildContext, name: string): Tri {
	if (name === "true") return 1
	if (name === "false") return 0
	const v = ctx.defines.get(name) ?? ctx.source?.get(name)
	if (v !== undefined) {
		if (v === "true") return 1
		if (v === "false") return 0
		const n = Number(v)
		return Number.isFinite(n) ? n : undefined
	}
	// An undefined macro is 0 in #if, but only if we know it is undefined.
	return isDefined(ctx, name) === false ? 0 : undefined
}

// Evaluates one #if expression: integers, identifiers, defined, ! && || == != < > <= >= and parentheses.
export function evaluate(expr: string, ctx: BuildContext): Tri {
	const toks = expr.match(/defined|[A-Za-z_]\w*|\d+[uUlL]*|&&|\|\||==|!=|<=|>=|[!()<>]/g) ?? []
	let i = 0
	const peek = () => toks[i]
	const take = () => toks[i++]
	const primary = (): Tri => {
		const t = take()
		if (t === undefined) return undefined
		if (t === "(") {
			const v = or()
			if (peek() === ")") take()
			return v
		}
		if (t === "!") {
			const v = primary()
			return v === undefined ? undefined : v ? 0 : 1
		}
		if (t === "defined") {
			const paren = peek() === "("
			if (paren) take()
			const name = take()
			if (paren && peek() === ")") take()
			const d = isDefined(ctx, name)
			return d === undefined ? undefined : d ? 1 : 0
		}
		if (/^\d/.test(t)) return parseInt(t, 10)
		return valueOf(ctx, t)
	}
	const compare = (): Tri => {
		let a = primary()
		while (["==", "!=", "<", ">", "<=", ">="].includes(peek())) {
			const op = take()
			const b = primary()
			if (a === undefined || b === undefined) a = undefined
			else a = Number(op === "==" ? a === b : op === "!=" ? a !== b : op === "<" ? a < b : op === ">" ? a > b : op === "<=" ? a <= b : a >= b)
		}
		return a
	}
	const and = (): Tri => {
		let a = compare()
		while (peek() === "&&") {
			take()
			const b = compare()
			a = a === 0 || b === 0 ? 0 : a === undefined || b === undefined ? undefined : 1
		}
		return a
	}
	const or = (): Tri => {
		let a = and()
		while (peek() === "||") {
			take()
			const b = and()
			a = (a !== undefined && a !== 0) || (b !== undefined && b !== 0) ? 1 : a === undefined || b === undefined ? undefined : 0
		}
		return a
	}
	return or()
}

// Whether a line under these conditions is compiled in this build: true, false, or undefined (can't tell).
export function active(conds: Cond[], ctx: BuildContext): boolean | undefined {
	let unknown = false
	for (const c of conds) {
		const v = evaluate(c.expr, ctx)
		if (v === undefined) unknown = true
		else if (Boolean(v) !== c.want) return false
	}
	return unknown ? undefined : true
}
