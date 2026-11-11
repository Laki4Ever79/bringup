// The simulator per chip (docs/mcu.md, Simulation): the profile names what models the chip, the machine what is here.
import { test } from "node:test"
import assert from "node:assert/strict"
import { profileById } from "../src/mcu/profile.ts"
import { simBackendFor } from "../src/mcu/sim.ts"
import { consoleLines, renodeScript } from "../src/tools/renode.ts"

const all = { qemu: "/q", wokwi: null, wokwiToken: false, renode: "/r" }

test("STM32 boots in Renode, the ESP32-C3 in QEMU, each only when installed", () => {
	assert.equal(simBackendFor(profileById("stm32g031k8t6"), all).backend, "renode")
	assert.equal(simBackendFor(profileById("esp32-c3-mini-1"), all).backend, "qemu")
	assert.equal(simBackendFor(null, all).backend, "qemu")
	const none = simBackendFor(profileById("stm32g031k8t6"), { ...all, renode: null })
	assert.equal(none.backend, null)
	assert.match(none.reason, /Renode is not installed/)
})

test("a chip no simulator models is a stated skip, not a failed boot", () => {
	const r = simBackendFor(profileById("stm32wb55cgu6"), all)
	assert.equal(r.backend, null)
	assert.match(r.reason, /no simulator for the STM32WB55CGU6: Renode 1\.17 models the STM32WBA52/)
	assert.equal(simBackendFor(profileById("rp2040"), all).backend, null)
})

test("the Renode script loads the chip's platform, the ELF, and joins link UARTs on one hub", () => {
	const p = profileById("stm32g031k8t6")!
	const one = renodeScript([{ name: "board", profile: p, elf: "/fw.elf" }], { runForS: 2 })
	assert.match(one, /machine LoadPlatformDescription @platforms\/cpus\/stm32g0\.repl/)
	assert.match(one, /sysbus LoadELF @\/fw\.elf/)
	assert.match(one, /showAnalyzer sysbus\.usart2 /)
	const two = renodeScript([{ name: "a", profile: p, elf: "/a.elf" }, { name: "b", profile: p, elf: "/b.elf" }], { runForS: 3, link: { uart: "usart1" } })
	assert.equal(two.match(/connector Connect sysbus\.usart1 link/g)?.length, 2)
	assert.match(two, /emulation CreateUARTHub "link"/)
})

test("console lines are read per machine from Renode's log", () => {
	const log = [
		"[22:50:07.9817] [WARNING] a/usart1: Unhandled write to offset 0x8.",
		"[22:50:07.99] [INFO] a/usart1: [host: 0.39s (+0.39s)|virt: 80.88µs (+80.88µs)] bringup rev 3",
		"[22:50:07.99] [INFO] b/usart1: [host: 0.39s (+0.39s)|virt: 80.88µs (+80.88µs)] bringup rev 4",
		"\x1b[92m[22:28:06.69] [INFO] usart1: [host: 0.39s|virt: 0.1ms] SENSOR FAIL\x1b[0m",
	].join("\n")
	assert.deepEqual(consoleLines(log, "usart1", "a"), ["bringup rev 3", "SENSOR FAIL"])
	assert.deepEqual(consoleLines(log, "usart1", "b"), ["bringup rev 4", "SENSOR FAIL"])
})
