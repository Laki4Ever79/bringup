// A failed build's record keeps the compiler's error lines (src/tools/exec.ts failureExcerpt): the ESP32-S3 product
// firmware's real failure (an arm mock with hardware, 26 Nov 2026), whose last 40 lines showed only a NimBLE warning.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { failureExcerpt, tail } from "../src/tools/exec.ts"

const log = readFileSync(join(import.meta.dirname, "data/s3-deep-sleep-build.log"), "utf8")

test("a failed build's excerpt leads with its error lines, then the tail, in the same budget", () => {
	const cause = /'ESP_GPIO_WAKEUP_GPIO_LOW' was not declared in this scope/
	assert.doesNotMatch(tail(log, 40), cause, "the bare tail lost the cause (the run that read as a NimBLE problem)")
	const x = failureExcerpt(log, 40)
	assert.match(x.split("\n")[0], cause, "the first error comes first")
	assert.equal(x.split("\n").filter((l) => /error:/.test(l)).length, 5, "every compiler error line, once")
	assert.ok(x.split("\n").length <= 40)
	assert.match(x, /\*\*\* \[\.pio\/build\/esp32s3\/src\/main\.cpp\.o\] Error 1/, "and the tail still ends it")
	// A short log, or one with no error lines, is the plain tail.
	assert.equal(failureExcerpt("a\nb", 40), "a\nb")
	const noErrors = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n")
	assert.equal(failureExcerpt(noErrors, 40), tail(noErrors, 40))
})
