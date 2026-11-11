// "Added for you": the phone-use line qualifies the battery-life figure, so it appears only when there is one (the
// rover's report said "Battery estimate assumes 1 phone connection a day" next to "Estimated battery life: unknown").
import { test } from "node:test"
import assert from "node:assert/strict"
import { addedForYou } from "../src/contract/added.ts"
import { estimatePower } from "../src/contract/power.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { fixtureContract } from "./fixture.ts"

function logger(batteryMah?: number) {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	s.values.requirements = { ...s.values.requirements!, batteryMah }
	return s
}

test("the phone-use assumption is listed only beside a battery-life figure", () => {
	const none = logger(undefined)
	assert.equal(estimatePower(none, "").days, null, "the fixture has no battery capacity")
	assert.ok(!addedForYou(none).some((i) => i.id === "phone-use"))
	const some = logger(500)
	assert.notEqual(estimatePower(some, "").days, null)
	assert.ok(addedForYou(some).some((i) => i.id === "phone-use"))
	// A capacity only the brief states counts too, when the brief is given.
	assert.ok(addedForYou(none, "A 500 mAh LiPo cell.").some((i) => i.id === "phone-use") === (estimatePower(none, "A 500 mAh LiPo cell.").days !== null))
})
