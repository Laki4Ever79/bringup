import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pinsHeader } from "../src/codegen/firmware.ts"
import { pinsEdits } from "../src/runner/file-sync.ts"
import { ROOT, runDesign } from "../src/run.ts"
import { detectEnvironment } from "../src/tools/env.ts"
import { fixtureContract } from "./fixture.ts"
import { tempDir, waitFor } from "./helpers.ts"

test("pinsEdits maps a changed GPIO to the contract's pin, and anything else to drift", () => {
	const c = fixtureContract()
	const generated = pinsHeader(c)
	assert.deepEqual(pinsEdits(generated, generated, c), { mapped: [], pins: null, drift: [] }, "an unchanged file is no edit")

	const moved = generated.replace("#define PIN_I2C_SDA 8", "#define PIN_I2C_SDA 4")
	const e = pinsEdits(moved, generated, c)
	assert.deepEqual(e.mapped, ["I2C_SDA GPIO8 → GPIO4"])
	assert.deepEqual(e.pins!.find((p) => p.signal === "I2C_SDA")!.gpio, 4)
	assert.deepEqual(e.pins!.find((p) => p.signal === "I2C_SCL")!.gpio, 9, "the other pins stay")
	assert.deepEqual(e.drift, [])

	const unmapped = generated.replace("#define BRINGUP_REVISION 6", "#define BRINGUP_REVISION 6\n#define PIN_EXTRA 7\n#define DEBUG_LOG 1")
	const d = pinsEdits(unmapped, generated, c)
	assert.deepEqual(d.mapped, [])
	assert.deepEqual(d.drift, ["+ #define PIN_EXTRA 7 (no part for it)", "+ #define DEBUG_LOG 1"])
})

