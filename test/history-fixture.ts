// A small run folder for the history tests (history.test.ts, history.browser.test.ts): three revisions, a person's request
// at revision 3 with its ripple, contract snapshots, and board and firmware builds.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tempDir } from "./helpers.ts"

export function historyFixture(dir: string = tempDir()): string {
	const d = dir
	mkdirSync(d, { recursive: true })
	const ev = (seq: number, type: string, payload: unknown) => JSON.stringify({ seq, at: `2026-11-26T10:00:${String(seq).padStart(2, "0")}.000Z`, type, payload })
	writeFileSync(join(d, "trace.jsonl"), [
		ev(1, "contract.changed", { field: "outline", revision: 1, by: "architect", reason: "from the brief", cause: { kind: "brief" } }),
		ev(2, "contract.changed", { field: "parts", revision: 2, by: "parts", reason: "a sensor for the brief", cause: { kind: "field-changed", fields: ["requirements"] } }),
		ev(3, "change.requested", { id: "req-1", text: "make it 2 cm narrower" }),
		ev(4, "contract.changed", { field: "outline", revision: 3, by: "architect", reason: "2 cm narrower, as asked", cause: { kind: "request", id: "req-1", text: "make it 2 cm narrower" } }),
		ev(5, "contract.changed", { field: "parts", revision: 3, by: "parts", reason: "the sensor moves", cause: { kind: "violation", items: [{ kind: "part-off-board" }] } }),
		ev(6, "design.settled", { revision: 2, settled: true }),
		ev(7, "design.settled", { revision: 3, settled: true }),
		"not json",
	].join("\n"))
	writeFileSync(join(d, "ripples.json"), JSON.stringify({ requests: [{ id: "req-1", woke: ["architect", "build:board"], checked: ["parts"], stayedIdle: ["ml"], violationsPeak: 1, durationMs: 41_250 }] }))
	mkdirSync(join(d, "contracts"))
	const snap = (rev: number, width: number, mpn: string) => writeFileSync(join(d, "contracts", `rev-${rev}.json`), JSON.stringify({ revision: rev, values: { outline: { widthMm: width, heightMm: 40 }, parts: [{ ref: "U1", mpn: "ESP32" }, { ref: "U2", mpn }] } }))
	snap(1, 60, "SHT40"); snap(2, 60, "SHT40"); snap(3, 40, "SHTC3")
	for (const r of [1, 3]) mkdirSync(join(d, "board", `rev-${r}`), { recursive: true })
	mkdirSync(join(d, "firmware", "rev-2"), { recursive: true })
	return d
}
