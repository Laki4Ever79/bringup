import type { ContractSnapshot } from "../contract/types.ts"
import type { DriveArtifact } from "../tools/drive.ts"
import { defaultCheckCatalog, mechanicsFigures, SERVO_SUPPLY_EFF } from "./checks.ts"
import { ESTIMATES, est, estNote } from "./estimates.ts"
import { ARM_APPROACH_MM, armChecks, worstTorques } from "../arm/checks.ts"
import { armReachMm } from "../arm/kinematics.ts"
import { ARM_LOGIC_W, armPowerChecks, armRails, SUPPLY_HEADROOM } from "../contract/power-auto.ts"

// The report's Mechanics section (a robot only): the brief's targets against the computed values, from the same code
// as the checks; the estimates no datasheet gives; and whether the simulated drive proved it.
export function mechanicsSection(s: ContractSnapshot, drive: DriveArtifact | undefined): string[] {
	if (!s.values.motion) return []
	const figures = mechanicsFigures(s)
	const lines = ["## Mechanics", ""]
	if (figures.length === 0) lines.push("No complete mechanics design yet: nothing to compute.", "")
	else {
		// Each datasheet page once, numbered; a figure lists the numbers of the pages its values came from.
		const refs: { key: string; mpn: string; url: string; where: string; fields: Set<string> }[] = []
		const refOf = (x: { mpn: string; field: string; url: string; where: string }) => {
			const key = `${x.mpn}\u0000${x.url}\u0000${x.where}`
			let r = refs.find((y) => y.key === key)
			if (!r) refs.push((r = { key, mpn: x.mpn, url: x.url, where: x.where, fields: new Set() }))
			r.fields.add(x.field)
			return refs.indexOf(r) + 1
		}
		const cites = (f: (typeof figures)[number]) => [...new Set((f.sources ?? []).map(refOf))].map((n) => `[${n}]`).join(" ")
		lines.push(
			"| Check | Computed | Limit | | How | Sources |",
			"|---|---|---|---|---|---|",
			...figures.map((f) => `| ${f.check} | ${f.value} | ${f.limit} | ${f.ok ? "ok" : "**FAILS**"} | ${f.note ?? ""} | ${cites(f)} |`),
			"",
			"Datasheet sources:",
			...refs.map((r, i) => `${i + 1}. ${r.mpn}: ${[...r.fields].join(", ")} (${r.where}) ${r.url}`),
			"",
			`Estimates (no datasheet states these; the bench test measures the motor's): ${Object.entries(ESTIMATES).map(([k, e]) => `${k} ${e.value}`).join(", ")}.`,
			"",
		)
		// A competition's rules the model can't see yet: listed, never counted as passed.
		const rules = s.values.motion.rules ? defaultCheckCatalog()?.rules?.[s.values.motion.rules] : undefined
		if (rules?.notChecked.length) lines.push(`Not checked against ${rules.document.title} (the design doesn't model them yet):`, ...rules.notChecked.map((n) => `- ${n.rule}: ${n.why}`), "")
	}
	if (!drive || drive.result === "not run")
		lines.push(`Simulated drive: not proven in simulation${drive ? ` (${drive.reason})` : ""}.`, "")
	else
		lines.push(
			`Simulated drive: ${drive.result} (the rover's own firmware in QEMU driving the MuJoCo model, revision ${drive.revision}): ${drive.reason}.`,
			...drive.segments.map((g) => `- ${g.name}: ${g.pass ? "pass" : "FAIL"} (${g.detail})`),
			...(drive.peakA !== undefined ? [`- Peak motor current ${drive.peakA} A, top speed ${drive.topSpeedMps} m/s, closest to a wall ${drive.closestWallMm} mm; trajectory in ${drive.dir}/trajectory.json`] : []),
			"",
		)
	return lines
}

