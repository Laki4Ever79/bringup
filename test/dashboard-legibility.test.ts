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

test("a tile fits its name plus two full task lines, so no line is cut in half at the bottom", () => {
	// 66px: a tile's height at 1920×1080 (the ripple band is clamp(250px, 33vh, 352px), three rows of tiles).
	const px = (v: string | undefined) => (v ?? "").split(/\s+/).map(parseFloat)
	const [padTop, , padBottom] = px(prop(".tile", "padding"))
	const gap = parseFloat(prop(".tile", "gap") ?? "0")
	const nameLh = parseFloat(/\/([\d.]+)/.exec(prop(".tile .name", "font") ?? "")?.[1] ?? "0") * 22
	const task = 2 * parseFloat(prop(".tile .task", "font-size") ?? "0") * parseFloat(prop(".tile .task", "line-height") ?? "0")
	const need = 3 + padTop + padBottom + nameLh + gap + task
	assert.ok(need <= 66, `a tile needs ${need.toFixed(1)}px for two task lines`)
})
