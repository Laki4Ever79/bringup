import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

// The agent tiles must read on a projector at the back of a room: idle is shown by the border and background, not
// by fading the whole tile, and the task line is big and dark enough.
const css = readFileSync(new URL("../src/dashboard/page.html", import.meta.url), "utf8")
const rule = (sel: string) => {
	const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	return [...css.matchAll(new RegExp(`(?:^|[}\\s,])${esc}\\s*\\{([^}]*)\\}`, "gm"))].map((m) => m[1]).join(";")
}
const prop = (sel: string, name: string) => new RegExp(`(?:^|;|\\s)${name}\\s*:\\s*([^;]+)`).exec(rule(sel))?.[1].trim()

test("idle (stayed idle) tiles: dashed and muted, never faded below .6", () => {
	const op = prop(".tile.asleep", "opacity")
	assert.ok(op === undefined || Number(op) >= 0.6, `.tile.asleep opacity ${op}`)
	assert.match(rule(".tile.asleep"), /border-style:\s*dashed/)
	assert.match(rule(".tile.asleep"), /background:/)
})

test("the task line is about 14px; on a woke tile it is near-paper", () => {
	assert.ok(parseFloat(prop(".tile .task", "font-size") ?? "0") >= 14, `.tile .task font-size ${prop(".tile .task", "font-size")}`)
	assert.equal(prop(".tile.woke .task", "color"), "var(--paper)")
})

test("the state labels (STAYED IDLE, CHECKED) are at least 12px and not the faintest ink", () => {
	assert.ok(parseFloat(/(\d+(?:\.\d+)?)px/.exec(prop(".tile .status", "font") ?? "")?.[1] ?? "0") >= 12)
	assert.notEqual(prop(".tile .status", "color"), "var(--ink-3)")
	assert.notEqual(prop(".tile.asleep .status", "color") ?? prop(".tile .status", "color"), "var(--ink-3)")
})

test("the task line is ONE line with an ellipsis at every size (the full text is the tile's hover title)", () => {
	assert.equal(prop(".tile .task", "white-space"), "nowrap")
	assert.equal(prop(".tile .task", "text-overflow"), "ellipsis")
	assert.equal(prop(".tile .task", "overflow"), "hidden")
	assert.ok(!/-webkit-line-clamp/.test(rule(".tile .task")), "no line clamp anywhere brings back a second line")
})

test("the board/case row never crushes: it has a floor, and the page scrolls below it instead of squeezing the PCB", () => {
	// #app fills the window (dynamic viewport, for browser chrome and fractional scaling) but may grow past it.
	assert.match(rule("#app"), /min-height:\s*100dvh/)
	assert.doesNotMatch(rule("#app"), /(^|;|\s)height:\s*100vh/)
	// The deck's row: a floor tall enough to read the board, then whatever height is left.
	const deck = /minmax\(clamp\([^)]*\), auto\) minmax\((\d+)px, 1fr\)/.exec(prop("#run", "grid-template-rows") ?? "")
	assert.ok(deck && Number(deck[1]) >= 300, `the deck row's floor: ${prop("#run", "grid-template-rows")}`)
})
