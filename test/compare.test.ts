// get_pictures compare's reading of a run (src/package/compare.ts): the last change request's revisions from the
// trace, each builder's newest folder at or below a revision, and the one-line summary of what changed.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { compareDesigns, designAt, lastChange, leafChanges } from "../src/package/compare.ts"
import { tempDir } from "./helpers.ts"

function run(): string {
	const dir = tempDir()
	const ev = (type: string, payload: object) => JSON.stringify({ at: "2026-11-27T00:00:00Z", type, payload })
	writeFileSync(join(dir, "trace.jsonl"), [ev("contract.changed", { field: "outline", revision: 3 }), ev("contract.changed", { field: "mechanics", revision: 5 }), ev("change.requested", { id: "req-1", text: "make the board 49 mm wide" }), ev("contract.changed", { field: "outline", revision: 6 }), ev("contract.changed", { field: "parts", revision: 7 })].join("\n") + "\n")
	mkdirSync(join(dir, "contracts"))
	const contract = (w: number, extra: object, parts: string[]) => JSON.stringify({ values: { outline: { widthMm: w, heightMm: 29 }, parts: parts.map((ref) => ({ ref })), mechanics: { chassis: { boards: [{ at: { xMm: -20 } }] } }, ...extra } })
	writeFileSync(join(dir, "contracts", "rev-5.json"), contract(45, {}, ["U1", "U6", "C1"]))
	writeFileSync(join(dir, "contracts", "rev-7.json"), contract(49, { mechanics: { chassis: { boards: [{ at: { xMm: -15 } }] } } }, ["U1", "U6", "C2"]))
	// The board rebuilt at 4 and 7; the drive only at 2 and 6.
	for (const [rev, u6] of [[4, 10], [7, 14]] as const) {
		mkdirSync(join(dir, "board", `rev-${rev}`, "fab"), { recursive: true })
		writeFileSync(join(dir, "board", `rev-${rev}`, "board.png"), "png")
		writeFileSync(join(dir, "board", `rev-${rev}`, "fab", "cpl.csv"), `Designator,Mid X,Mid Y,Layer,Rotation\nU1,5mm,5mm,Top,0\nU6,${u6}mm,8mm,Top,0\n`)
	}
	for (const [rev, result] of [[2, "pass"], [6, "fail"]] as const) {
		mkdirSync(join(dir, "drive", `rev-${rev}`), { recursive: true })
		writeFileSync(join(dir, "drive", `rev-${rev}`, "drive.json"), JSON.stringify({ result }))
	}
	return dir
}

test("the last change request: the revision when it arrived, and the newest after it", () => {
	const dir = run()
	assert.deepEqual(lastChange(dir), { text: "make the board 49 mm wide", before: 5, after: 7 })
	assert.equal(lastChange(tempDir()), null)
})

test("the design at a revision: each builder's newest folder at or below it; the summary of what changed", () => {
	const dir = run()
	const a = designAt(dir, 5), b = designAt(dir, 7)
	assert.equal(a.dirs.board, join(dir, "board", "rev-4"))
	assert.equal(a.dirs.drive, join(dir, "drive", "rev-2"))
	assert.equal(b.dirs.drive, join(dir, "drive", "rev-6"))
	const c = compareDesigns(a, b)
	assert.equal(c.summary, "board 45×29 → 49×29 mm; U6 moved; added C2; removed C1; drive pass → fail; chassis boards 1 at x: -20 → -15 mm")
	assert.deepEqual(c.changed, { board: true, assembly: false, motion: true })
	// The same revision twice: nothing changed.
	assert.equal(compareDesigns(b, b).summary, "board 49×29 mm, same size; drive fail → fail")
	assert.deepEqual(leafChanges({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }], c: true }), [["a[1].b", 2, 3], ["c", undefined, true]])
})
