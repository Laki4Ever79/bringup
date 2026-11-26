// The arm's ROS 2 description (src/ros/urdf.ts armUrdf, armControllersYaml).
import { test } from "node:test"
import assert from "node:assert/strict"
import { armControllersYaml, armUrdf, ARM_FINGER_JOINT } from "../src/ros/urdf.ts"
import { forward } from "../src/arm/kinematics.ts"
import { defaultCheckCatalog } from "../src/mechanics/checks.ts"
import { ARM } from "./arm-contract.test.ts"

const cat = defaultCheckCatalog()!.mech
type V = [number, number, number]
type M = [V, V, V]
const mul = (a: M, b: M): M => a.map((r) => [0, 1, 2].map((c) => r[0] * b[0][c] + r[1] * b[1][c] + r[2] * b[2][c])) as M
const app = (a: M, v: V): V => a.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]) as V
// Rotation by angle t about a unit axis (Rodrigues).
const rot = ([x, y, z]: V, t: number): M => {
	const c = Math.cos(t), s = Math.sin(t), k = 1 - c
	return [[c + x * x * k, x * y * k - z * s, x * z * k + y * s], [y * x * k + z * s, c + y * y * k, y * z * k - x * s], [z * x * k - y * s, z * y * k + x * s, c + z * z * k]]
}
const nums = (s: string) => s.trim().split(/\s+/).map(Number) as V

// Walk the URDF's revolute chain from base_link to grip_link at the given angles (degrees, contract order).
function urdfTip(urdf: string, deg: number[]): V {
	const joints = [...urdf.matchAll(/<joint name="([^"]+)" type="(revolute|fixed)">[\s\S]*?<parent link="([^"]+)"\/>[\s\S]*?<child link="([^"]+)"\/>[\s\S]*?<origin xyz="([^"]+)"[^>]*\/>(?:[\s\S]*?<axis xyz="([^"]+)"\/>)?/g)]
	let R: M = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], p: V = [0, 0, 0], link = "base_link", k = 0
	while (link !== "grip_link") {
		const j = joints.find((x) => x[3] === link)
		assert.ok(j, `no joint from ${link}`)
		const o = app(R, nums(j[5]))
		p = [p[0] + o[0], p[1] + o[1], p[2] + o[2]]
		if (j[2] === "revolute") R = mul(R, rot(nums(j[6]), (deg[k++] * Math.PI) / 180))
		link = j[4]
	}
	return p.map((v) => v * 1000) as V
}

test("armUrdf: the chain puts the grip point where the kinematics do, at any pose", () => {
	const urdf = armUrdf(ARM, cat)
	for (const q of [[0, 0, 0, 0, 0], [30, 45, -60, -30, 20], [-50, 100, -80, 40, -90]]) {
		const t = forward(ARM, q).tip
		const u = urdfTip(urdf, q)
		assert.ok(Math.hypot(u[0] - t.xMm, u[1] - t.yMm, u[2] - t.zMm) < 0.01, JSON.stringify({ q, u, t }))
	}
})

test("armUrdf: limits from the contract, effort half the stall at the rail, the fingers mimic", () => {
	const urdf = armUrdf(ARM, cat)
	const shoulder = /<joint name="shoulder" type="revolute">[\s\S]*?<limit ([^/]+)\/>/.exec(urdf)![1]
	assert.match(shoulder, /lower="0" upper="2.094395" effort="0.53935" velocity="7.479983"/)
	assert.match(urdf, /<joint name="gripper_right_finger_joint" type="prismatic">[\s\S]*?<mimic joint="gripper_left_finger_joint"/)
	assert.equal((urdf.match(/<command_interface name="position"\/>/g) ?? []).length, 6)
	assert.match(urdf, /ESTIMATES \(armLinkG/)
	assert.match(armUrdf({ ...ARM, links: [{ name: "shoulder", massG: 30, comMm: [60, 0, 0] }] }, cat), /measured masses/)
})

test("armControllersYaml: a trajectory controller over the five joints and the gripper action", () => {
	const y = armControllersYaml(ARM, cat)
	assert.match(y, /joints: \["base_yaw", "shoulder", "elbow", "wrist_pitch", "wrist_roll"\]/)
	assert.match(y, /joint_trajectory_controller\/JointTrajectoryController/)
	assert.match(y, new RegExp(`joint: ${ARM_FINGER_JOINT}`))
})