// The report's Arm section (a robot arm only): the arm's figures from the same code as its checks: each joint's
// worst-pose torque against what its servo may carry, the reach and the pick and drop points, tipping, and the servo
// rails and brick (src/arm/checks.ts, src/contract/power-auto.ts).
export function armSection(s: ContractSnapshot): string[] {
	const arm = s.values.arm, t = s.values.armTargets
	if (!t && !arm) return []
	const lines = ["## Arm", ""]
	if (!arm || !t) return [...lines, "No arm design yet: nothing to compute.", ""]
	const cat = defaultCheckCatalog()
	if (!cat) return [...lines, "No mechanics catalog on this machine: nothing to compute.", ""]
	const f2 = (n: number) => (Math.round(n * 100) / 100).toString()
	const violations = armChecks(s.values, cat)
	const power = armPowerChecks(s)
	const rows: string[] = []
	const row = (check: string, value: string, limit: string, ok: boolean, how = "") => rows.push(`| ${check} | ${value} | ${limit} | ${ok ? "ok" : "**FAILS**"} | ${how} |`)
	for (const w of worstTorques(arm, t, cat.mech)) {
		if (w.nm === 0) continue
		const servo = arm.joints.find((j) => j.name === w.joint)!.servo
		row(`Torque, ${w.joint}`, `${f2(w.nm)} N·m`, `${f2(w.allowNm)} N·m (${servo})`, w.nm <= w.allowNm + 1e-9, `stretched level at full reach with ${t.payloadG} g; ${est("ARM_TORQUE_SHARE") * 100}% of stall at ${arm.railV} V ${estNote("ARM_TORQUE_SHARE")}`)
	}
	const reach = armReachMm(arm)
	row("Reach", `${f2(reach)} mm`, `${t.reachMm} mm (brief)`, reach + 0.5 >= t.reachMm, "the links from the shoulder axis to the grip point")
	for (const [name, p] of [["Pick", t.pick], ["Drop", t.drop]] as const) {
		const at = `(${p.xMm}, ${p.yMm}, ${p.zMm}) mm`
		const bad = violations.find((v) => v.kind === "arm-reach" && v.message.startsWith(`the ${name.toLowerCase()} point`))
		row(`${name} point`, at, `solves with the gripper down, also ${ARM_APPROACH_MM} mm above`, !bad, bad?.message ?? "")
	}
	row("Pick to drop", `${f2(Math.hypot(t.drop.xMm - t.pick.xMm, t.drop.yMm - t.pick.yMm))} mm on the table`, "the brief's distance", true, `${t.repeats} times in a row with the ${t.objectG} g object`)
	const tip = violations.find((v) => v.kind === "arm-tipping")
	row("Tipping", arm.base.holdDown === "clamps" ? "clamped to the desk" : `${arm.base.plateMm.join(" × ")} mm plate, ${arm.base.ballastG} g ballast`, "centre of mass inside the plate with the payload at full reach", !tip, tip?.message ?? "")
	const rails = armRails(s) ?? []
	for (const r of rails) {
		const chip = (s.values.parts ?? []).find((p) => p.ref === r.supplyRef)
		const maxA = (cat.boardParts.find((e) => e.mpn === chip?.mpn) as { maxA?: number } | undefined)?.maxA
		row(`Rail ${r.net}`, `${f2(r.needA)} A at stall (${r.plugs.map((p) => `${p.ref} ${p.joint}`).join(", ")}), ×${SUPPLY_HEADROOM} = ${f2(r.headroomA)} A`, chip ? `${maxA ?? "?"} A (${chip.ref} ${chip.mpn}, ${r.divider.r1}/${r.divider.r2} → ${r.divider.voutV} V)` : "no chip yet", Boolean(chip) && (maxA === undefined || r.headroomA <= maxA + 1e-9))
	}
	const watts = (rails.reduce((a, r) => a + r.railV * r.needA, 0) / SERVO_SUPPLY_EFF + ARM_LOGIC_W) * SUPPLY_HEADROOM
	const brickBad = power.find((v) => /brick is rated/.test(v.message))
	row("Brick", `${f2(watts)} W needed (${f2(watts / arm.input.volts)} A at ${arm.input.volts} V)`, `${f2(arm.input.volts * arm.input.amps)} W (${arm.input.amps} A)`, !brickBad, `the servos at stall through the rails (${SERVO_SUPPLY_EFF * 100} %) plus the logic (${ARM_LOGIC_W} W, an estimate), ×${SUPPLY_HEADROOM}`)
	const other = power.filter((v) => v !== brickBad)
	return [
		...lines,
		`Servos: ${arm.joints.map((j) => `${j.name} ${j.servo} (ch ${j.channel})`).join(", ")}, gripper ${arm.gripper.servo} (ch ${arm.gripper.channel}), on a ${arm.railV} V rail from a ${arm.input.volts} V brick.`,
		"",
		"| Check | Computed | Limit | | How |",
		"|---|---|---|---|---|",
		...rows,
		"",
		...(other.length ? ["Supply findings:", ...other.map((v) => `- ${v.message}`), ""] : []),
		`Estimates (no datasheet states these): ${(["armLinkG", "armGripperG", "ARM_TORQUE_SHARE", "plaDensityGcm3"] as const).map((k) => `${k} ${est(k)}`).join(", ")}${arm.links ? "" : "; the link masses are estimated until the arm geometry tool weighs them"}.`,
		"",
	]
}
