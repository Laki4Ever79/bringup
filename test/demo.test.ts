import assert from "node:assert/strict"
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { parseDemoArgs, runDemo, summarize, type DemoDeps } from "../src/demo.ts"

const ev = (seq: number, type: string, payload: object) => JSON.stringify({ seq, at: new Date().toISOString(), type, producerId: "x", payload }) + "\n"

test("defaults: mock, logger brief, one width change after 20 s", () => {
	assert.deepEqual(parseDemoArgs([]), { real: false, brief: "briefs/logger.md", change: "make the board 60 mm wide", afterS: 20, port: 4317, open: true })
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

// A stub run: writes a trace without artifacts, then the first artifact.ready after `artifactMs`, then exits.
function stubLaunch(artifactMs: number, exitMs: number) {
	const seen = { artifactAt: 0, requestsBeforeArtifact: false, args: null as any }
	const launch: DemoDeps["launch"] = (args) => {
		seen.args = args
		const trace = join(args.outDir, "trace.jsonl")
		writeFileSync(trace, ev(0, "contract.changed", { field: "outline", version: 1, revision: 1, by: "architect" }))
		const done = new Promise<{ code: number; stderr: string }>((resolve) => {
			setTimeout(() => {
				seen.requestsBeforeArtifact = existsSync(join(args.outDir, "requests.jsonl"))
				seen.artifactAt = Date.now()
				appendFileSync(trace, ev(1, "artifact.ready", { kind: "board", revision: 1 }))
			}, artifactMs)
			setTimeout(() => {
				appendFileSync(trace, ev(2, "design.settled", { revision: 2, settled: true }))
				resolve({ code: 0, stderr: "" })
			}, exitMs)
		})
		return { done, kill: () => {} }
	}
	return { launch, seen }
}

const quiet: Pick<DemoDeps, "log" | "openUrl"> = { log: () => {}, openUrl: () => {} }

test("the change request is appended only after the first artifact.ready", { timeout: 10_000 }, async () => {
	const stub = stubLaunch(400, 1200)
	const outRoot = mkdtempSync(join(tmpdir(), "bringup-demo-"))
	const r = await runDemo({ ...parseDemoArgs(["--after", "0", "--port", "0", "--no-open"]) }, { launch: stub.launch, outRoot, ...quiet })
	try {
		assert.equal(r.code, 0)
		assert.equal(stub.seen.requestsBeforeArtifact, false)
		const lines = readFileSync(join(r.outDir, "requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
		assert.equal(lines.length, 1)
		assert.equal(lines[0].text, "make the board 60 mm wide")
		assert.ok(Date.parse(lines[0].at) >= stub.seen.artifactAt - 5, "request came before the artifact")
		assert.deepEqual(stub.seen.args, { briefPath: join(r.outDir, "brief.md"), mock: true, outDir: r.outDir })
		assert.match(r.summary[0], /yes/)
	} finally {
		await r.dashboard.close()
	}
})

test("--after wins when it comes later than the first artifact", { timeout: 10_000 }, async () => {
	const stub = stubLaunch(50, 1500)
	const outRoot = mkdtempSync(join(tmpdir(), "bringup-demo-"))
	const started = Date.now()
	const r = await runDemo(parseDemoArgs(["--after", "0.8", "--port", "0", "--no-open"]), { launch: stub.launch, outRoot, ...quiet })
	try {
		const [line] = readFileSync(join(r.outDir, "requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
		assert.ok(Date.parse(line.at) - started >= 800, `request after ${Date.parse(line.at) - started} ms`)
	} finally {
		await r.dashboard.close()
	}
})

test("a run that ends before the trigger gets no request and doesn't hang", { timeout: 10_000 }, async () => {
	const stub = stubLaunch(5000, 200)
	const outRoot = mkdtempSync(join(tmpdir(), "bringup-demo-"))
	const r = await runDemo(parseDemoArgs(["--after", "0", "--port", "0", "--no-open"]), { launch: stub.launch, outRoot, ...quiet })
	try {
		assert.equal(existsSync(join(r.outDir, "requests.jsonl")), false)
	} finally {
		await r.dashboard.close()
	}
})

test("the dashboard serves the run and shows engineer requests", { timeout: 10_000 }, async () => {
	const stub = stubLaunch(100, 600)
	const outRoot = mkdtempSync(join(tmpdir(), "bringup-demo-"))
	const r = await runDemo(parseDemoArgs(["--after", "0", "--port", "0", "--no-open"]), { launch: stub.launch, outRoot, ...quiet })
	try {
		assert.match(r.outDir, /demo-[\w-]+$/)
		assert.equal(readFileSync(join(r.outDir, "brief.md"), "utf8"), readFileSync("briefs/logger.md", "utf8"))
		const page = await (await fetch(r.dashboard.url)).text()
		assert.match(page, /\/files\/requests\.jsonl/)
		const reqs = await fetch(`${r.dashboard.url}/files/requests.jsonl`)
		assert.equal(reqs.status, 200)
	} finally {
		await r.dashboard.close()
	}
})
