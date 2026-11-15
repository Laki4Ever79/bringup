// The robot's bought mechanical parts (motors, wheels, caster, battery, distance sensor) in the parts list with where
// to buy each, and live price, stock and lead time where the shop states them (src/tools/robot-parts.ts).
import { test } from "node:test"
import assert from "node:assert/strict"
import { checkRobotParts, robotPartLines } from "../src/tools/robot-parts.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

const rover = (): ContractSnapshot => ({ revision: 3, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) })
const offerPage = (price: number, availability: string, extra: object = {}) => `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", offers: { "@type": "Offer", price, priceCurrency: "USD", availability, ...extra } })}</script>`

test("the rover's parts list has two motors, a pair of wheels, a caster, the battery and the distance sensor", () => {
	const lines = robotPartLines(rover())
	const by = (item: string) => lines.find((l) => l.item === item)!
	assert.deepEqual(lines.map((l) => l.item), ["motor", "wheel", "caster", "battery", "distance sensor"])
	assert.equal(by("motor").mpn, "POLOLU-2367 100:1 MP 6V")
	assert.equal(by("motor").qty, 2)
	// Wheels are sold in pairs: two wheels are one pack.
	assert.equal(by("wheel").qty, 2)
	assert.equal(by("wheel").packs, 1)
	assert.equal(by("battery").qty, 1)
	assert.ok(by("motor").buy.length > 0 && by("motor").buy.every((b) => b.url.startsWith("https://")))
})

test("a robot with no mechanics has no robot parts", () => {
	const s = rover()
	delete (s.values as { mechanics?: unknown }).mechanics
	assert.deepEqual(robotPartLines(s), [])
})

test("a mock run checks nothing and says so", async () => {
	const r = await checkRobotParts(robotPartLines(rover()), { live: false })
	assert.ok(r.lines.every((l) => l.status === "not checked"))
	// The caster the rover uses (TENTE, an industrial part) has no shop link; the rest would be checked in a live run.
	assert.deepEqual(r.lines.map((l) => l.note), ["not checked (mock run)", "not checked (mock run)", "no shop link in catalog/mechanics.json", "not checked (mock run)", "not checked (mock run)"])
	assert.equal(r.knownUsd, null)
	assert.match(r.summary, /5 robot parts · not checked \(mock run\)/)
})

test("live: a shop's price, stock and lead time are used; a refusing shop is named and not priced", async () => {
	const shops: typeof fetch = (async (url: string) => {
		if (url.includes("pololu.com")) return new Response("denied", { status: 403 })
		if (url.includes("adafruit.com/product/2011")) return new Response(offerPage(12.5, "http://schema.org/OutOfStock"), { status: 200 })
		return new Response(offerPage(14.95, "http://schema.org/InStock", { deliveryLeadTime: { value: 3, unitCode: "DAY" } }), { status: 200 })
	}) as unknown as typeof fetch
	const r = await checkRobotParts(robotPartLines(rover()), { live: true, fetch: shops, now: () => new Date("2026-11-15T12:00:00Z") })
	const by = (item: string) => r.lines.find((l) => l.item === item)!
	assert.equal(by("motor").status, "not checked")
	assert.match(by("motor").note, /pololu\.com refused the automated check \(HTTP 403\)/)
	assert.equal(by("motor").unitUsd, null)
	assert.equal(by("battery").status, "out of stock")
	assert.equal(by("distance sensor").status, "in stock")
	assert.equal(by("distance sensor").leadDays, 3)
	assert.equal(by("distance sensor").lineUsd, 14.95)
	assert.equal(r.warn, true)
	assert.match(r.summary, /out of stock: battery/)
	// Pololu refused the wheels too, so the second shop in the catalog (The Pi Hut) priced them: one pair.
	assert.equal(by("wheel").supplier, "The Pi Hut")
	assert.equal(by("wheel").packs, 1)
	assert.match(r.summary, /not checked: motor, caster/)
	// Only what shops stated is added up, and the summary says how much is left out.
	assert.equal(r.knownUsd, Math.round((14.95 + 14.95 + 12.5) * 100) / 100)
	assert.match(r.summary, /\$42\.40 known for 3 of 5 lines/)
	assert.match(r.summary, /longest stated lead time 3 days/)
})

test("a part with no shop link in the catalog says so instead of failing", async () => {
	const lines = robotPartLines(rover())
	const caster = lines.find((l) => l.item === "caster")!
	const r = await checkRobotParts([{ ...caster, buy: [] }], { live: true, fetch: (async () => { throw new Error("no fetch expected") }) as unknown as typeof fetch })
	assert.equal(r.lines[0].status, "not checked")
	assert.match(r.lines[0].note, /no shop link in catalog\/mechanics\.json/)
})
