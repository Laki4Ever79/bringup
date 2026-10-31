import assert from "node:assert/strict"
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createCloudRelay, parseDemoArgs, runDemo, summarize, type DemoDeps } from "../src/demo.ts"

const ev = (seq: number, type: string, payload: object) => JSON.stringify({ seq, at: new Date().toISOString(), type, producerId: "x", payload }) + "\n"

test("defaults: mock, logger brief, one width change 8 s after the first design settles", () => {
	assert.deepEqual(parseDemoArgs([]), { real: false, brief: "briefs/logger.md", change: "make the board 60 mm wide", afterS: 8, port: 4317, open: true })
})

test("flags override the defaults", () => {
	assert.deepEqual(parseDemoArgs(["--real", "--brief", "briefs/blinky.md", "--change", "make it 45 mm wide", "--after", "5", "--port", "5000", "--no-open"]), {
		real: true,
		brief: "briefs/blinky.md",
		change: "make it 45 mm wide",
		afterS: 5,
		port: 5000,
		open: false,
	})
	assert.equal(parseDemoArgs(["--no-change"]).change, null)
	assert.equal(parseDemoArgs(["--after=7.5"]).afterS, 7.5)
})

test("bad arguments are rejected with a message", () => {
	assert.throws(() => parseDemoArgs(["--after", "soon"]), /--after/)
	assert.throws(() => parseDemoArgs(["--after", "-1"]), /--after/)
	assert.throws(() => parseDemoArgs(["--brief"]), /--brief/)
	assert.throws(() => parseDemoArgs(["--change", ""]), /--change/)
	assert.throws(() => parseDemoArgs(["--fast"]), /unknown/)
})

test("summarize reads settled, revision, change control, violations and artifacts from the trace", () => {
	const trace =
		ev(0, "contract.changed", { field: "outline", version: 1, revision: 1, by: "architect" }) +
		ev(1, "change.proposed", { proposalId: "p1", field: "pins", by: "firmware", reason: "" }) +
		ev(2, "change.decided", { proposalId: "p1", approved: true, by: "architect", reason: "" }) +
		ev(3, "change.proposed", { proposalId: "p2", field: "parts", by: "architect", reason: "" }) +
		ev(4, "change.decided", { proposalId: "p2", approved: false, by: "parts", reason: "" }) +
		ev(5, "consistency.checked", { revision: 3, violations: [{ kind: "net-missing", message: "a" }, { kind: "outline-mismatch", message: "b" }] }) +
		ev(6, "consistency.checked", { revision: 4, violations: [{ kind: "net-missing", message: "a" }] }) +
		ev(7, "artifact.ready", { kind: "board", revision: 4 }) +
		ev(8, "artifact.failed", { kind: "firmware", revision: 4, error: "x" }) +
		ev(9, "artifact.ready", { kind: "firmware", revision: 4 }) +
		ev(10, "design.settled", { revision: 9, settled: true })
	assert.deepEqual(summarize(trace, 0), [
		"settled: yes (exit 0)",
		"revision: 9",
		"change control: 2 held, 1 approved, 1 rejected",
		"violations caught: 2",
		"artifacts built: 2 (1 failed build)",
	])
	assert.match(summarize("", 2)[0], /no \(exit 2\)/)
})

// A stub run: a trace that starts, settles after `settleMs`, then exits after `exitMs`.
function stubLaunch(settleMs: number, exitMs: number) {
	const seen = { args: null as any }
	const launch: DemoDeps["launch"] = (args) => {
		seen.args = args
		const trace = join(args.outDir, "trace.jsonl")
		writeFileSync(trace, ev(0, "run.started", { review: true, engineerApproval: false, noHardware: false, bench: false, stay: true }))
		const done = new Promise<{ code: number; stderr: string }>((resolve) => {
			setTimeout(() => appendFileSync(trace, ev(1, "design.settled", { revision: 2, settled: true })), settleMs)
			setTimeout(() => resolve({ code: 0, stderr: "" }), exitMs)
		})
		return { done, kill: () => {} }
	}
	return { launch, seen }
}

const quiet: Pick<DemoDeps, "log" | "openUrl"> = { log: () => {}, openUrl: () => {} }

test("the change rides on the run's own after-settle mechanism, and the run stays up for more", { timeout: 10_000 }, async () => {
	const stub = stubLaunch(50, 200)
	const outRoot = mkdtempSync(join(tmpdir(), "bringup-demo-"))
	const r = await runDemo(parseDemoArgs(["--after", "6", "--port", "0", "--no-open"]), { launch: stub.launch, outRoot, ...quiet })
	try {
		assert.equal(r.code, 0)
		assert.deepEqual(stub.seen.args, { briefPath: join(r.outDir, "brief.md"), mock: true, outDir: r.outDir, extraArgs: ["--stay", "--change", "make the board 60 mm wide", "--change-delay", "6"] })
		assert.equal(existsSync(join(r.outDir, "requests.jsonl")), false, "the run sends it, after it settles; the demo no longer does")
		assert.match(r.summary[0], /yes/)
	} finally {
		await r.dashboard.close()
	}
})

