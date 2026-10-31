import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { BringupState, emit, join as joinRuntime, startRuntime } from "../src/runtime.ts"
import { createBomWriter, type Bom } from "../src/agents/bom.ts"
import { createChangeDesk } from "../src/change-control.ts"
import { makeEvent } from "../src/events.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { tempDir, waitFor } from "./helpers.ts"

afterEach(() => new Promise((r) => setTimeout(r, 100)))

const root = resolve(import.meta.dirname, "..")

function fakeFetch(prices: Record<string, { stock: number; price: number }>, calls: string[] = []): typeof fetch {
	return (async (input: string | URL | Request) => {
		const q = new URL(String(input)).searchParams.get("q") ?? ""
		calls.push(q)
		const hit = prices[q]
		return new Response(JSON.stringify({ components: hit ? [{ lcsc: Number(q.slice(1)), stock: hit.stock, price: hit.price }] : [] }))
	}) as typeof fetch
}

function setup(f: typeof fetch, live = true) {
	const state = new BringupState(tempDir())
	startRuntime(state, undefined, null)
	const desk = createChangeDesk()
	joinRuntime(desk)
	const writer = createBomWriter({ fetch: f, debounceMs: 20, root, live })
	joinRuntime(writer)
	const setParts = () => {
		const r = state.contract.propose({ field: "parts", value: LOGGER_DESIGN.parts, by: "parts", baseVersion: state.contract.version("parts") })
		if (r.status !== "applied") throw new Error(r.status)
		emit(makeEvent("contract.changed", desk.getId(), { field: "parts", version: r.version, revision: r.revision, by: "parts" }), desk.getId())
	}
	const path = join(state.outDir, "bom.json")
	const read = () => JSON.parse(readFileSync(path, "utf8")) as Bom
	return { state, desk, setParts, path, read, writer }
}

test("a parts change writes bom.json with live stock, prices and a total", async () => {
	const calls: string[] = []
	const prices = { C2838502: { stock: 22598, price: 3.05 }, C2909890: { stock: 16939, price: 1.75 }, C2286: { stock: 0, price: 0.01 } }
	const t = setup(fakeFetch(prices, calls))
	t.setParts()
	await waitFor(() => existsSync(t.path))
	const bom = t.read()
	assert.equal(bom.revision, 1)
	assert.deepEqual(bom.items.map((i) => i.ref), LOGGER_DESIGN.parts.map((p) => p.ref))
	const u1 = bom.items.find((i) => i.ref === "U1")!
	assert.deepEqual([u1.mpn, u1.lcsc, u1.role, u1.stock, u1.priceUsd, u1.inStock, u1.grounded], ["ESP32-C3-MINI-1", "C2838502", "mcu", 22598, 3.05, true, true])
	assert.equal(bom.items.find((i) => i.ref === "D1")!.inStock, false)
	assert.equal(bom.items.find((i) => i.ref === "U3")!.priceUsd, null, "not in the fake price table")
	// The total of the parts the fake table prices (the mock's LEDs share C2286), so mock design changes don't break it.
	const priced = LOGGER_DESIGN.parts.map((p) => prices[p.lcsc as keyof typeof prices]?.price ?? 0)
	assert.equal(bom.totalUsd, Math.round(priced.reduce((a, b) => a + b, 0) * 1e4) / 1e4)
})

test("a grounding finding marks its part ungrounded with the finding", async () => {
	const t = setup(fakeFetch({}))
	t.setParts()
	await waitFor(() => existsSync(t.path))
	t.state.groundingFindings = [{ partRef: "U2", kind: "pin-not-on-part", detail: "U2 lists pin SDA2, which catalog SHT40 does not have", source: "catalog" }]
	emit(makeEvent("grounding.checked", t.desk.getId(), { revision: 1, findings: t.state.groundingFindings }), t.desk.getId())
	await waitFor(() => t.read().items.find((i) => i.ref === "U2")!.grounded === false)
	const u2 = t.read().items.find((i) => i.ref === "U2")!
	assert.match(u2.finding!, /SDA2/)
	assert.equal(t.read().items.find((i) => i.ref === "U1")!.grounded, true)
})

test("offline: nulls and a null total, never a throw", async () => {
	const t = setup((async () => { throw new TypeError("fetch failed") }) as typeof fetch)
	t.setParts()
	await waitFor(() => existsSync(t.path))
	const bom = t.read()
	assert.equal(bom.totalUsd, null)
	assert.ok(bom.items.every((i) => i.stock === null && i.priceUsd === null && i.inStock === null))
})

test("a burst of changes is written once, debounced", async () => {
	const t = setup(fakeFetch({}))
	t.setParts()
	emit(makeEvent("grounding.checked", t.desk.getId(), { revision: 1, findings: [] }), t.desk.getId())
	emit(makeEvent("grounding.checked", t.desk.getId(), { revision: 1, findings: [] }), t.desk.getId())
	await waitFor(() => existsSync(t.path))
	await new Promise((r) => setTimeout(r, 100))
	assert.equal(t.writer.writes, 1, "three events, one write")
})

// --mock is the judges' keyless path: it must not wait on jlcsearch (1.5-2.6 s measured on 31 Oct) or need a network.
test("without live lookups the BOM makes no requests and says stock was not looked up", async () => {
	const calls: string[] = []
	const t = setup(fakeFetch({ C2838502: { stock: 5, price: 1 } }, calls), false)
	t.setParts()
	await waitFor(() => existsSync(t.path), 3000)
	const bom = t.read()
	assert.deepEqual(calls, [])
	assert.equal(bom.liveStock, false)
	assert.ok(bom.items.every((i) => i.stock === null && i.priceUsd === null))
	// Like the dashboard: how many lines LCSC lists, then that stock wasn't checked. "0/18 listed" read like a failure.
	const n = LOGGER_DESIGN.parts.length
	assert.equal(bom.readiness!.summary, `${n}/${n} at LCSC/JLCPCB · stock not checked (mock run)`)
	assert.equal(bom.readiness!.warn, false)
	assert.ok(bom.items.find((i) => i.role === "sensor")!.alternatives!.some((a) => a.mpn === "SHTC3-TR-2.5KS"), "alternatives still come from the catalog")
})