const brief = () => readFileSync(join(ROOT, "briefs/logger.md"), "utf8")
const trace = (out: string) => readFileSync(join(out, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
const latestPins = (out: string) => {
	const revs = readdirSync(join(out, "firmware")).filter((d) => existsSync(join(out, "firmware", d, "include/pins.h")))
	const rev = Math.max(...revs.map((d) => Number(d.slice(4))))
	return { rev, path: join(out, "firmware", `rev-${rev}`, "include/pins.h") }
}

// A --stay run that the test ends, once it has seen what it waits for.
async function stayRun() {
	const out = tempDir()
	const env = await detectEnvironment(ROOT)
	let end: () => void = () => {}
	const until = new Promise<void>((r) => (end = r))
	const run = runDesign({ brief: brief(), mock: true, noHardware: true, outDir: out, env, stay: { until } })
	const settledOnce = () => existsSync(join(out, "trace.jsonl")) && trace(out).some((e) => e.type === "design.settled")
	await waitFor(settledOnce, 30_000)
	return { out, run, end }
}

test("editing pins.h in a --stay run becomes an engineer change: the pin moves and the firmware rebuilds on it", { timeout: 90_000 }, async () => {
	const { out, run, end } = await stayRun()
	try {
		const { rev, path } = latestPins(out)
		writeFileSync(path, readFileSync(path, "utf8").replace(/^#define PIN_I2C_SDA \d+$/m, "#define PIN_I2C_SDA 4"))
		const rebuilt = () => {
			const p = latestPins(out)
			return p.rev > rev && /^#define PIN_I2C_SDA 4$/m.test(readFileSync(p.path, "utf8"))
		}
		await waitFor(rebuilt, 30_000)
		const req = trace(out).find((e) => e.type === "change.requested")!
		assert.equal(req.payload.text, "edited pins.h: I2C_SDA GPIO8 → GPIO4")
		assert.deepEqual(req.payload.source, { kind: "file", path: `firmware/rev-${rev}/include/pins.h`, revision: rev, items: ["I2C_SDA GPIO8 → GPIO4"] })
		await waitFor(() => existsSync(join(out, "ripples.json")) && JSON.parse(readFileSync(join(out, "ripples.json"), "utf8")).requests[0]?.consistentAtMs != null, 20_000)
		const [row] = JSON.parse(readFileSync(join(out, "ripples.json"), "utf8")).requests
		assert.deepEqual(row.fieldsChanged, ["pins"])
		assert.ok(row.woke.includes("build:firmware") && row.woke.includes("build:board"), JSON.stringify(row))
	} finally {
		end()
		await run
	}
})

test("an edit with no contract field is a drift warning, never dropped; a save against an old revision is not applied", { timeout: 90_000 }, async () => {
	const { out, run, end } = await stayRun()
	try {
		const { rev, path } = latestPins(out)
		writeFileSync(path, readFileSync(path, "utf8") + "#define DEBUG_LOG 1\n")
		await waitFor(() => trace(out).some((e) => e.type === "file.drift"), 10_000)
		const drift = trace(out).find((e) => e.type === "file.drift")!.payload
		assert.deepEqual(drift, {
			path: `firmware/rev-${rev}/include/pins.h`,
			savedRevision: rev,
			designRevision: rev,
			reason: "not-in-contract",
			items: ["+ #define DEBUG_LOG 1"],
			message: "this edit isn't in the design contract; the next rebuild will overwrite it",
		})
		assert.ok(!trace(out).some((e) => e.type === "change.requested"), "nothing to request")

		// An older revision's pins.h: the design has moved on since it was generated.
		const older = readdirSync(join(out, "firmware")).map((d) => Number(d.slice(4))).filter((r) => r < rev && existsSync(join(out, "firmware", `rev-${r}`, "include/pins.h")))
		if (older.length === 0) return // a stub run may build the firmware only once
		const old = Math.max(...older)
		const oldPath = join(out, "firmware", `rev-${old}`, "include/pins.h")
		writeFileSync(oldPath, readFileSync(oldPath, "utf8").replace(/^#define PIN_I2C_SCL \d+$/m, "#define PIN_I2C_SCL 3"))
		await waitFor(() => trace(out).some((e) => e.type === "file.drift" && e.payload.reason === "stale"), 10_000)
		const stale = trace(out).find((e) => e.type === "file.drift" && e.payload.reason === "stale")!.payload
		assert.equal(stale.message, `saved against rev ${old}, the design is at rev ${stale.designRevision}`)
		assert.ok(stale.designRevision > old)
		assert.ok(!trace(out).some((e) => e.type === "change.requested"), "a stale save is not applied")
	} finally {
		end()
		await run
	}
})

test("the file watcher stops when the run ends", { timeout: 60_000 }, async () => {
	const { out, run, end } = await stayRun()
	end()
	await run
	const { path } = latestPins(out)
	writeFileSync(path, readFileSync(path, "utf8").replace(/^#define PIN_I2C_SDA \d+$/m, "#define PIN_I2C_SDA 4"))
	await new Promise((r) => setTimeout(r, 1500))
	// Agent loops from other tests in this process may still log activity; what must not happen is a sync.
	assert.ok(!trace(out).some((e) => e.type === "change.requested" || e.type === "file.drift"), "no sync after run.ended")
	assert.ok(!existsSync(join(out, "requests.jsonl")), "nothing was requested")
})

test("boardEdits maps a saved board's outline and connector moves to the contract, within the round-trip tolerance", async () => {
	const { boardEdits } = await import("../src/runner/file-sync.ts")
	const c = fixtureContract() // 50×30, J1 usb-c left@15
	const same = { outline: { widthMm: 50.04, heightMm: 29.97 }, connectors: [{ ref: "J1", edge: "left" as const, offsetMm: 15.06 }, { ref: "J2", edge: "top" as const, offsetMm: 5 }] }
	assert.deepEqual(boardEdits(same, c), { mapped: [], outline: null, connectors: null }, "the generator's own output, and J2 (a part, not a contract connector), are no edit")
	const moved = { outline: { widthMm: 45, heightMm: 30 }, connectors: [{ ref: "J1", edge: "left" as const, offsetMm: 12 }] }
	const e = boardEdits(moved, c)
	assert.deepEqual(e.mapped, ["outline 50×30 → 45×30 mm", "J1 left@15 → left@12 mm"])
	assert.deepEqual(e.outline, { widthMm: 45, heightMm: 30, thicknessMm: 1.6 })
	assert.deepEqual(e.connectors![0], { ...c.values.connectors![0], edge: "left", offsetMm: 12 })
})
