import assert from "node:assert/strict"
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { appendRequest, watchRequests, type ChangeRequest } from "../src/runner/requests.ts"
import { waitFor } from "./helpers.ts"

const line = (text: string) => JSON.stringify({ at: "2026-10-31T15:00:00.000Z", text }) + "\n"

test("each appended request is seen once, in order", async () => {
	const dir = mkdtempSync(join(tmpdir(), "bringup-req-"))
	const seen: ChangeRequest[] = []
	const w = watchRequests(dir, (r) => seen.push(r))
	try {
		appendFileSync(join(dir, "requests.jsonl"), line("make it 60 mm wide"))
		await waitFor(() => seen.length === 1)
		appendFileSync(join(dir, "requests.jsonl"), line("part out of stock") + line("move USB-C to the right"))
		await waitFor(() => seen.length === 3)
		await new Promise((r) => setTimeout(r, 400))
		assert.deepEqual(seen.map((r) => r.text), ["make it 60 mm wide", "part out of stock", "move USB-C to the right"])
	} finally {
		w.close()
	}
})

test("a request written in two chunks arrives once, whole", async () => {
	const dir = mkdtempSync(join(tmpdir(), "bringup-req-"))
	const seen: ChangeRequest[] = []
	const w = watchRequests(dir, (r) => seen.push(r))
	try {
		const l = line("make it 45 mm wide")
		appendFileSync(join(dir, "requests.jsonl"), l.slice(0, 12))
		await new Promise((r) => setTimeout(r, 400))
		assert.equal(seen.length, 0)
		appendFileSync(join(dir, "requests.jsonl"), l.slice(12))
		await waitFor(() => seen.length === 1)
		assert.equal(seen[0].text, "make it 45 mm wide")
	} finally {
		w.close()
	}
})

test("requests already in the file when watching starts are delivered", async () => {
	const dir = mkdtempSync(join(tmpdir(), "bringup-req-"))
	writeFileSync(join(dir, "requests.jsonl"), line("early request"))
	const seen: ChangeRequest[] = []
	const w = watchRequests(dir, (r) => seen.push(r))
	try {
		await waitFor(() => seen.length === 1)
		assert.equal(seen[0].text, "early request")
	} finally {
		w.close()
	}
})

test("malformed lines are skipped and the watcher keeps going", async () => {
	const dir = mkdtempSync(join(tmpdir(), "bringup-req-"))
	const seen: ChangeRequest[] = []
	const w = watchRequests(dir, (r) => seen.push(r))
	try {
		appendFileSync(join(dir, "requests.jsonl"), "not json\n" + JSON.stringify({ at: "x" }) + "\n" + line("valid"))
		await waitFor(() => seen.length === 1)
		assert.equal(seen[0].text, "valid")
	} finally {
		w.close()
	}
})

test("nothing is delivered after close", async () => {
	const dir = mkdtempSync(join(tmpdir(), "bringup-req-"))
	const seen: ChangeRequest[] = []
	watchRequests(dir, (r) => seen.push(r)).close()
	appendFileSync(join(dir, "requests.jsonl"), line("too late"))
	await new Promise((r) => setTimeout(r, 400))
	assert.equal(seen.length, 0)
})

test("appendRequest writes one timestamped line", async () => {
	const dir = mkdtempSync(join(tmpdir(), "bringup-req-"))
	const seen: ChangeRequest[] = []
	const w = watchRequests(dir, (r) => seen.push(r))
	try {
		const r = appendRequest(dir, "make it 60 mm wide")
		assert.ok(!Number.isNaN(Date.parse(r.at)))
		await waitFor(() => seen.length === 1)
		assert.deepEqual(seen[0], r)
	} finally {
		w.close()
	}
})
