// Which router a board build tries first (src/tools/board.ts routerOrder): tscircuit's own, or Freerouting
// (BRINGUP_ROUTER=freerouting-first), measured on 12 representative boards (17 Nov 2026).
import { test } from "node:test"
import assert from "node:assert/strict"
import { routerOrder } from "../src/tools/board.ts"

test("the router order follows BRINGUP_ROUTER", () => {
	const was = process.env.BRINGUP_ROUTER
	try {
		delete process.env.BRINGUP_ROUTER
		assert.equal(routerOrder(), "tscircuit-first")
		process.env.BRINGUP_ROUTER = "freerouting-first"
		assert.equal(routerOrder(), "freerouting-first")
		process.env.BRINGUP_ROUTER = "nonsense"
		assert.equal(routerOrder(), "tscircuit-first")
	} finally {
		if (was === undefined) delete process.env.BRINGUP_ROUTER
		else process.env.BRINGUP_ROUTER = was
	}
})
