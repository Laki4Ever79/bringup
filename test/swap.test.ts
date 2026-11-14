// Swapping a part from its card on the board page (engineer, 13 Nov 2026: step 2 after the "why" card). The card lists
// the catalog parts that could fill the same role, with what each swap would change; picking one sends a change
// request through requests.jsonl, the same path as a typed one, so the owners decide and the checks run.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runDesign } from "../src/run.ts"
import { serveDashboard } from "../src/dashboard/server.ts"
import { boardView, swapOptions } from "../src/dashboard/board-view.ts"
import { swapRequest } from "../src/tools/sourcing.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { fixtureContract } from "./fixture.ts"
import { tempDir } from "./helpers.ts"

const logger = (): ContractSnapshot => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	return s
}

test("a chosen part's card offers the catalog's other parts for its role, each with what it would change and the request to send", () => {
	const swaps = swapOptions(logger())
	const sensor = swaps.U2
	const shtc3 = sensor.find((o) => o.mpn === "SHTC3-TR-2.5KS")!
	assert.ok(shtc3, sensor.map((o) => o.mpn).join(","))
	assert.equal(shtc3.lcsc, "C194656")
	assert.ok(shtc3.changes.includes("same footprint (dfn4): the board keeps its land pattern"), shtc3.changes.join(" | "))
	assert.ok(shtc3.changes.some((c) => /I2C address 0x44 → 0x70/.test(c)))
	assert.equal(shtc3.request, swapRequest({ ref: "U2", mpn: "SHT40-AD1B-R2" }, { mpn: "SHTC3-TR-2.5KS", lcsc: "C194656" }))
	assert.ok(!sensor.some((o) => o.mpn === "SHT40-AD1B-R2"), "not the part it already is")
	assert.deepEqual(swaps.U3.map((o) => o.mpn).sort(), ["AP2112K-3.3TRG1", "XC6206P332MR-G"])
	// The microcontroller changes the whole design (pins, firmware, toolchain): not a one-click swap.
	assert.equal(swaps.U1, undefined)
	// A passive's value comes from a datasheet or a rule (the EN pull-up is 10k because the ESP32's datasheet says so):
	// another value from a list would break that silently.
	assert.equal(swaps.R10, undefined)
	assert.equal(swaps.C4, undefined)
})

test("the board view carries the swaps, with live stock and price from bom.json when the run wrote one", async () => {
	const dir = mkdtempSync(join(tmpdir(), "swap-view-"))
	try {
		mkdirSync(join(dir, "contracts"))
		writeFileSync(join(dir, "contracts", "rev-1.json"), JSON.stringify({ ...logger(), revision: 1 }))
		writeFileSync(join(dir, "bom.json"), JSON.stringify({ items: [{ ref: "U2", alternatives: [{ mpn: "SHTC3-TR-2.5KS", lcsc: "C194656", stock: 1200, priceUsd: 0.4, inStock: true }] }] }))
		const v = (await boardView(dir, null))!
		const o = v.swaps.U2.find((x) => x.mpn === "SHTC3-TR-2.5KS")!
		assert.equal(o.stock, 1200)
		assert.equal(o.priceUsd, 0.4)
		assert.equal(v.swaps.U3.find((x) => x.mpn === "XC6206P332MR-G")!.stock, null, "unknown stock stays unknown")
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test("the board API says whether the run is up to take a swap: stopped until a live run is tracked, then running", async () => {
	const root = mkdtempSync(join(tmpdir(), "swap-hub-"))
	const dir = join(root, "run-1")
	mkdirSync(join(dir, "contracts"), { recursive: true })
	writeFileSync(join(dir, "contracts", "rev-1.json"), JSON.stringify({ ...logger(), revision: 1 }))
	writeFileSync(join(dir, "trace.jsonl"), "")
	const dash = await serveDashboard(dir, 0)
	try {
		const status = async () => ((await (await fetch(`${dash.url}/api/runs/run-1/board`)).json()) as { status: string; swaps: Record<string, unknown[]> })
		const before = await status()
		assert.equal(before.status, "stopped")
		assert.ok(before.swaps.U2.length > 0)
		dash.adopt("run-1", { done: new Promise(() => {}) })
		assert.equal((await status()).status, "running")
	} finally {
		await dash.close()
		rmSync(root, { recursive: true, force: true })
	}
})

test("a scripted logger run takes the swap: U2 becomes the SHTC3 from the catalog, its reason says who asked, and it settles", { timeout: 240_000 }, async () => {
	const out = tempDir()
	const request = swapRequest({ ref: "U2", mpn: "SHT40-AD1B-R2" }, { mpn: "SHTC3-TR-2.5KS", lcsc: "C194656" })
	const r = await runDesign({ brief: readFileSync("briefs/logger.md", "utf8"), mock: true, noHardware: true, review: false, outDir: out, changes: [request], changeTimeoutMs: 30_000 })
	assert.equal(r.settled, true)
	assert.deepEqual(r.violations, [])
	const parts = JSON.parse(readFileSync(join(out, "contract.json"), "utf8")).values.parts as { ref: string; mpn: string; lcsc: string; pins: string[]; reason?: string }[]
	const u2 = parts.find((p) => p.ref === "U2")!
	assert.equal(u2.mpn, "SHTC3-TR-2.5KS")
	assert.equal(u2.lcsc, "C194656")
	assert.deepEqual(u2.pins, ["VDD", "SCL", "SDA", "VSS"])
	assert.match(u2.reason ?? "", /engineer swapped/i)
	assert.match(u2.reason ?? "", /SHT40-AD1B-R2/)
	// The rest of the parts list is as it was.
	assert.deepEqual(parts.filter((p) => p.ref !== "U2").map((p) => p.mpn), LOGGER_DESIGN.parts!.filter((p) => p.ref !== "U2").map((p) => p.mpn))
})
