// The arm's printed parts as the engine sees them (src/tools/arm.ts): the poses it sweeps, its violations, its links.
import { test } from "node:test"
import assert from "node:assert/strict"
import { armBuildChecks, armPoses, armWithLinks, type ArmArtifact } from "../src/tools/arm.ts"
import { forward } from "../src/arm/kinematics.ts"
import { ARM, TARGETS } from "./arm-contract.test.ts"
import { assemblyOrder } from "../src/package/build.ts"
import { fixtureContract } from "./fixture.ts"

const artifact = (over: Partial<ArmArtifact["built"]> = {}): ArmArtifact => ({ ok: true, dir: "/x", files: [], links: [], built: { poses: 182, pairs: 1820, clashes: [], print: { ok: true, issues: [], notes: [], bedMm: [256, 256, 256] }, ...over } })

test("armPoses: the pick and the drop and 40 mm above each, as the firmware drives them", () => {
	const q = armPoses({ arm: ARM, armTargets: TARGETS })
	assert.equal(q.length, 4)
	const tips = q.map((p) => forward(ARM, p).tip)
	assert.ok(Math.abs(tips[0].zMm - TARGETS.pick.zMm) < 0.5 && Math.abs(tips[1].zMm - TARGETS.pick.zMm - 40) < 0.5, JSON.stringify(tips))
	assert.ok(Math.abs(tips[2].xMm - TARGETS.drop.xMm) < 0.5)
	assert.deepEqual(armPoses({ arm: ARM }), [])
})

test("armBuildChecks: one arm-interference per clashing pair, its worst pose; print issues become arm-dfm", () => {
	assert.deepEqual(armBuildChecks(artifact()), [])
	const v = armBuildChecks(artifact({
		clashes: [
			{ pose: [0, 0, -120, 0, 0], a: "base", b: "forearm", mm3: 800.4 },
			{ pose: [0, 10, -110, 0, 0], a: "base", b: "forearm", mm3: 120 },
			{ pose: [0, 60, 0, -120, 0], a: "upper arm", b: "gripper", mm3: null },
		],
		print: { ok: false, issues: ["upper arm bracket is 300 mm long, more than the 256 mm bed"], notes: [], bedMm: [256, 256, 256] },
	}))
	assert.deepEqual(v.map((x) => x.kind), ["arm-interference", "arm-interference", "arm-dfm"])
	assert.match(v[0].message, /base hits its forearm at .*\(0, 0, -120, 0, 0\)°: 800\.4 mm³ in common, and at 1 more of the 182 swept poses/)
	assert.match(v[1].message, /failed boolean/)
	assert.match(v[2].message, /256 mm bed/)
	assert.ok(v.every((x) => x.fields[0] === "arm" && x.affects[0] === "mechanics"))
})

test("armWithLinks: writes the measured links once, null when they're already there", () => {
	const links = [{ name: "shoulder" as const, massG: 31.2, comMm: [60, 0, 0] as [number, number, number] }]
	const next = armWithLinks(ARM, links)
	assert.deepEqual(next?.links, links)
	assert.equal(armWithLinks(next!, links), null)
})

test("the package's assembly order builds an arm from the plate up, its servos' channels named", () => {
	const base = fixtureContract()
	const s = { ...base, values: { ...base.values, mechanics: undefined, arm: ARM, armTargets: TARGETS } }
	const md = assemblyOrder(s, ["base-plate.stl", "turntable.stl", "gripper.stl"])
	assert.match(md, /Print the arm's parts in printed\/ \(base-plate\.stl, turntable\.stl, gripper\.stl\)/)
	assert.match(md, /base yaw servo \(MG996R\) in the base plate's cradle/)
	assert.match(md, /add the 300 g ballast/)
	assert.match(md, /base-yaw 0, shoulder 1, elbow 2, wrist-pitch 3, wrist-roll 4, gripper 5/)
})
