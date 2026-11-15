// Live price, stock and lead time for a robot's bought parts from any shop's own product page, read from the
// schema.org Offer the page publishes (no API key, no one supplier). A shop that refuses or publishes nothing is said
// to be unchecked, never given a guessed number.
import { test } from "node:test"
import assert from "node:assert/strict"
import { checkOffer, readOffer } from "../src/tools/offers.ts"

const page = (offer: object) => `<html><head><script type="application/ld+json">${JSON.stringify({ "@context": "http://schema.org", "@type": "Product", name: "VL53L0X", offers: offer })}</script></head></html>`

test("an Offer's price, currency and availability are read from the page", () => {
	const o = readOffer(page({ "@type": "Offer", availability: "http://schema.org/InStock", price: "14.9500", priceCurrency: "USD" }))
	assert.deepEqual(o, { price: 14.95, currency: "USD", availability: "in stock", leadDays: null })
})

test("out of stock, backorder and pre-order are told apart; anything else is unknown", () => {
	const a = (v: string) => readOffer(page({ "@type": "Offer", availability: v, price: 1, priceCurrency: "EUR" }))?.availability
	assert.equal(a("https://schema.org/OutOfStock"), "out of stock")
	assert.equal(a("BackOrder"), "backorder")
	assert.equal(a("http://schema.org/PreOrder"), "pre-order")
	assert.equal(a("http://schema.org/Discontinued"), "discontinued")
	assert.equal(a("SomethingElse"), "unknown")
})

test("a lead time the shop states (deliveryLeadTime or shipping handling time) is read; none means null", () => {
	const o = readOffer(page({ "@type": "Offer", price: 5, priceCurrency: "USD", deliveryLeadTime: { "@type": "QuantitativeValue", value: 14, unitCode: "DAY" } }))
	assert.equal(o?.leadDays, 14)
	const h = readOffer(page({ "@type": "Offer", price: 5, priceCurrency: "USD", shippingDetails: { deliveryTime: { handlingTime: { minValue: 1, maxValue: 3, unitCode: "d" } } } }))
	assert.equal(h?.leadDays, 3)
	const w = readOffer(page({ "@type": "Offer", price: 5, priceCurrency: "USD", deliveryLeadTime: { value: 2, unitCode: "WEE" } }))
	assert.equal(w?.leadDays, 14)
})

test("several offers (an AggregateOffer or a list) give the lowest price", () => {
	assert.equal(readOffer(page([{ "@type": "Offer", price: 9, priceCurrency: "USD" }, { "@type": "Offer", price: 7.5, priceCurrency: "USD", availability: "InStock" }]))?.price, 7.5)
	assert.equal(readOffer(page({ "@type": "AggregateOffer", lowPrice: "3.10", priceCurrency: "USD" }))?.price, 3.1)
})

test("a page with no Offer, or broken JSON-LD, gives null", () => {
	assert.equal(readOffer("<html>In Stock $9.95</html>"), null)
	assert.equal(readOffer('<script type="application/ld+json">{not json</script>'), null)
})

const fakeFetch = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch

test("checkOffer says live, refused, no offer data or offline, with the time it checked", async () => {
	const now = () => new Date("2026-11-15T12:00:00Z")
	const live = await checkOffer("https://shop.example/p/1", { fetch: fakeFetch(200, page({ "@type": "Offer", price: "9.95", priceCurrency: "USD", availability: "InStock" })), now })
	assert.equal(live.status, "live")
	assert.equal(live.offer?.price, 9.95)
	assert.equal(live.checkedAt, "2026-11-15T12:00:00.000Z")
	const refused = await checkOffer("https://shop.example/p/1", { fetch: fakeFetch(403, "denied"), now })
	assert.equal(refused.status, "refused")
	assert.match(refused.note, /refused the automated check \(HTTP 403\)/)
	assert.equal(refused.offer, null)
	const none = await checkOffer("https://shop.example/p/1", { fetch: fakeFetch(200, "<html></html>"), now })
	assert.equal(none.status, "no offer data")
	const offline = await checkOffer("https://shop.example/p/1", { fetch: (async () => { throw new Error("ENOTFOUND") }) as unknown as typeof fetch, now })
	assert.equal(offline.status, "offline")
})

test("a page is fetched once per half hour: a parts list rewritten on every change doesn't hit the shop again", async () => {
	let calls = 0
	const f = (async () => {
		calls++
		return new Response(page({ "@type": "Offer", price: 2, priceCurrency: "USD" }), { status: 200 })
	}) as unknown as typeof fetch
	let t = new Date("2026-11-15T12:00:00Z").getTime()
	const now = () => new Date(t)
	await checkOffer("https://shop.example/cached", { fetch: f, now })
	await checkOffer("https://shop.example/cached", { fetch: f, now })
	assert.equal(calls, 1)
	t += 31 * 60_000
	await checkOffer("https://shop.example/cached", { fetch: f, now })
	assert.equal(calls, 2)
})
