// The simulated drive's encoder counts are the ones the firmware counts (19 Nov 2026: run 20b's S3 counts both channels,
// so its ROVER_ENC_COUNTS_PER_REV doubled, while the bridge still sent channel A's: its odometry read half the distance,
// a go-to for (550, 0) drove 1090 mm and a 90° turn read 44°).
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { chassisSpec } from "../src/tools/chassis.ts"
import { roverHeader } from "../src/mechanics/firmware.ts"
import { EUROBOT_BOARD } from "../src/inference/scripts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

const headerCpr = (s: ContractSnapshot) => Number(/#define ROVER_ENC_COUNTS_PER_REV ([\d.]+)f/.exec(roverHeader(s))![1])

test("quadrature (run 20b, the S3) and channel A (the scripted C3 Eurobot): the bridge counts what the firmware counts", () => {
	const s3 = JSON.parse(readFileSync(new URL("./fixtures/cc-eurobot-20b-final.json", import.meta.url), "utf8")) as ContractSnapshot
	const c3 = { revision: 1, versions: {}, values: structuredClone(EUROBOT_BOARD) } as unknown as ContractSnapshot
	assert.match(roverHeader(s3), /#define ROVER_ENC_QUADRATURE 1/)
	assert.doesNotMatch(roverHeader(c3), /ROVER_ENC_QUADRATURE/)
	// The header prints one decimal.
	for (const s of [s3, c3]) assert.ok(Math.abs((chassisSpec(s)!.motor as { encoderCountsPerRev?: number }).encoderCountsPerRev! - headerCpr(s)) < 0.05, `${(chassisSpec(s)!.motor as { encoderCountsPerRev?: number }).encoderCountsPerRev} vs ${headerCpr(s)}`)
})
