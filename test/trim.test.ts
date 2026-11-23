import { test } from "node:test"
import assert from "node:assert/strict"
import { FunctionCallItem, FunctionCallOutputItem, UserMessageItem } from "@mozaik-ai/core"
import { trimStale } from "../src/inference/trim.ts"

const call = (id: string, name: string, args: object) => FunctionCallItem.rehydrate({ callId: id, name, args: JSON.stringify(args) })
const out = (id: string, text: string) => FunctionCallOutputItem.create(id, text)
const outputs = (items: unknown[]) => items.filter((i) => (i as { type: string }).type === "function_call_output").map((i) => { const o = (i as { output: unknown }).output; return typeof o === "string" ? o : String((o as { text?: string }).text ?? JSON.stringify(o)) })

// Real run cc-eurobot-20b (17 Nov 2026): one parts turn read the contract twice and searched the batteries twice; every
// later call resent all four results.
test("a stale contract read and a repeated identical search are cut to a note; the latest of each and other results stay", () => {
	const items = [
		UserMessageItem.create("Choose the parts."),
		call("a", "read_contract", {}), out("a", "CONTRACT v1 ".repeat(100)),
		call("b", "search_parts", { role: "battery" }), out("b", "BATTERIES ".repeat(100)),
		call("c", "search_parts", { role: "ldo" }), out("c", "LDOS"),
		call("d", "propose_contract_change", { field: "parts" }), out("d", "accepted"),
		call("e", "read_contract", {}), out("e", "CONTRACT v2"),
		call("f", "search_parts", { role: "battery" }), out("f", "BATTERIES again"),
	]
	const { items: trimmed, dropped } = trimStale(items)
	assert.equal(dropped, 2)
	assert.equal(trimmed.length, items.length)
	const o = outputs(trimmed)
	assert.match(o[0], /^\(stale: read_contract/)
	assert.match(o[1], /^\(stale: search_parts/)
	assert.deepEqual(o.slice(2), ["LDOS", "accepted", "CONTRACT v2", "BATTERIES again"])
})

test("a turn with nothing repeated goes through untouched", () => {
	const items = [UserMessageItem.create("go"), call("a", "read_contract", {}), out("a", "C"), call("b", "search_parts", { role: "mcu" }), out("b", "M")]
	const r = trimStale(items)
	assert.equal(r.dropped, 0)
	assert.deepEqual(r.items, items)
})
