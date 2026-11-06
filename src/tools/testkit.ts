import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { mountingHoles, testPoints, antennaOverhang } from "../codegen/circuit.ts"
import type { TestkitArtifact } from "../contract/consistency.ts"
import { testPlan, testPlanMarkdown } from "../contract/testkit.ts"
import type { ContractSnapshot } from "../contract/types.ts"
import { buildTestFirmware } from "./firmware.ts"

const run = promisify(execFile)
const TIMEOUT_MS = 120_000

// Input for py/fixture.py: the outline, each test pad where the board generator puts it, and the mounting holes the
// board drills (the fixture's alignment pins go through them).
export function fixtureSpec(s: ContractSnapshot): object {
	const { outline } = s.values
	if (!outline) throw new Error("the fixture needs an outline in the contract")
	const probes = testPoints(s).placed.map(({ ref, net, xMm, yMm }) => ({ ref, net, xMm, yMm }))
	const holes = mountingHoles(s).map((h) => ({ ref: h.ref, xMm: +(h.x + outline.widthMm / 2).toFixed(3), yMm: +(h.y + outline.heightMm / 2).toFixed(3), diameterMm: h.diameterMm }))
	// The module's antenna hangs past one edge: the nest's wall gets a notch there, or the board wouldn't seat.
	const antenna = antennaOverhang(s)
	return { outline: { widthMm: outline.widthMm, heightMm: outline.heightMm, thicknessMm: outline.thicknessMm }, probes, holes, antenna }
}

// The production-test kit for one revision: test-plan.md/.json, the fixture (STEP + STL, its probe holes measured back)
// and the factory-test firmware, built side by side.
export async function buildTestkit(tools: { python?: string | null; pio?: string | null }, root: string, dir: string, s: ContractSnapshot, revision: number): Promise<TestkitArtifact> {
	await mkdir(dir, { recursive: true })
	const plan = testPlan(s)
	await writeFile(join(dir, "test-plan.json"), JSON.stringify(plan, null, 2))
	await writeFile(join(dir, "test-plan.md"), testPlanMarkdown(plan, s))
	const fixture = (async () => {
		if (!tools.python) return { issues: ["fixture not built: .venv python with build123d is not installed"] }
		await writeFile(join(dir, "fixture-spec.json"), JSON.stringify(fixtureSpec(s), null, 2))
		try {
			await run(tools.python, [join(root, "py/fixture.py"), join(dir, "fixture-spec.json"), dir], { timeout: TIMEOUT_MS })
		} catch (e) {
			const err = e as { stderr?: string; message: string }
			return { issues: [`fixture build failed: ${(err.stderr ?? err.message).trim().split("\n").slice(-5).join(" ")}`] }
		}
		const report = JSON.parse(await readFile(join(dir, "fixture.json"), "utf8")) as { issues: string[] }
		return { issues: report.issues }
	})()
	const firmware = tools.pio ? buildTestFirmware(tools.pio, root, join(dir, "firmware"), s) : Promise.resolve({ ok: false, log: "factory-test firmware not built: .venv PlatformIO is not installed", pins: {} })
	const [fx, fw] = await Promise.all([fixture, firmware])
	return {
		revision,
		dir,
		probes: plan.probes,
		planPath: join(dir, "test-plan.md"),
		fixtureStlPath: existsSync(join(dir, "fixture.stl")) ? join(dir, "fixture.stl") : null,
		fixtureStepPath: existsSync(join(dir, "fixture.step")) ? join(dir, "fixture.step") : null,
		firmware: fw,
		fixtureIssues: fx.issues,
	}
}