test("--no-change: no scripted change, and the run still stays up for changes from the dashboard", { timeout: 10_000 }, async () => {
	const stub = stubLaunch(50, 200)
	const outRoot = mkdtempSync(join(tmpdir(), "bringup-demo-"))
	const r = await runDemo(parseDemoArgs(["--no-change", "--port", "0", "--no-open"]), { launch: stub.launch, outRoot, ...quiet })
	try {
		assert.deepEqual(stub.seen.args.extraArgs, ["--stay"])
	} finally {
		await r.dashboard.close()
	}
})

test("the demo's dashboard tracks its run: 'waiting for a change' while it stays up, Stop reaches it", { timeout: 10_000 }, async () => {
	const stub = stubLaunch(50, 1500)
	const outRoot = mkdtempSync(join(tmpdir(), "bringup-demo-"))
	let url = ""
	const statuses: string[] = []
	const r = await runDemo(parseDemoArgs(["--port", "0", "--no-open"]), {
		launch: stub.launch,
		outRoot,
		openUrl: () => {},
		log: (l) => {
			const m = /dashboard: (http:\/\/[^/]+)/.exec(l)
			if (!m) return
			url = m[1]
			setTimeout(async () => {
				const runs = (await (await fetch(`${url}/api/runs`)).json()) as any[]
				statuses.push(runs[0].status)
			}, 600)
		},
	})
	try {
		assert.deepEqual(statuses, ["waiting for a change"])
	} finally {
		await r.dashboard.close()
	}
})

test("the dashboard serves the run", { timeout: 10_000 }, async () => {
	const stub = stubLaunch(100, 300)
	const outRoot = mkdtempSync(join(tmpdir(), "bringup-demo-"))
	const r = await runDemo(parseDemoArgs(["--port", "0", "--no-open"]), { launch: stub.launch, outRoot, ...quiet })
	try {
		assert.match(r.outDir, /demo-[\w-]+$/)
		assert.equal(readFileSync(join(r.outDir, "brief.md"), "utf8"), readFileSync("briefs/logger.md", "utf8"))
		const page = await (await fetch(r.dashboard.url)).text()
		assert.match(page, /file\("requests\.jsonl"\)/)
		assert.equal((await fetch(`${r.dashboard.url}/files/brief.md`)).status, 200)
	} finally {
		await r.dashboard.close()
	}
})

const cloud = (id: string) => `\x1b[36m▶ mozaik cloud — watching live: https://app.jigjoy.ai/?s=loop_${id}\x1b[0m\n`

test("the cloud relay prints the first link, then only counts, and records every URL", () => {
	const dir = mkdtempSync(join(tmpdir(), "bringup-demo-"))
	const log: string[] = []
	let now = 0
	const relay = createCloudRelay(dir, (l) => log.push(l), () => now)
	relay.write("agent-mesh skeleton: ready\n" + cloud("a1"))
	const second = cloud("b2")
	relay.write(second.slice(0, 20))
	relay.write(second.slice(20) + cloud("c3"))
	now = 10_000
	relay.write(cloud("d4"))
	relay.end()
	assert.equal(log[0], "Mozaik Cloud: https://app.jigjoy.ai/?s=loop_a1")
	assert.equal(log.filter((l) => l.startsWith("Mozaik Cloud:")).length, 1)
	assert.ok(!log.some((l) => l.includes("skeleton")), "other stdout is not relayed")
	assert.equal(log.at(-1), "+3 agent loops live in Mozaik Cloud")
	assert.ok(log.length <= 4, `too chatty: ${log.join(" | ")}`)
	const urls = readFileSync(join(dir, "cloud.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).url)
	assert.deepEqual(urls, ["a1", "b2", "c3", "d4"].map((id) => `https://app.jigjoy.ai/?s=loop_${id}`))
})

test("a run without Cloud output prints nothing about Cloud", () => {
	const dir = mkdtempSync(join(tmpdir(), "bringup-demo-"))
	const log: string[] = []
	const relay = createCloudRelay(dir, (l) => log.push(l))
	relay.write("mozaik cloud: no API key — telemetry disabled.\n")
	relay.end()
	assert.deepEqual(log, [])
	assert.equal(existsSync(join(dir, "cloud.jsonl")), false)
})

test("runDemo relays the run's Cloud links and the dashboard can read them", { timeout: 10_000 }, async () => {
	const outRoot = mkdtempSync(join(tmpdir(), "bringup-demo-"))
	const log: string[] = []
	const launch: DemoDeps["launch"] = (args, hooks) => {
		writeFileSync(join(args.outDir, "trace.jsonl"), "")
		hooks.onStdout(cloud("x1") + cloud("x2"))
		return { done: new Promise((r) => setTimeout(() => r({ code: 0, stderr: "" }), 100)) }
	}
	const r = await runDemo(parseDemoArgs(["--no-change", "--port", "0", "--no-open"]), { launch, outRoot, log: (l) => log.push(l), openUrl: () => {} })
	try {
		assert.ok(log.includes("Mozaik Cloud: https://app.jigjoy.ai/?s=loop_x1"), log.join(" | "))
		assert.ok(log.includes("+1 agent loops live in Mozaik Cloud"), log.join(" | "))
		const page = await (await fetch(r.dashboard.url)).text()
		assert.match(page, /file\("cloud\.jsonl"\)/)
		assert.equal((await fetch(`${r.dashboard.url}/files/cloud.jsonl`)).status, 200)
	} finally {
		await r.dashboard.close()
	}
})
