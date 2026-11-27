// Espressif's QEMU fork, per chip: the ESP32-C3 runs in qemu-system-riscv32 (machine esp32c3), the ESP32 and ESP32-S3
// in qemu-system-xtensa (machines esp32, esp32s3), both from the same release (esp_develop_9.2.2_20260417, setup.ts).
// The machine comes from the MCU profile's sim.machine; a design from before profiles is the C3's. Every caller (the
// drive simulation, the boot check, the linked pair, the ROS acceptance's qemu back end) builds its command from here,
// so no tool is hard-wired to one chip (lead, 18 Nov 2026, after the user approved the Xtensa QEMU).
import { toolAt } from "./env.ts"

export type QemuMachine = "esp32c3" | "esp32s3" | "esp32"

export interface QemuTarget {
	machine: QemuMachine
	bin: string // the binary, relative to the repo root or the tools home (~/.bringup, `npx bringup-mcp setup sim`)
	chip: string // esptool's --chip
	simEnv: string // the rover firmware's simulation build (templates/fw-rover/platformio.ini)
	flash: string // the flash image's size: the board's own (PlatformIO writes it into the image header, and the
	// firmware asserts at boot when QEMU's flash is smaller: the S3 sim's first boot, 19 Nov 2026, "Detected size(4096k)
	// smaller than the size in the binary image header(8192k)")
}

// Windows' builds are .exe (Espressif's x86_64-w64-mingw32 release).
const EXE = process.platform === "win32" ? ".exe" : ""
export const QEMU_BINS = { riscv32: `tools/qemu/bin/qemu-system-riscv32${EXE}`, xtensa: `tools/qemu/bin/qemu-system-xtensa${EXE}` } as const
const TARGETS: Record<QemuMachine, QemuTarget> = {
	esp32c3: { machine: "esp32c3", bin: QEMU_BINS.riscv32, chip: "esp32c3", simEnv: "esp32c3_sim", flash: "4MB" },
	esp32s3: { machine: "esp32s3", bin: QEMU_BINS.xtensa, chip: "esp32s3", simEnv: "esp32s3_sim", flash: "8MB" },
	esp32: { machine: "esp32", bin: QEMU_BINS.xtensa, chip: "esp32", simEnv: "esp32_sim", flash: "4MB" },
}

export const QEMU_MACHINES = Object.keys(TARGETS) as QemuMachine[]

// The target for a profile's sim.machine (null: a machine this QEMU has no model of).
export function qemuTarget(machine: string | null | undefined = "esp32c3"): QemuTarget | null {
	return TARGETS[(machine ?? "esp32c3") as QemuMachine] ?? null
}

// The binary's absolute path when it is installed (the checkout's tools/, else the tools home's), else null.
export function qemuBinary(root: string, t: QemuTarget): string | null {
	return toolAt(root, t.bin)
}

// The arguments every run shares: the machine, virtual time (-icount 3: don't read timings from it), the flash image,
// and the watchdog off (a lock-step bridge holds the firmware between steps).
export function qemuBaseArgs(t: QemuTarget, image: string): string[] {
	return ["-machine", t.machine, "-icount", "3", "-drive", `file=${image},if=mtd,format=raw`, "-global", `driver=timer.${t.machine}.timg,property=wdt_disable,value=true`]
}
