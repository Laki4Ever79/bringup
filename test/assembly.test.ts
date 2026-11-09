// The system page's live assembly (src/dashboard/assembly.js): each board's state at a moment, from its run's events.
import { test } from "node:test"
import assert from "node:assert/strict"
import { assemblyAt, timeSpan } from "../src/dashboard/assembly.js"

const ev = (at: string, type: string, payload: Record<string, unknown>) => ({ at: `2026-11-09T10:${at}Z`, type, payload })
const trace = [
	ev("00:00", "run.started", {}),
	ev("01:00", "contract.changed", { field: "outline", revision: 3, after: { widthMm: 50, heightMm: 30 } }),
	ev("02:00", "consistency.checked", { revision: 4, violations: [{ kind: "connector-clash", message: "J1 (left@8 mm) and JL1 (bottom@12 mm) overlap on the board: move one along its edge or to another edge, and keep going until it clears" }] }),
	ev("03:00", "artifact.ready", { kind: "board", revision: 5 }),
	ev("03:30", "consistency.checked", { revision: 5, violations: [] }),
	ev("04:00", "artifact.ready", { kind: "enclosure", revision: 6 }),
	ev("05:00", "contract.changed", { field: "outline", revision: 7, after: { widthMm: 52, heightMm: 30 } }),
]

test("a board goes empty → placed → routed → cased as its events arrive", () => {
	const at = (t: string) => assemblyAt({ logger: trace }, `2026-11-09T10:${t}Z`).logger
	assert.equal(at("00:30").state, "empty")
	assert.deepEqual([at("01:30").state, at("01:30").outline], ["placed", { widthMm: 50, heightMm: 30 }])
	assert.deepEqual([at("03:10").state, at("03:10").boardRevision], ["routed", 5])
	assert.deepEqual([at("04:10").state, at("04:10").enclosureRevision], ["cased", 6])
	assert.deepEqual(at("06:00").outline, { widthMm: 52, heightMm: 30 })
	assert.equal(at("06:00").revision, 7)
})

test("the latest check's first problem pulses, cut short; a clean check after it stops the pulse", () => {
	const mid = assemblyAt({ logger: trace }, "2026-11-09T10:02:30Z").logger
	assert.equal(mid.pulses.length, 1)
	assert.ok(mid.pulses[0].caption.length <= 90)
	assert.match(mid.pulses[0].caption, /^J1 \(left@8 mm\) and JL1/)
	assert.equal(assemblyAt({ logger: trace }, "2026-11-09T10:03:40Z").logger.pulses.length, 0)
})

test("without a moment the whole trace counts; the time span covers every board", () => {
	assert.equal(assemblyAt({ logger: trace }).logger.state, "cased")
	assert.deepEqual(timeSpan({ logger: trace, beacon: [ev("00:30", "run.started", {}), ev("09:00", "design.settled", {})] }), ["2026-11-09T10:00:00Z", "2026-11-09T10:09:00Z"])
})
