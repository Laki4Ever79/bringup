import { test } from "node:test"
import assert from "node:assert/strict"
import { buildLog } from "../src/tools/firmware.ts"

// With NimBLE in the build, hundreds of library compile lines follow a compiler error; the tail alone lost it, and the
// agents read this log when a firmware build fails.
test("the build log keeps the compiler's error lines even when they scrolled out of the tail", () => {
	const output = [
		"Compiling .pio/build/esp32c3/src/main.cpp.o",
		"include/pins.h:9:1: error: static assertion failed: PIN_STATUS_LED is not a GPIO on this chip",
		...Array.from({ length: 300 }, (_, i) => `Compiling .pio/build/esp32c3/lib394/NimBLE-Arduino/f${i}.c.o`),
		"*** [.pio/build/esp32c3/src/main.cpp.o] Error 1",
	].join("\n")
	const log = buildLog(output)
	assert.match(log, /PIN_STATUS_LED is not a GPIO on this chip/)
	assert.match(log, /\[\.pio\/build\/esp32c3\/src\/main\.cpp\.o\] Error 1$/, "the tail is still there")
	assert.ok(log.split("\n").length <= 90, "still bounded")
})

test("a clean build's log is just its tail", () => {
	const output = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")
	assert.equal(buildLog(output), Array.from({ length: 60 }, (_, i) => `line ${i + 40}`).join("\n"))
})
